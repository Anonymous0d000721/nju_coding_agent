import readline from 'node:readline/promises';
import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process';
import { AgentRunner } from '../agent/runner.js';
import { buildSystemPrompt } from '../agent/system-prompt.js';
import { createModelClient } from '../model/create-client.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { createFileTools } from '../tools/file-tools.js';
import { createShellTool } from '../tools/shell-tool.js';
import { parseArgs } from './cli-args.js';
import { renderHelp, renderRunResult, renderVersion } from './renderer.js';
import { loadConfig } from '../shared/config.js';
import { redact } from '../shared/redact.js';
import { JsonlSessionStore } from '../session/jsonl-store.js';
import { createMessageEntry, createRunEndEntry, createRunStartEntry } from '../session/entries.js';
import type { AgentMessage, AgentRunResult } from '../agent/types.js';
import type { AgentConfig } from '../shared/config.js';
import type { MessageEntry } from '../session/session-types.js';

export interface AppServices {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

export interface AppResult { exitCode: number; stdout?: string; stderr?: string; }

export function createApp(services: AppServices) {
  return {
    async run(): Promise<AppResult> {
      const args = parseArgs(services.argv);
      if (args.help) return { exitCode: 0, stdout: renderHelp() };
      if (args.version) return { exitCode: 0, stdout: renderVersion() };
      const config = loadConfig({ env: services.env, args, cwd: services.cwd });
      if (args.mode === 'rpc') return { exitCode: 1, stderr: 'RPC mode is planned but not implemented yet.\n' };
      if (!args.prompt) return runInteractive(config, services);
      return runPrompt(config, args.prompt, undefined, args.mode);
    },
  };
}

async function runPrompt(config: AgentConfig, prompt: string, sessionId?: string, mode: 'text' | 'json' = 'text'): Promise<AppResult> {
  if (!config.model.apiKey) return missingAuth(mode);
  const registry = new ToolRegistry();
  for (const tool of createFileTools()) registry.register(tool);
  registry.register(createShellTool());
  const sessionStore = config.session.enabled ? new JsonlSessionStore(`${config.workspaceRoot}/.nju-agent`) : undefined;
  const session = sessionStore ? (sessionId || config.session.id
    ? await sessionStore.open(sessionId ?? config.session.id!)
    : await sessionStore.create({ cwd: config.workspaceRoot, model: config.model.model, appVersion: renderVersion().trim() })) : undefined;
  const previousMessages: AgentMessage[] = session?.entries.filter((entry): entry is MessageEntry => entry.type === 'message').map((entry) => entry.message) ?? [];
  const userEntry = session ? createMessageEntry(session.id, { role: 'user', content: prompt }) : undefined;
  if (session && userEntry) {
    await sessionStore?.append(session.id, userEntry);
    await sessionStore?.append(session.id, createRunStartEntry(session.id, userEntry.id, { model: config.model.model, permissionMode: config.permissionMode }));
  }
  const runner = new AgentRunner({
    model: createModelClient({ apiFormat: config.model.apiFormat, apiKey: config.model.apiKey, baseUrl: config.model.baseUrl, model: config.model.model }),
    tools: new ToolExecutor(registry, { workspaceRoot: config.workspaceRoot, permissionMode: config.permissionMode }),
    systemPrompt: buildSystemPrompt(config.workspaceRoot),
    toolDefinitions: registry.definitionsForModel(),
    onMessage: session && sessionStore ? async (message) => { await sessionStore.append(session.id, createMessageEntry(session.id, message)); } : undefined,
  });
  try {
    const result = await runner.run(prompt, { maxTurns: 8, maxToolCalls: 24, maxContextChars: 100_000, initialMessages: previousMessages, persistUserMessage: false });
    if (session && sessionStore) await sessionStore.append(session.id, createRunEndEntry(session.id, result));
    return { exitCode: 0, stdout: mode === 'json'
      ? `${JSON.stringify({ type: 'run_end', level: 'info', data: result })}\n`
      : renderRunResult(result) };
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error), { extraSecrets: [config.model.apiKey] });
    return mode === 'json'
      ? { exitCode: 3, stdout: `${JSON.stringify({ type: 'run_error', level: 'error', data: { message } })}\n` }
      : { exitCode: 3, stderr: `${message}\n` };
  }
}

async function runInteractive(config: AgentConfig, services: AppServices): Promise<AppResult> {
  const input = services.stdin ?? defaultStdin;
  const output = services.stdout ?? defaultStdout;
  if (!config.model.apiKey) return missingAuth('text');
  const rl = readline.createInterface({ input: input as NodeJS.ReadableStream, output: output as NodeJS.WritableStream, terminal: true });
  let currentSessionId = config.session.id;
  output.write(`nju-agent ${renderVersion().trim()}\nworkspace: ${config.workspaceRoot}\nType /help for commands.\n`);
  try {
    while (true) {
      const line = (await rl.question('> ')).trim();
      if (!line) continue;
      if (line === '/quit' || line === '/exit') break;
      if (line === '/help') { output.write(`${renderHelp()}\n`); continue; }
      if (line === '/new') { currentSessionId = undefined; output.write('Started a new session.\n'); continue; }
      if (line === '/sessions') {
        if (!config.session.enabled) { output.write('Sessions are disabled.\n'); continue; }
        const store = new JsonlSessionStore(`${config.workspaceRoot}/.nju-agent`);
        const sessions = await store.list();
        output.write(`${sessions.length ? sessions.map((item) => item.id).join('\n') : 'No sessions.'}\n`);
        continue;
      }
      if (line === '/session') { output.write(`session: ${currentSessionId ?? '(new)'}\nmodel: ${config.model.model}\npermission: ${config.permissionMode}\n`); continue; }
      if (line === '/model' || line.startsWith('/model ')) {
        const requestedModel = line.slice('/model'.length).trim();
        if (requestedModel) config.model.model = requestedModel;
        output.write(`model: ${config.model.model}\n`);
        continue;
      }
      if (line === '/compact') { output.write('Context compaction is not implemented.\n'); continue; }
      if (line === '/resume' || line.startsWith('/resume ')) {
        const requestedSession = line.slice('/resume'.length).trim();
        if (requestedSession) currentSessionId = requestedSession;
        else if (config.session.enabled) {
          const store = new JsonlSessionStore(`${config.workspaceRoot}/.nju-agent`);
          currentSessionId = (await store.list())[0]?.id;
        }
        output.write(`Resuming ${currentSessionId ?? '(new)'}.\n`);
        continue;
      }
      const result = await runPrompt(config, line, currentSessionId);
      if (result.stdout) output.write(result.stdout);
      if (result.stderr) output.write(result.stderr);
      if (currentSessionId === undefined && config.session.enabled) {
        const store = new JsonlSessionStore(`${config.workspaceRoot}/.nju-agent`);
        const sessions = await store.list();
        currentSessionId = sessions[0]?.id;
      }
    }
  } finally { rl.close(); }
  return { exitCode: 0 };
}

function missingAuth(mode: 'text' | 'json'): AppResult {
  const message = 'Missing API key. Set NJU_AGENT_API_KEY, NJU_AGENT_BASE_URL, and NJU_AGENT_MODEL. See .env.example.';
  if (mode === 'json') return { exitCode: 3, stdout: `${JSON.stringify({ type: 'run_error', level: 'error', data: { code: 'missing_auth', message } })}\n` };
  return { exitCode: 3, stderr: `${message}\n` };
}
