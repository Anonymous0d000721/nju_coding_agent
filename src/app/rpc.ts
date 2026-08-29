import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { JsonlSessionStore, sessionName } from '../session/jsonl-store.js';
import type { AgentConfig } from '../shared/config.js';
import type { AgentRunControl, AgentStreamEvent } from '../agent/types.js';
import type { AppResult } from './app.js';

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
  ) => Promise<AppResult>;
  compactSession: (config: AgentConfig, sessionId: string) => Promise<{ compacted: boolean; omittedMessages: number; outputChars: number }>;
}

export async function runRpc(deps: RpcDeps): Promise<AppResult> {
  const write = (value: unknown): void => { deps.stdout.write(`${JSON.stringify(value)}\n`); };
  const store = new JsonlSessionStore(`${deps.config.workspaceRoot}/.nju-agent`);
  let sessionId = deps.config.session.id;
  let activeRun: { runId: string; controller: AbortController; control: AgentRunControl; done: Promise<void> } | undefined;
  let shuttingDown = false;

  const error = (id: RpcRequest['id'], code: number, message: string, data?: unknown): void => {
    if (id === undefined) return;
    write({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
  };
  const response = (id: RpcRequest['id'], result: unknown): void => write({ jsonrpc: '2.0', id, result });
  const event = (type: string, data: unknown, runId?: string): void => write({ jsonrpc: '2.0', method: 'event', params: { type, ...(runId ? { runId } : {}), data } });

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
          reply({ sessionId });
          event('session_updated', { sessionId, action: 'created' });
          return;
        }
        case 'session/resume': {
          const requested = stringParam(params, 'sessionId');
          const session = await store.open(requested);
          sessionId = session.id;
          reply({ sessionId, name: sessionName(session.entries), entries: session.entries.length });
          event('session_updated', { sessionId, action: 'resumed' });
          return;
        }
        case 'session/state':
          reply({ sessionId, runId: activeRun?.runId, running: Boolean(activeRun) });
          return;
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
          event('run_start', { sessionId }, runId);
          const done = deps.runPrompt(deps.config, text, sessionId, 'text', deps.config.model.thinking, undefined, false, async (streamEvent) => emitAgentEvent(event, streamEvent, runId), controller.signal, undefined, false, control)
            .then((result) => {
              if (result.sessionId) sessionId = result.sessionId;
              event('message_end', { sessionId, stdout: result.stdout, stderr: result.stderr }, runId);
              event('run_end', { sessionId, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }, runId);
            })
            .catch((runError) => event('error', { code: 'run_error', message: messageOf(runError) }, runId))
            .finally(() => { if (activeRun?.runId === runId) activeRun = undefined; });
          activeRun = { runId, controller, control, done };
          return;
        }
        case 'cancel': {
          if (!activeRun || (typeof params.runId === 'string' && params.runId !== activeRun.runId)) { reply({ cancelled: false }); return; }
          activeRun.controller.abort();
          reply({ cancelled: true, runId: activeRun.runId });
          return;
        }
        case 'slash': {
          const command = stringParam(params, 'command').trim();
          if (command === '/compact') {
            if (!sessionId) throw rpcError(-32001, 'No active session');
            reply(await deps.compactSession(deps.config, sessionId));
          } else if (command === '/session') {
            reply({ sessionId, runId: activeRun?.runId, running: Boolean(activeRun) });
          } else if (command === '/help') {
            reply({ commands: ['/compact', '/session', '/help'] });
          } else {
            throw rpcError(-32602, `Unsupported slash command: ${command}`);
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

class RpcError extends Error { constructor(readonly code: number, message: string) { super(message); } }
function rpcError(code: number, message: string): RpcError { return new RpcError(code, message); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
