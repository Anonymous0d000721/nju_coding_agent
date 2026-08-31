import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { JsonlSessionStore, sessionName } from '../session/jsonl-store.js';
import { createSessionNameEntry, createThinkingLevelChangeEntry } from '../session/entries.js';
import type { AgentConfig } from '../shared/config.js';
import type { AgentRunControl, AgentStreamEvent } from '../agent/types.js';
import { clampThinkingLevel } from '../model/thinking.js';
import type { ThinkingLevel } from '../model/model-client.js';
import { MemoryPlugin } from '../context/memory.js';
import { loadUserPlugins } from '../plugins/loader.js';
import { ProjectTrustStore } from '../shared/trust.js';
import type { AppResult } from './app.js';
import { ChangeJournal } from '../telemetry/journal.js';
import { createIdleRunStatus, createRunningRunStatus, type RunStatus, type RunStatusContext } from '../telemetry/report.js';

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface RpcDeps {
  config: AgentConfig;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  runPrompt: (
    config: AgentConfig,
    prompt: string,
    sessionId?: string,
    mode?: 'text' | 'json',
    thinking?: AgentConfig['model']['thinking'],
    streamOutput?: NodeJS.WritableStream,
    showThinking?: boolean,
    onAgentEvent?: (event: AgentStreamEvent) => void | Promise<void>,
    signal?: AbortSignal,
    approveTool?: undefined,
    reloadPlugins?: boolean,
    control?: AgentRunControl,
    onRunProgress?: (status: RunStatus) => void | Promise<void>,
  ) => Promise<AppResult>;
  compactSession: (config: AgentConfig, sessionId: string) => Promise<{ compacted: boolean; omittedMessages: number; outputChars: number }>;
}

function statusContext(config: AgentConfig, sessionId?: string): RunStatusContext {
  return { workspace: config.workspaceRoot, sessionId, model: config.model.model, effort: config.model.thinking.level, permissionMode: config.permissionMode };
}

export async function runRpc(deps: RpcDeps): Promise<AppResult> {
  const write = (value: unknown): void => { deps.stdout.write(`${JSON.stringify(value)}\n`); };
  const store = new JsonlSessionStore(`${deps.config.workspaceRoot}/.nju-agent`);
  let sessionId = deps.config.session.id;
  let activeRun: { runId: string; controller: AbortController; control: AgentRunControl; done: Promise<void>; status: RunStatus } | undefined;
  let latestStatus: RunStatus | undefined;
  let reloadPlugins = false;
  let reasoningDisplay = false;
  let shuttingDown = false;

  const error = (id: RpcRequest['id'], code: number, message: string, data?: unknown): void => {
    if (id === undefined) return;
    write({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
  };
  const response = (id: RpcRequest['id'], result: unknown): void => write({ jsonrpc: '2.0', id, result });
  const event = (type: string, data: unknown, runId?: string): void => write({ jsonrpc: '2.0', method: 'event', params: { type, ...(runId ? { runId } : {}), data } });
  const idleStatus = (): RunStatus => createIdleRunStatus(statusContext(deps.config, sessionId));
  const setActiveStatus = (runId: string, status: RunStatus): void => {
    if (activeRun?.runId !== runId) return;
    activeRun.status = status;
    event('run_status', { sessionId, status }, runId);
  };
  const createSession = async (): Promise<{ id: string; name?: string }> => {
    const session = await store.create({ cwd: deps.config.workspaceRoot, model: deps.config.model.model, appVersion: '0.1.0' });
    sessionId = session.id;
    latestStatus = undefined;
    return { id: session.id, name: sessionName(session.entries) };
  };
  const renameSession = async (name: string): Promise<{ sessionId: string; name: string }> => {
    const target = sessionId ? await store.open(sessionId) : await store.create({ cwd: deps.config.workspaceRoot, model: deps.config.model.model, appVersion: '0.1.0' });
    sessionId = target.id;
    await store.append(target.id, createSessionNameEntry(target.id, name.slice(0, 120)));
    return { sessionId: target.id, name: name.slice(0, 120) };
  };

  const handle = async (request: RpcRequest): Promise<void> => {
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      error(request.id, -32600, 'Invalid Request');
      return;
    }
    const params = request.params ?? {};
    const hasId = request.id !== undefined && request.id !== null;
    const reply = (result: unknown): void => { if (hasId) response(request.id, result); };
    try {
      switch (request.method) {
        case 'initialize':
          reply({ protocolVersion: '1.0', server: { name: 'nju-agent', version: '0.1.0' }, capabilities: { sessions: true, streaming: true, cancel: true, slash: true } });
          return;
        case 'session/new': {
          const session = await store.create({ cwd: deps.config.workspaceRoot, model: deps.config.model.model, appVersion: '0.1.0' });
          sessionId = session.id;
          latestStatus = undefined;
          reply({ sessionId });
          event('session_updated', { sessionId, action: 'created' });
          return;
        }
        case 'session/resume': {
          const requested = stringParam(params, 'sessionId');
          const session = await store.open(requested);
          sessionId = session.id;
          latestStatus = undefined;
          reply({ sessionId, name: sessionName(session.entries), entries: session.entries.length });
          event('session_updated', { sessionId, action: 'resumed' });
          return;
        }
        case 'session/state':
          reply({ sessionId, runId: activeRun?.runId, running: Boolean(activeRun), status: activeRun?.status ?? latestStatus });
          return;
        case 'status': {
          reply(activeRun?.status ?? latestStatus ?? createIdleRunStatus(statusContext(deps.config, sessionId)));
          return;
        }
        case 'prompt': {
          const text = stringParam(params, 'text');
          if (!deps.config.model.apiKey) { error(request.id, -32003, 'Missing API key. Set NJU_AGENT_API_KEY, NJU_AGENT_BASE_URL, and NJU_AGENT_MODEL. See .env.example.'); return; }
          if (activeRun) { error(request.id, -32000, 'A run is already active'); return; }
          const runId = randomUUID();
          const controller = new AbortController();
          const queue: string[] = [];
          const steers: string[] = [];
          const control: AgentRunControl = { queue: (message) => queue.push(message), steer: (message) => steers.push(message), drainQueue: () => queue.splice(0), drainSteers: () => steers.splice(0) };
          const selectedSession = typeof params.sessionId === 'string' ? params.sessionId : sessionId;
          if (selectedSession) sessionId = selectedSession;
          reply({ accepted: true, runId, sessionId });
          const runningStatus = createRunningRunStatus(runId, statusContext(deps.config, sessionId));
          activeRun = { runId, controller, control, done: Promise.resolve(), status: runningStatus };
          event('run_start', { sessionId, status: runningStatus }, runId);
          const done = deps.runPrompt(deps.config, text, sessionId, 'text', deps.config.model.thinking, undefined, false, async (streamEvent) => emitAgentEvent(event, streamEvent, runId), controller.signal, undefined, reloadPlugins, control, (status) => setActiveStatus(runId, status))
            .then((result) => {
              if (result.sessionId) sessionId = result.sessionId;
              const status = result.status ?? { ...createRunningRunStatus(runId, statusContext(deps.config, sessionId)), state: result.exitCode === 0 ? 'completed' as const : 'failed' as const };
              latestStatus = { ...status, sessionId };
              if (activeRun?.runId === runId) activeRun.status = latestStatus;
              event('message_end', { sessionId, stdout: result.stdout, stderr: result.stderr, status: latestStatus }, runId);
              event('run_end', { sessionId, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, status: latestStatus }, runId);
            })
            .catch((runError) => {
              latestStatus = { ...runningStatus, state: 'failed', stopReason: 'fatal_error', errors: [messageOf(runError)] };
              if (activeRun?.runId === runId) activeRun.status = latestStatus;
              event('error', { code: 'run_error', message: messageOf(runError), status: latestStatus }, runId);
            })
            .finally(() => { if (activeRun?.runId === runId) activeRun = undefined; });
          if (activeRun?.runId === runId) activeRun.done = done;
          return;
        }
        case 'cancel': {
          if (!activeRun || (typeof params.runId === 'string' && params.runId !== activeRun.runId)) { reply({ cancelled: false }); return; }
          activeRun.controller.abort();
          reply({ cancelled: true, runId: activeRun.runId });
          return;
        }
        case 'slash': {
          const rawCommand = stringParam(params, 'command').trim();
          const [command, ...argumentParts] = rawCommand.split(/\s+/);
          const argument = argumentParts.join(' ').trim();
          if (command === '/quit' || command === '/exit') {
            reply({ shuttingDown: true });
            shuttingDown = true;
            const runToStop = activeRun;
            runToStop?.controller.abort();
            if (runToStop) await runToStop.done;
            input.close();
          } else if (command === '/help') {
            reply({ commands: ['/help', '/new', '/trust', '/name <name>', '/rename <session_name>', '/fork', '/sessions', '/session', '/resume <id>', '/model [id]', '/effort [level]', '/reasoning [on|off]', '/thinking [on|off]', '/memory', '/reload', '/compact', '/status', '/diff', '/undo', '/quit', '/exit'] });
          } else if (command === '/new') {
            if (activeRun) throw rpcError(-32000, 'Cannot change session while a run is active');
            const created = await createSession();
            reply({ sessionId: created.id, name: created.name });
            event('session_updated', { sessionId, action: 'created' });
          } else if (command === '/trust') {
            new ProjectTrustStore().trust(deps.config.workspaceRoot);
            deps.config.projectTrusted = true;
            reply({ trusted: true, workspace: deps.config.workspaceRoot });
          } else if (command === '/name' || command === '/rename') {
            if (!argument) throw rpcError(-32602, `Usage: ${command} <session_name>`);
            if (activeRun) throw rpcError(-32000, 'Cannot rename a session while a run is active');
            const named = await renameSession(argument);
            reply(named);
            event('session_updated', { ...named, action: 'renamed' });
          } else if (command === '/fork') {
            if (activeRun) throw rpcError(-32000, 'Cannot fork a session while a run is active');
            if (!sessionId) throw rpcError(-32001, 'No active session');
            const child = await store.fork(sessionId);
            sessionId = child.id;
            latestStatus = undefined;
            reply({ sessionId, name: sessionName(child.entries) });
            event('session_updated', { sessionId, action: 'forked' });
          } else if (command === '/sessions') {
            reply({ sessions: await store.list() });
          } else if (command === '/session') {
            const current = sessionId ? await store.open(sessionId) : undefined;
            reply({ sessionId, name: current ? sessionName(current.entries) : undefined, runId: activeRun?.runId, running: Boolean(activeRun), model: deps.config.model.model, effort: deps.config.model.thinking.level, reasoningDisplay, permissionMode: deps.config.permissionMode });
          } else if (command === '/resume') {
            if (activeRun) throw rpcError(-32000, 'Cannot resume a session while a run is active');
            if (!argument) throw rpcError(-32602, 'Usage: /resume <session_id>');
            const session = await store.open(argument);
            sessionId = session.id;
            latestStatus = undefined;
            reply({ sessionId, name: sessionName(session.entries), entries: session.entries.length });
            event('session_updated', { sessionId, action: 'resumed' });
          } else if (command === '/model') {
            if (!argument) reply({ model: deps.config.model.model, effort: deps.config.model.thinking.level });
            else {
              deps.config.model.model = argument;
              deps.config.model.thinking = { ...deps.config.model.thinking, level: clampThinkingLevel(deps.config.model.thinking.level, deps.config.model.thinking.map) };
              reply({ model: deps.config.model.model, effort: deps.config.model.thinking.level });
            }
          } else if (command === '/effort') {
            if (!argument) reply({ effort: deps.config.model.thinking.level });
            else {
              if (!isThinkingLevel(argument)) throw rpcError(-32602, `Invalid effort: ${argument}`);
              const level = clampThinkingLevel(argument, deps.config.model.thinking.map);
              deps.config.model.thinking = { ...deps.config.model.thinking, level };
              if (sessionId && deps.config.session.enabled) await store.append(sessionId, createThinkingLevelChangeEntry(sessionId, level));
              reply({ effort: level });
            }
          } else if (command === '/reasoning' || command === '/thinking') {
            if (!argument) reply({ reasoningDisplay });
            else {
              if (argument !== 'on' && argument !== 'off') throw rpcError(-32602, `Usage: ${command} [on|off]`);
              reasoningDisplay = argument === 'on';
              reply({ reasoningDisplay });
            }
          } else if (command === '/memory') {
            reply(new MemoryPlugin({ workspaceRoot: deps.config.workspaceRoot, rootDir: deps.config.memory.rootDir, enabled: deps.config.memory.enabled }).status());
          } else if (command === '/reload') {
            const plugins = await loadUserPlugins(deps.config.workspaceRoot, deps.config.projectTrusted, true);
            reloadPlugins = true;
            reply({ reloaded: plugins.length, nextRun: true });
          } else if (command === '/compact') {
            if (!sessionId) throw rpcError(-32001, 'No active session');
            reply(await deps.compactSession(deps.config, sessionId));
          } else if (command === '/status') {
            reply(activeRun?.status ?? latestStatus ?? idleStatus());
          } else if (command === '/diff') {
            reply({ text: await new ChangeJournal(deps.config.workspaceRoot).formatDiff(sessionId ? { sessionId } : {}) });
          } else if (command === '/undo') {
            reply(await new ChangeJournal(deps.config.workspaceRoot).undoLast(sessionId ? { sessionId } : {}));
          } else {
            throw rpcError(-32602, `Unsupported slash command: ${rawCommand}`);
          }
          return;
        }
        case 'shutdown':
          reply({ shuttingDown: true });
          shuttingDown = true;
          const runToStop = activeRun;
          runToStop?.controller.abort();
          if (runToStop) await runToStop.done;
          input.close();
          return;
        default:
          error(request.id, -32601, `Method not found: ${request.method}`);
      }
    } catch (requestError) {
      const rpc = requestError instanceof RpcError ? requestError : new RpcError(-32001, messageOf(requestError));
      error(request.id, rpc.code, rpc.message);
    }
  };

  const input = createInterface({ input: deps.stdin as Readable, crlfDelay: Infinity });
  return new Promise<AppResult>((resolve) => {
    input.on('line', (line) => {
      if (!line.trim()) return;
      let request: RpcRequest;
      try { request = JSON.parse(line) as RpcRequest; }
      catch { error(null, -32700, 'Parse error'); return; }
      void handle(request);
    });
    input.on('close', () => resolve({ exitCode: shuttingDown ? 0 : 0 }));
  });
}

function emitAgentEvent(write: (type: string, data: unknown, runId?: string) => void, streamEvent: AgentStreamEvent, runId: string): void {
  if (streamEvent.type === 'text_delta') write('message_delta', { text: streamEvent.delta }, runId);
  else if (streamEvent.type === 'thinking_delta') write('thinking_delta', { text: streamEvent.delta }, runId);
  else if (streamEvent.type === 'tool_call') write('tool_call_start', { tool: streamEvent.toolCall.name, preview: streamEvent.preview ?? streamEvent.toolCall.preview }, runId);
  else if (streamEvent.type === 'tool_result') write('tool_result', { tool: streamEvent.result.toolName, status: streamEvent.result.ok ? 'ok' : 'error', preview: streamEvent.result.preview, elapsedMs: streamEvent.result.elapsedMs, error: streamEvent.result.error }, runId);
}

function stringParam(params: Record<string, unknown>, name: string): string {
  if (typeof params[name] !== 'string' || !params[name].trim()) throw rpcError(-32602, `Parameter '${name}' must be a non-empty string`);
  return params[name] as string;
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value);
}

class RpcError extends Error { constructor(readonly code: number, message: string) { super(message); } }
function rpcError(code: number, message: string): RpcError { return new RpcError(code, message); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
