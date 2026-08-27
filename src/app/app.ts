import { stdout as defaultStdout } from 'node:process';
import { randomUUID } from 'node:crypto';
import { AgentRunner } from '../agent/runner.js';
import { buildSystemPrompt } from '../agent/system-prompt.js';
import { HookRegistry } from '../agent/hooks.js';
import { createModelClient } from '../model/create-client.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { createFileTools } from '../tools/file-tools.js';
import { createShellTool } from '../tools/shell-tool.js';
import { createGitTools } from '../tools/git-tools.js';
import { parseArgs } from './cli-args.js';
import { renderHelp, renderRunResult, renderStreamEvent, renderVersion } from './renderer.js';
import { runTui } from './tui.js';
import { loadConfig } from '../shared/config.js';
import { redact } from '../shared/redact.js';
import { JsonlSessionStore } from '../session/jsonl-store.js';
import { createMessageEntry, createRunEndEntry, createRunStartEntry, createSummaryEntry, createThinkingLevelChangeEntry } from '../session/entries.js';
import { loadProjectInstructions } from '../context/instructions.js';
import { expandPromptAttachments } from '../context/attachments.js';
import { SkillRegistry } from '../context/skills.js';
import { createTodoTools } from '../plan/todo-tools.js';
import { TelemetryStore } from '../telemetry/store.js';
import { createRunReport, writeRunReport } from '../telemetry/report.js';
import { McpManager } from '../mcp/client.js';
import { createStdioTransport } from '../mcp/stdio.js';
import { registerMcpTools } from '../mcp/registry-adapter.js';
import type { AgentMessage, AgentRunResult, AgentStreamEvent } from '../agent/types.js';
import type { ThinkingLevel } from '../model/model-client.js';
import { clampThinkingLevel } from '../model/thinking.js';
import type { AgentConfig } from '../shared/config.js';
import type { MessageEntry } from '../session/session-types.js';

export interface AppServices {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

export interface AppResult { exitCode: number; stdout?: string; stderr?: string; sessionId?: string; }

export function createApp(services: AppServices) {
  return {
    async run(): Promise<AppResult> {
      const args = parseArgs(services.argv);
      if (args.help) return { exitCode: 0, stdout: renderHelp() };
      if (args.version) return { exitCode: 0, stdout: renderVersion() };
      const config = loadConfig({ env: services.env, args, cwd: services.cwd });
      if (args.mode === 'rpc') return { exitCode: 1, stderr: 'RPC mode is planned but not implemented yet.\n' };
      if (!config.model.apiKey) return missingAuth(args.mode);
      if (!args.prompt) {
        if (!isInteractiveTty(services)) return { exitCode: 1, stderr: 'Interactive TUI requires a TTY. Pass a prompt or use --print/--mode json for non-interactive runs.\n' };
        return runTui({ config, services, runPrompt });
      }
      return runPrompt(config, args.prompt, undefined, args.mode, config.model.thinking, args.mode === 'text' ? (services.stdout ?? defaultStdout) : undefined);
    },
  };
}

export async function runPrompt(config: AgentConfig, prompt: string, sessionId?: string, mode: 'text' | 'json' = 'text', thinking = config.model.thinking, streamOutput?: NodeJS.WritableStream, showThinking = false, onAgentEvent?: (event: AgentStreamEvent) => void | Promise<void>, signal?: AbortSignal): Promise<AppResult> {
  if (!config.model.apiKey) return missingAuth(mode);
  const registry = new ToolRegistry();
  for (const tool of createFileTools()) registry.register(tool);
  registry.register(createShellTool());
  for (const tool of createGitTools()) registry.register(tool);
  for (const tool of createTodoTools(`${config.workspaceRoot}/.nju-agent/todo.json`)) registry.register(tool);
  const mcp = new McpManager();
  try {
    for (const server of config.mcpServers) {
      await mcp.connect(server.name, createStdioTransport({ command: server.command, args: server.args, cwd: server.cwd, env: server.env }));
    }
    registerMcpTools(mcp, registry);
  } catch (error) {
    await mcp.disconnectAll();
    throw error;
  }
  const sessionStore = config.session.enabled ? new JsonlSessionStore(`${config.workspaceRoot}/.nju-agent`) : undefined;
  const telemetry = new TelemetryStore(`${config.workspaceRoot}/.nju-agent/logs/events.jsonl`, config.telemetry, config.model.apiKey ? [config.model.apiKey] : []);
  const runId = randomUUID();
  const hooks = new HookRegistry();
  hooks.register({
    beforeModelRequest: async ({ turn }) => { await telemetry.append({ type: 'model_request_start', runId, data: { turn } }); },
    beforeTool: async ({ turn, toolCall }) => { await telemetry.append({ type: 'tool_call_start', runId, data: { turn, toolName: toolCall?.name } }); },
    afterTool: async ({ turn, toolResult }) => { await telemetry.append({ type: 'tool_result', runId, data: { turn, toolName: toolResult?.toolName, ok: toolResult?.ok, elapsedMs: toolResult?.elapsedMs, truncated: toolResult?.truncated } }); },
    afterTurn: async ({ turn }) => { await telemetry.append({ type: 'turn_end', runId, data: { turn } }); },
    onStop: async ({ result }) => { await telemetry.append({ type: 'runner_stop', runId, data: { stopReason: result.stopReason, turns: result.turns, toolCalls: result.toolCalls } }); },
  });
  const skillRegistry = new SkillRegistry();
  const trusted = config.trustOverride === true;
  const skills = skillRegistry.scan(config.workspaceRoot, trusted);
  if (trusted && skills.length > 0) registry.register(skillRegistry.createLoadTool());
  const instructions = loadProjectInstructions(config.workspaceRoot, trusted)
    .map((item) => `Source: ${item.path}\nTrust: ${item.trusted ? 'approved' : 'document-only'}\n${item.content}`)
    .join('\n\n');
  const session = sessionStore ? (sessionId || config.session.id

    ? await sessionStore.open(sessionId ?? config.session.id!)
    : await sessionStore.create({ cwd: config.workspaceRoot, model: config.model.model, appVersion: renderVersion().trim() })) : undefined;
  const expandedPrompt = await expandPromptAttachments(prompt, config.workspaceRoot);
  const effectivePrompt = expandedPrompt.prompt;
  await telemetry.append({ type: 'run_start', sessionId: session?.id, runId, data: { model: config.model.model, apiFormat: config.model.apiFormat, permissionMode: config.permissionMode } });
  const previousMessages: AgentMessage[] = session?.entries.filter((entry): entry is MessageEntry => entry.type === 'message').map((entry) => entry.message) ?? [];
  const savedThinking = [...(session?.entries ?? [])].reverse().find((entry) => entry.type === 'thinking_level_change');
  if (savedThinking) thinking = { ...thinking, level: clampThinkingLevel(savedThinking.thinkingLevel as ThinkingLevel, thinking.map) };
  if (session && sessionStore && !savedThinking) await sessionStore.append(session.id, createThinkingLevelChangeEntry(session.id, thinking.level));
  const userEntry = session ? createMessageEntry(session.id, { role: 'user', content: effectivePrompt }) : undefined;
  if (session && userEntry) {
    await sessionStore?.append(session.id, userEntry);
    await sessionStore?.append(session.id, createRunStartEntry(session.id, userEntry.id, { model: config.model.model, permissionMode: config.permissionMode }));
  }
  const runner = new AgentRunner({
    model: createModelClient({ apiFormat: config.model.apiFormat, apiKey: config.model.apiKey, baseUrl: config.model.baseUrl, model: config.model.model }),
    tools: new ToolExecutor(registry, { workspaceRoot: config.workspaceRoot, permissionMode: config.permissionMode }),
    systemPrompt: buildSystemPrompt(config.workspaceRoot, { instructions, skillCatalog: skillRegistry.catalog() }),
    toolDefinitions: registry.definitionsForModel(),
    hooks,
    onMessage: session && sessionStore ? async (message) => { await sessionStore.append(session.id, createMessageEntry(session.id, message)); } : undefined,
  });
  try {
    let streamedText = false;
    const result = await runner.run(effectivePrompt, { maxTurns: 8, maxToolCalls: 24, maxContextChars: 100_000, initialMessages: previousMessages, persistUserMessage: false, thinking,
      onStreamEvent: mode === 'text' && (streamOutput || onAgentEvent) ? async (event) => {
        await onAgentEvent?.(event);
        if (event.type === 'text_delta') streamedText = true;
        if (streamOutput) {
          if (event.type === 'text_delta') streamOutput.write(event.delta);
          else streamOutput.write(renderStreamEvent(event, showThinking));
        }
      } : undefined,
      onCompaction: session && sessionStore ? async (summary, omittedMessages) => {
        await sessionStore.append(session.id, createSummaryEntry(session.id, summary, [], 'threshold'));
        await telemetry.append({ type: 'compaction_end', sessionId: session.id, runId, data: { omittedMessages, summary } });
      } : undefined,
    }, signal);
    if (session && sessionStore) await sessionStore.append(session.id, createRunEndEntry(session.id, result));
    if (config.telemetry !== 'off') {
      const report = createRunReport(runId, prompt, result);
      const reportPath = await writeRunReport(`${config.workspaceRoot}/.nju-agent/logs`, report);
      await telemetry.append({ type: 'run_report', sessionId: session?.id, runId, data: { path: reportPath, stopReason: report.stopReason, toolCalls: report.toolCalls } });
    }
    await telemetry.append({ type: 'run_end', sessionId: session?.id, runId, data: { stopReason: result.stopReason, turns: result.turns, toolCalls: result.toolCalls } });
    const rendered = mode === 'json'
      ? `${JSON.stringify({ type: 'run_end', level: 'info', data: result })}\n`
      : renderRunResult(result, !streamedText);
    await mcp.disconnectAll();
    return { exitCode: 0, stdout: streamedText && rendered ? `\n${rendered}` : rendered, sessionId: session?.id };
  } catch (error) {
    await mcp.disconnectAll();
    const message = redact(error instanceof Error ? error.message : String(error), { extraSecrets: [config.model.apiKey] });
    await telemetry.append({ type: 'run_error', sessionId: session?.id, runId, data: { message } });
    return mode === 'json'
      ? { exitCode: 3, stdout: `${JSON.stringify({ type: 'run_error', level: 'error', data: { message } })}\n` }
      : { exitCode: 3, stderr: `${message}\n` };
  }
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value);
}

export function supportedEffortText(config: AgentConfig): string {
  return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter((level) => config.model.thinking.map?.[level as ThinkingLevel] !== null).join(', ');
}
function isInteractiveTty(services: AppServices): boolean {
  const stdin = services.stdin as NodeJS.ReadStream | undefined;
  const stdout = services.stdout as NodeJS.WriteStream | undefined;
  return stdin?.isTTY === true && stdout?.isTTY === true;
}

export function missingAuth(mode: 'text' | 'json'): AppResult {
  const message = 'Missing API key. Set NJU_AGENT_API_KEY, NJU_AGENT_BASE_URL, and NJU_AGENT_MODEL. See .env.example.';
  if (mode === 'json') return { exitCode: 3, stdout: `${JSON.stringify({ type: 'run_error', level: 'error', data: { code: 'missing_auth', message } })}\n` };
  return { exitCode: 3, stderr: `${message}\n` };
}
