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
import { createBackgroundTools, getBackgroundCommandManager } from '../tools/background-tools.js';
import { parseArgs } from './cli-args.js';
import { renderHelp, renderRunResult, renderStreamEvent, renderVersion } from './renderer.js';
import { runTui } from './tui.js';
import { loadConfig } from '../shared/config.js';
import { redact } from '../shared/redact.js';
import { JsonlSessionStore } from '../session/jsonl-store.js';
import { createApprovalEntry, createFileMutationEntry, createMessageEntry, createRunEndEntry, createRunStartEntry, createSummaryEntry, createThinkingLevelChangeEntry } from '../session/entries.js';
import { loadProjectInstructions } from '../context/instructions.js';
import { createNativeContribution, HarnessPluginHost, renderContributions } from '../context/harness.js';
import { MemoryPlugin } from '../context/memory.js';
import { DeterministicCompactPlugin } from '../context/compactor.js';
import { expandPromptAttachments } from '../context/attachments.js';
import { SkillRegistry } from '../context/skills.js';
import { createTodoTools } from '../plan/todo-tools.js';
import { TelemetryStore } from '../telemetry/store.js';
import { ChangeJournal } from '../telemetry/journal.js';
import { createProgressRunStatus, createRunReport, createRunStatus, createRunningRunStatus, writeRunReport, type RunStatus } from '../telemetry/report.js';
import { withRetryingModelClient } from '../model/retry.js';
import { McpManager } from '../mcp/client.js';
import { createStdioTransport } from '../mcp/stdio.js';
import { registerMcpTools } from '../mcp/registry-adapter.js';
import { loadUserPlugins, pluginTools } from '../plugins/loader.js';
import { resolveWorkspacePath } from '../tools/path-guard.js';
import { runRpc } from './rpc.js';
import type { AgentMessage, AgentRunControl, AgentRunProgress, AgentRunResult, AgentStreamEvent } from '../agent/types.js';
import type { ToolApprovalHandler, ToolDefinition } from '../tools/types.js';
import type { ThinkingLevel } from '../model/model-client.js';
import { clampThinkingLevel } from '../model/thinking.js';
import type { AgentConfig } from '../shared/config.js';
import type { MessageEntry, SessionEntry } from '../session/session-types.js';

export interface AppServices {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

export interface AppResult { exitCode: number; stdout?: string; stderr?: string; sessionId?: string; status?: RunStatus; }

function parseApprovalTimeout(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.NJU_AGENT_APPROVAL_TIMEOUT_MS;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 300_000) throw new Error(`Invalid NJU_AGENT_APPROVAL_TIMEOUT_MS: ${raw}. Expected an integer from 1 to 300000`);
  return value;
}

export function createApp(services: AppServices) {
  return {
    async run(): Promise<AppResult> {
      const args = parseArgs(services.argv);
      if (args.help) return { exitCode: 0, stdout: renderHelp() };
      if (args.version) return { exitCode: 0, stdout: renderVersion() };
      const config = loadConfig({ env: services.env, args, cwd: services.cwd });
      if (args.mode === 'rpc') return runRpc({ config, stdin: services.stdin ?? process.stdin, stdout: services.stdout ?? process.stdout, runPrompt, compactSession, approvalTimeoutMs: parseApprovalTimeout(services.env) });
      if (!config.model.apiKey) return missingAuth(args.mode);
      if (!args.prompt) {
        if (!isInteractiveTty(services)) return { exitCode: 1, stderr: 'Interactive TUI requires a TTY. Pass a prompt or use --print/--mode json for non-interactive runs.\n' };
        return runTui({ config, services, runPrompt, compactSession, memoryStatus });
      }
      return runPrompt(config, args.prompt, undefined, args.mode, config.model.thinking, args.mode === 'text' ? (services.stdout ?? defaultStdout) : undefined);
    },
  };
}

export async function runPrompt(config: AgentConfig, prompt: string, sessionId?: string, mode: 'text' | 'json' = 'text', thinking = config.model.thinking, streamOutput?: NodeJS.WritableStream, showThinking = false, onAgentEvent?: (event: AgentStreamEvent) => void | Promise<void>, signal?: AbortSignal, approveTool?: ToolApprovalHandler, reloadPlugins = false, control?: AgentRunControl, onRunProgress?: (status: RunStatus) => void | Promise<void>): Promise<AppResult> {
  if (!config.model.apiKey) return missingAuth(mode);
  const registry = new ToolRegistry();
  for (const tool of createFileTools()) registry.register(tool);
  registry.register(createShellTool());
  for (const tool of createGitTools()) registry.register(tool);
  for (const tool of createBackgroundTools(getBackgroundCommandManager(config.workspaceRoot))) registry.register(tool);
  for (const tool of createTodoTools(`${config.workspaceRoot}/.nju-agent/todo.json`)) registry.register(tool);
  const userPlugins = await loadUserPlugins(config.workspaceRoot, config.projectTrusted, reloadPlugins);
  for (const tool of pluginTools(userPlugins)) registry.register(tool);
  const sessionStore = config.session.enabled ? new JsonlSessionStore(`${config.workspaceRoot}/.nju-agent`) : undefined;
  const telemetry = new TelemetryStore(`${config.workspaceRoot}/.nju-agent/logs/events.jsonl`, config.telemetry, config.model.apiKey ? [config.model.apiKey] : []);
  const runId = randomUUID();
  const recordMcpEvent = (type: 'mcp_connect' | 'mcp_disconnect', data: Record<string, unknown>) => telemetry.append({ type, sessionId: sessionStore ? sessionId : undefined, runId, data });
  const mcp = new McpManager(config.mcpTimeoutMs);
  const mcpServers = config.projectTrusted ? config.mcpServers : [];
  try {
    for (const server of mcpServers) {
      const serverCwd = await resolveWorkspacePath(config.workspaceRoot, server.cwd ?? '.');
      await mcp.connect(server.name, createStdioTransport({ command: server.command, args: server.args, cwd: serverCwd.absolutePath, env: server.env }));
    }
    registerMcpTools(mcp, registry);
  } catch (error) {
    await telemetry.append({ type: 'mcp_error', runId, data: { message: redact(error instanceof Error ? error.message : String(error), { extraSecrets: Object.values(config.model).filter((value): value is string => typeof value === 'string') }) } });
    await mcp.disconnectAll();
    throw error;
  }
  if (config.mcpServers.length > 0 && !config.projectTrusted) await telemetry.append({ type: 'mcp_skipped_untrusted', runId, data: { serverCount: config.mcpServers.length } });
  for (const server of mcp.serversStatus()) await recordMcpEvent('mcp_connect', { server: server.name, toolCount: server.toolCount, pid: server.pid });
  const hooks = new HookRegistry();
  hooks.register({
    beforeModelRequest: async ({ turn }) => { await telemetry.append({ type: 'model_request_start', runId, data: { turn } }); },
    beforeTool: async ({ turn, toolCall }) => { await telemetry.append({ type: 'tool_call_start', runId, data: { turn, toolName: toolCall?.name } }); },
    afterTool: async ({ turn, toolResult }) => { await telemetry.append({ type: 'tool_result', runId, data: { turn, toolName: toolResult?.toolName, mcpServer: toolResult?.toolName ? mcpServerForTool(toolResult.toolName) : undefined, ok: toolResult?.ok, elapsedMs: toolResult?.elapsedMs, truncated: toolResult?.truncated, errorCode: toolResult?.error?.code, policy: toolResult?.policyDecision, approval: toolResult?.approval } }); },
    afterTurn: async ({ turn }) => { await telemetry.append({ type: 'turn_end', runId, data: { turn } }); },
    onStop: async ({ result }) => { await telemetry.append({ type: 'runner_stop', runId, data: { stopReason: result.stopReason, turns: result.turns, toolCalls: result.toolCalls } }); },
  });
  const skillRegistry = new SkillRegistry();
  const trusted = config.projectTrusted;
  const skills = skillRegistry.scan(config.workspaceRoot, trusted);
  if (trusted && skills.length > 0) registry.register(skillRegistry.createLoadTool());
  const memory = new MemoryPlugin({ workspaceRoot: config.workspaceRoot, rootDir: config.memory.rootDir, enabled: config.memory.enabled, allowWrite: /remember|do not forget|记住|不要忘记/i.test(prompt) });
  const compactor = new DeterministicCompactPlugin();
  const harness = new HarnessPluginHost([memory, compactor]);
  for (const tool of harness.toolDefinitions()) registry.register(tool);
  const instructionItems = loadProjectInstructions(config.workspaceRoot, trusted);
  const instructions = instructionItems
    .map((item) => `Source: ${item.path}\nTrust: ${item.trusted ? 'approved' : 'document-only'}\n${item.content}`)
    .join('\n\n');
  const session = sessionStore ? (sessionId || config.session.id

    ? await sessionStore.open(sessionId ?? config.session.id!)
    : await sessionStore.create({ cwd: config.workspaceRoot, model: config.model.model, appVersion: renderVersion().trim() })) : undefined;
  const expandedPrompt = await expandPromptAttachments(prompt, config.workspaceRoot);
  const effectivePrompt = expandedPrompt.prompt;
  await telemetry.append({ type: 'run_start', sessionId: session?.id, runId, data: { model: config.model.model, apiFormat: config.model.apiFormat, permissionMode: config.permissionMode } });
  const previousMessages = session ? sessionEntriesToContext(session.entries) : [];
  const savedThinking = [...(session?.entries ?? [])].reverse().find((entry) => entry.type === 'thinking_level_change');
  if (savedThinking) thinking = { ...thinking, level: clampThinkingLevel(savedThinking.thinkingLevel as ThinkingLevel, thinking.map) };
  if (session && sessionStore && !savedThinking) await sessionStore.append(session.id, createThinkingLevelChangeEntry(session.id, thinking.level));
  const userEntry = session ? createMessageEntry(session.id, { role: 'user', content: effectivePrompt }) : undefined;
  if (session && userEntry) {
    await sessionStore?.append(session.id, userEntry);
    await sessionStore?.append(session.id, createRunStartEntry(session.id, userEntry.id, { model: config.model.model, permissionMode: config.permissionMode }));
  }
  const nativeContributions = [
    instructions ? createNativeContribution('native:project-instructions', 'project', 'project_instruction', instructions, instructionItems.map((item) => item.path)) : undefined,
    skillRegistry.catalog() ? createNativeContribution('native:skill-catalog', 'project', 'skill_catalog', skillRegistry.catalog()) : undefined,
  ].filter((item): item is NonNullable<typeof item> => item !== undefined);
  const { contributions, diagnostics: contextDiagnostics } = await harness.contributions({ workspaceRoot: config.workspaceRoot, sessionId: session?.id, signal }, nativeContributions);
  for (const diagnostic of contextDiagnostics) await telemetry.append({ type: 'harness_error', sessionId: session?.id, runId, data: { ...diagnostic } });
  const runner = new AgentRunner({
    model: withRetryingModelClient(createModelClient({ apiFormat: config.model.apiFormat, apiKey: config.model.apiKey, baseUrl: config.model.baseUrl, model: config.model.model }), {
      onRetry: async (retry) => { await telemetry.append({ type: 'model_retry', sessionId: session?.id, runId, data: { ...retry } }); },
    }),
    tools: new ToolExecutor(registry, { workspaceRoot: config.workspaceRoot, permissionMode: config.permissionMode, previewLines: config.toolPreviewLines ?? 8, maxConcurrency: config.maxConcurrency, runId, approve: approveTool, onApproval: async (request, record) => { if (session && sessionStore) await sessionStore.append(session.id, createApprovalEntry(session.id, request, record)); await telemetry.append({ type: 'approval_result', sessionId: session?.id, runId, data: { requestId: request.requestId, toolCallId: request.toolCallId, toolName: request.toolName, risk: request.risk, workspacePath: request.workspacePath, outcome: record.outcome, reason: record.reason, scope: record.scope, elapsedMs: record.elapsedMs } }); }, onPolicyDecision: async (decision) => { await telemetry.append({ type: 'policy_decision', runId, data: { ...decision } }); }, onFileMutation: async (mutation) => {
      await new ChangeJournal(config.workspaceRoot, runId, session?.id, async (record) => {
        if (session && sessionStore) await sessionStore.append(session.id, createFileMutationEntry(session.id, record));
        await telemetry.append({ type: 'file_mutation', sessionId: session?.id, runId, data: { id: record.id, operation: record.operation, relativePath: record.relativePath, beforeHash: record.beforeHash, afterHash: record.afterHash, reversible: record.reversible, artifactPath: record.artifactPath, toolCallId: record.toolCallId, undoOf: record.undoOf } });
      }).record(mutation);
    } }),
    systemPrompt: buildSystemPrompt(config.workspaceRoot, { pluginContext: renderContributions(contributions) }),
    toolDefinitions: registry.definitionsForModel(),
    hooks,
    onMessage: session && sessionStore ? async (message) => {
      const entry = createMessageEntry(session.id, message);
      message.sessionEntryId = entry.id;
      await sessionStore.append(session.id, entry);
    } : undefined,
  });
  try {
    let streamedText = false;
    const result = await runner.run(effectivePrompt, { previewLines: config.toolPreviewLines ?? 8, maxContextChars: 100_000, maxDurationMs: config.maxDurationMs, maxConcurrency: config.maxConcurrency, compactor: compactor.compact.bind(compactor), initialMessages: previousMessages, persistUserMessage: false, userMessageEntryId: userEntry?.id, thinking, goalGate: true,
      control,
      onStreamEvent: mode === 'text' && (streamOutput || onAgentEvent) ? async (event) => {
        await onAgentEvent?.(event);
        if (event.type === 'text_delta') streamedText = true;
        if (streamOutput) {
          if (event.type === 'text_delta') streamOutput.write(event.delta);
          else streamOutput.write(renderStreamEvent(event, showThinking));
        }
      } : undefined,
      onCompaction: session && sessionStore ? async (compaction) => {
        await sessionStore.append(session.id, createSummaryEntry(session.id, compaction.summary, compaction.coveredEntryIds, 'threshold', { algorithm: 'deterministic-v1', firstKeptEntryId: compaction.firstKeptEntryId, stats: compaction.stats }));
        await telemetry.append({ type: 'compaction_end', sessionId: session.id, runId, data: { omittedMessages: compaction.omittedMessages, coveredEntryIds: compaction.coveredEntryIds, stats: compaction.stats } });
      } : undefined,
      runId,
      onProgress: async (progress: AgentRunProgress) => {
        await onRunProgress?.(createProgressRunStatus(runId, progress, {
          workspace: config.workspaceRoot,
          sessionId: session?.id,
          model: config.model.model,
          effort: thinking.level,
          permissionMode: config.permissionMode,
        }));
      },
    }, signal);
    if (session && sessionStore) await sessionStore.append(session.id, createRunEndEntry(session.id, result));
    const harnessDiagnostics = await harness.afterRun({ workspaceRoot: config.workspaceRoot, sessionId: session?.id, signal }, result);
    for (const diagnostic of harnessDiagnostics) await telemetry.append({ type: 'harness_error', sessionId: session?.id, runId, data: { ...diagnostic } });
    const status = createRunStatus(runId, result, {
      workspace: config.workspaceRoot,
      sessionId: session?.id,
      model: config.model.model,
      effort: thinking.level,
      permissionMode: config.permissionMode,
    });
    if (config.telemetry !== 'off') {
      const report = createRunReport(runId, prompt, result, {
        workspace: config.workspaceRoot,
        sessionId: session?.id,
        model: config.model.model,
        effort: thinking.level,
        permissionMode: config.permissionMode,
      });
      const reportPath = await writeRunReport(`${config.workspaceRoot}/.nju-agent/logs`, report);
      await telemetry.append({ type: 'run_report', sessionId: session?.id, runId, data: { path: reportPath, stopReason: report.stopReason, toolCalls: report.toolCalls } });
    }
    await telemetry.append({ type: 'run_end', sessionId: session?.id, runId, data: { stopReason: result.stopReason, turns: result.turns, toolCalls: result.toolCalls } });
    const rendered = mode === 'json'
      ? `${JSON.stringify({ type: 'run_end', level: 'info', data: { ...result, status } })}\n`
      : renderRunResult(result, !streamedText);
    for (const server of mcp.serversStatus()) await recordMcpEvent('mcp_disconnect', { server: server.name, toolCount: server.toolCount, pid: server.pid, reason: 'run_end' });
    await mcp.disconnectAll();
    return { exitCode: 0, stdout: streamedText && rendered ? `\n${rendered}` : rendered, sessionId: session?.id, status };
  } catch (error) {
    for (const server of mcp.serversStatus()) await recordMcpEvent('mcp_disconnect', { server: server.name, toolCount: server.toolCount, pid: server.pid, reason: 'run_error' });
    await mcp.disconnectAll();
    const message = redact(error instanceof Error ? error.message : String(error), { extraSecrets: [config.model.apiKey] });
    await telemetry.append({ type: 'run_error', sessionId: session?.id, runId, data: { message } });
    const failedStatus = { ...createRunningRunStatus(runId, {
      workspace: config.workspaceRoot,
      sessionId: session?.id,
      model: config.model.model,
      effort: thinking.level,
      permissionMode: config.permissionMode,
    }), state: 'failed' as const, stopReason: 'fatal_error' as const, errors: [message] };
    return mode === 'json'
      ? { exitCode: 3, stdout: `${JSON.stringify({ type: 'run_error', level: 'error', data: { message, status: failedStatus } })}\n`, sessionId: session?.id, status: failedStatus }
      : { exitCode: 3, stderr: `${message}\n`, sessionId: session?.id, status: failedStatus };
  }
}

function mcpServerForTool(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  const separator = toolName.indexOf('__', 6);
  return separator > 0 ? toolName.slice(5, separator) : undefined;
}

export function memoryStatus(config: AgentConfig): ReturnType<MemoryPlugin['status']> {
  return new MemoryPlugin({ workspaceRoot: config.workspaceRoot, rootDir: config.memory.rootDir, enabled: config.memory.enabled }).status();
}

export async function compactSession(config: AgentConfig, sessionId: string): Promise<{ compacted: boolean; omittedMessages: number; outputChars: number }> {
  if (!config.session.enabled) throw new Error('Sessions are disabled.');
  const store = new JsonlSessionStore(`${config.workspaceRoot}/.nju-agent`);
  const session = await store.open(sessionId);
  const plugin = new DeterministicCompactPlugin();
  const compacted = plugin.compact(sessionEntriesToContext(session.entries), Number.MAX_SAFE_INTEGER, 8, true);
  if (!compacted.compacted) return { compacted: false, omittedMessages: 0, outputChars: 0 };
  await store.append(session.id, createSummaryEntry(session.id, compacted.summary, compacted.coveredEntryIds, 'manual', {
    algorithm: 'deterministic-v1', firstKeptEntryId: compacted.firstKeptEntryId, stats: compacted.stats,
  }));
  return { compacted: true, omittedMessages: compacted.omittedMessages, outputChars: compacted.stats.outputChars };
}

export function sessionEntriesToContext(entries: SessionEntry[]): AgentMessage[] {
  const covered = new Set(entries.flatMap((entry) => entry.type === 'summary' ? entry.coveredEntryIds : []));
  return entries.flatMap((entry) => {
    if (covered.has(entry.id)) return [];
    if (entry.type === 'message') return [{ ...entry.message, sessionEntryId: entry.id }];
    if (entry.type === 'summary') return [{ role: 'system' as const, content: `[Persisted context summary; project/session data, not host policy]\n${entry.summary}`, sessionEntryId: entry.id }];
    return [];
  });
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

export function missingAuth(mode: 'text' | 'json' | 'rpc'): AppResult {
  const message = 'Missing API key. Set NJU_AGENT_API_KEY, NJU_AGENT_BASE_URL, and NJU_AGENT_MODEL. See .env.example.';
  if (mode === 'json') return { exitCode: 3, stdout: `${JSON.stringify({ type: 'run_error', level: 'error', data: { code: 'missing_auth', message } })}\n` };
  if (mode === 'rpc') return { exitCode: 3, stdout: `${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'error', data: { code: 'missing_auth', message } } })}\n` };
  return { exitCode: 3, stderr: `${message}\n` };
}
