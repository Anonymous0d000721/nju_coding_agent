import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { ToolDefinition, ToolContext } from '../tools/types.js';
import { normalizeRelative, resolveWorkspacePath } from '../tools/path-guard.js';
import { createPluginWorkspace } from './workspace.js';
import type { LoadedUserPlugin, PluginLoadDiagnostic, PluginTrustNotice, UserPlugin, UserPluginLoadReport } from './types.js';
import { terminateProcessTree } from '../shared/process-control.js';

const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOOL_NAME = /^[a-z0-9][a-z0-9_]{0,63}$/;
const VERSIONS = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FORBIDDEN_SCHEMA_KEYS = /^(?:command|cwd|env|exec|executable|headers?|network|shell|token|secret|password|credential|authorization|url)$/i;
const FORBIDDEN_SCHEMA_FEATURES = new Set(['$ref', 'allOf', 'anyOf', 'not', 'patternProperties', 'unevaluatedProperties']);
const FORBIDDEN_PLUGIN_CAPABILITIES: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\bimport\s*\(\s*['"]\s*(?:node:)?(?:fs(?:\/promises)?|child_process|net|http|https|tls|dns|dgram|worker_threads|vm|module|inspector)\b/i, name: 'privileged module loading' },
  { pattern: /\bimport\s+(?:[\s\S]*?\sfrom\s*)?['"]\s*(?:node:)?(?:fs(?:\/promises)?|child_process|net|http|https|tls|dns|dgram|worker_threads|vm|module|inspector)\b/i, name: 'privileged module import' },
  { pattern: /\brequire\s*\(/i, name: 'require' },
  { pattern: /\bprocess\s*(?:\.|\[)/i, name: 'process access' },
  { pattern: /\b(?:fetch|WebSocket|XMLHttpRequest)\s*\(/i, name: 'network access' },
  { pattern: /\b(?:eval|Function)\s*\(/i, name: 'dynamic code evaluation' },
];
const LOAD_TIMEOUT_MS = 5_000;
const SANDBOX_WORKER_SOURCE = String.raw`
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const pluginFile = process.argv[1];
const tools = [];
const workspaceWaiters = new Map();
const invocations = new Map();
let nextRequestId = 1;

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const errorOf = (error) => ({ message: error instanceof Error ? error.message : String(error), ...(typeof error?.code === 'string' ? { code: error.code } : {}) });

try {
  const module = await import(pathToFileURL(pluginFile).href + '?sandbox=' + Date.now() + '-' + Math.random());
  const candidate = module.default ?? module.plugin;
  const plugin = typeof candidate === 'function' ? await candidate() : candidate;
  if (!plugin || typeof plugin !== 'object' || !Array.isArray(plugin.tools)) throw new Error('Plugin export must contain a tools array');
  for (const tool of plugin.tools) {
    if (!tool || typeof tool !== 'object' || typeof tool.handler !== 'function') throw new Error('Plugin tools must contain handlers');
    tools.push(tool);
  }
  const manifest = {
    id: plugin.id,
    ...(plugin.version === undefined ? {} : { version: plugin.version }),
    ...(plugin.description === undefined ? {} : { description: plugin.description }),
    tools: tools.map(({ handler: _handler, ...tool }) => tool),
  };
  send({ type: 'ready', plugin: manifest });

  const lines = createInterface({ input: process.stdin });
  lines.on('line', async (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.type === 'shutdown') {
      lines.close();
      process.exit(0);
    }
    if (message.type === 'cancel' && message.invokeId) {
      invocations.get(message.invokeId)?.abort();
      return;
    }
    if (message.type === 'workspace_result' && message.requestId) {
      const waiter = workspaceWaiters.get(message.requestId);
      if (!waiter) return;
      workspaceWaiters.delete(message.requestId);
      if (message.error) waiter.reject(Object.assign(new Error(message.error.message), message.error));
      else waiter.resolve(message.value);
      return;
    }
    if (message.type !== 'invoke' || !message.id) return;
    const controller = new AbortController();
    invocations.set(message.id, controller);
    try {
      const tool = tools[message.toolIndex];
      if (!tool) throw new Error('Unknown plugin tool');
      const workspace = {
        readText: (path) => workspaceRequest(message.id, 'readText', path),
        writeText: (path, content, options) => workspaceRequest(message.id, 'writeText', path, content, options),
      };
      const value = await tool.handler(message.args, { workspace, signal: controller.signal });
      send({ type: 'result', id: message.id, value });
    } catch (error) {
      send({ type: 'result', id: message.id, error: errorOf(error) });
    } finally {
      invocations.delete(message.id);
    }
  });
} catch (error) {
  send({ type: 'fatal', error: errorOf(error) });
  process.exitCode = 1;
}

function workspaceRequest(invokeId, operation, path, content, options) {
  const requestId = 'workspace-' + nextRequestId++;
  send({ type: 'workspace', invokeId, requestId, operation, path, ...(content === undefined ? {} : { content }), ...(options === undefined ? {} : { options }) });
  return new Promise((resolve, reject) => workspaceWaiters.set(requestId, { resolve, reject }));
}
`;

type PluginManifest = Omit<UserPlugin, 'tools'> & {
  tools: Array<Omit<ToolDefinition, 'handler'> & { handler?: never }>;
};

type WireMessage = {
  type: string;
  id?: string;
  invokeId?: string;
  requestId?: string;
  operation?: 'readText' | 'writeText';
  path?: string;
  content?: string;
  options?: { createDirectories?: boolean };
  plugin?: PluginManifest;
  value?: unknown;
  error?: { message: string; code?: string; details?: unknown };
};

export async function loadUserPlugins(workspaceRoot: string, trusted: boolean, reload = false): Promise<LoadedUserPlugin[]> {
  return (await loadUserPluginReport(workspaceRoot, trusted, reload)).loaded;
}

export async function loadUserPluginReport(workspaceRoot: string, trusted: boolean, reload = false): Promise<UserPluginLoadReport> {
  if (!trusted) {
    return {
      loaded: [],
      diagnostics: [{ code: 'untrusted_workspace', message: 'User plugins were not loaded because the workspace is not trusted.', recoverable: true }],
      trustNotices: [],
    };
  }

  const directory = (await resolveWorkspacePath(workspaceRoot, '.nju-agent/plugins')).absolutePath;
  let files: string[];
  try {
    files = (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.(?:mjs|js|cjs)$/.test(entry.name))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { loaded: [], diagnostics: [], trustNotices: [] };
    throw error;
  }

  const loaded: LoadedUserPlugin[] = [];
  const diagnostics: PluginLoadDiagnostic[] = [];
  const trustNotices: PluginTrustNotice[] = [];
  const ids = new Map<string, { version?: string; source: string }>();
  const toolOwners = new Map<string, string>();
  for (const file of files) {
    const relative = normalizeRelative(path.relative(workspaceRoot, file));
    let safeFile: string;
    try {
      safeFile = (await resolveWorkspacePath(workspaceRoot, relative)).absolutePath;
    } catch (error) {
      diagnostics.push(diagnostic('load_failed', messageOf(error), file));
      continue;
    }

    let client: SandboxPluginClient | undefined;
    try {
      const source = await fs.readFile(safeFile, 'utf8');
      assertPluginSourceSafe(source, safeFile);
      client = await SandboxPluginClient.open(safeFile, reload);
      const manifest = client.manifest;
      const plugin = createProxyPlugin(manifest, client);
      validatePlugin(plugin, safeFile);
      const digest = createHash('sha256').update(source).digest('hex');
      const previous = ids.get(plugin.id);
      if (previous) {
        const code = previous.version !== plugin.version ? 'version_conflict' : 'invalid_manifest';
        diagnostics.push(diagnostic(code, `Plugin id '${plugin.id}' conflicts with ${previous.source}${previous.version ? ` (version ${previous.version})` : ''}.`, safeFile, plugin.id));
        await client.close();
        continue;
      }
      const conflictingTool = plugin.tools.find((tool) => toolOwners.has(tool.name));
      if (conflictingTool) {
        diagnostics.push(diagnostic('tool_name_conflict', `Plugin '${plugin.id}' tool '${conflictingTool.name}' conflicts with ${toolOwners.get(conflictingTool.name)}.`, safeFile, plugin.id));
        await client.close();
        continue;
      }
      ids.set(plugin.id, { version: plugin.version, source: safeFile });
      for (const tool of plugin.tools) toolOwners.set(tool.name, `${plugin.id}:${tool.name}`);
      const sandbox = client;
      loaded.push({ ...plugin, source: safeFile, sha256: digest, dispose: () => sandbox.close() });
      client = undefined;
      trustNotices.push({ source: relative, sha256: digest, message: `Loaded sandboxed trusted user plugin ${plugin.id}${plugin.version ? `@${plugin.version}` : ''}; review this hash if the file changes.` });
    } catch (error) {
      await client?.close();
      diagnostics.push(diagnostic(isForbiddenCapabilityError(error) ? 'forbidden_capability' : isValidationError(error) ? 'invalid_manifest' : 'load_failed', messageOf(error), safeFile));
    }
  }
  return { loaded, diagnostics, trustNotices };
}

export async function disposeUserPlugins(plugins: LoadedUserPlugin[]): Promise<void> {
  await Promise.all(plugins.map((plugin) => plugin.dispose?.().catch(() => undefined)));
}

export function pluginTools(plugins: LoadedUserPlugin[]): ToolDefinition[] {
  return plugins.flatMap((plugin) => plugin.tools);
}

export function validateUserPlugin(plugin: UserPlugin | undefined, source = '<plugin>'): asserts plugin is UserPlugin {
  validatePlugin(plugin, source);
}

function createProxyPlugin(manifest: PluginManifest, client: SandboxPluginClient): UserPlugin {
  return {
    id: manifest.id,
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    tools: manifest.tools.map((tool, index) => ({
      ...tool,
      handler: (_args: unknown, context: ToolContext) => client.invoke(index, _args, context),
    })),
  };
}

function validatePlugin(plugin: UserPlugin | undefined, source: string): asserts plugin is UserPlugin {
  if (!plugin || typeof plugin !== 'object' || !PLUGIN_ID.test(plugin.id)) throw invalid(`Invalid user plugin in ${source}: id must match [a-z0-9][a-z0-9._-]{0,63}`);
  if (plugin.version !== undefined && (typeof plugin.version !== 'string' || !VERSIONS.test(plugin.version))) throw invalid(`Invalid user plugin ${plugin.id}: version must be semver-like x.y.z`);
  if (plugin.description !== undefined && (typeof plugin.description !== 'string' || plugin.description.length > 2_000)) throw invalid(`Invalid user plugin ${plugin.id}: description must be at most 2000 characters`);
  if (!Array.isArray(plugin.tools)) throw invalid(`Invalid user plugin ${plugin.id}: tools must be an array`);
  const names = new Set<string>();
  for (const tool of plugin.tools) {
    if (!tool || typeof tool !== 'object' || !TOOL_NAME.test(tool.name) || names.has(tool.name)) throw invalid(`Invalid tool in user plugin ${plugin.id}: name must be unique lowercase snake_case`);
    names.add(tool.name);
    if (typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > 2_000) throw invalid(`Invalid tool ${plugin.id}:${tool.name}: description is required and bounded`);
    if (!['read', 'write', 'shell', 'external'].includes(tool.risk)) throw invalid(`Invalid tool ${plugin.id}:${tool.name}: unsupported risk`);
    if (typeof tool.readonly !== 'boolean' || (tool.risk === 'read' ? !tool.readonly : tool.readonly)) throw invalid(`Invalid tool ${plugin.id}:${tool.name}: readonly must match risk`);
    if (!tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) throw invalid(`Invalid tool ${plugin.id}:${tool.name}: parameters must be an object schema`);
    validatePluginSchema(tool.parameters as Record<string, unknown>, `${plugin.id}:${tool.name}`);
    if (typeof tool.handler !== 'function') throw invalid(`Invalid tool ${plugin.id}:${tool.name}: handler is required`);
    if (tool.timeoutMs !== undefined && (!Number.isInteger(tool.timeoutMs) || tool.timeoutMs < 1 || tool.timeoutMs > 300_000)) throw invalid(`Invalid tool ${plugin.id}:${tool.name}: timeoutMs must be 1..300000`);
  }
}

function validatePluginSchema(schema: Record<string, unknown>, label: string): void {
  if (schema.type !== 'object') throw invalid(`Invalid schema ${label}: root type must be object`);
  if (schema.properties !== undefined && !isRecord(schema.properties)) throw invalid(`Invalid schema ${label}: properties must be an object`);
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw invalid(`Invalid schema ${label}: additionalProperties must be false`);
  for (const key of Object.keys(schema)) {
    if (FORBIDDEN_SCHEMA_FEATURES.has(key)) throw invalid(`Invalid schema ${label}: ${key} is not allowed for plugins`);
  }
  const walk = (value: unknown, location: string): void => {
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_SCHEMA_KEYS.test(key)) throw invalid(`Invalid schema ${label}: dangerous field '${location}.${key}'`);
      if (FORBIDDEN_SCHEMA_FEATURES.has(key)) throw invalid(`Invalid schema ${label}: ${key} is not allowed for plugins`);
      if (isRecord(child)) walk(child, `${location}.${key}`);
      else if (Array.isArray(child)) child.forEach((item, index) => walk(item, `${location}[${index}]`));
    }
  };
  walk(schema.properties ?? {}, `${label}.properties`);
}

class SandboxPluginClient {
  manifest!: PluginManifest;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; context?: ToolContext; cleanup?: () => void }>();
  private readonly lines: Interface;
  private stderrTail = '';
  private nextId = 1;
  private closed = false;

  private constructor(private readonly child: ChildProcessWithoutNullStreams, manifest?: PluginManifest) {
    if (manifest) this.manifest = manifest;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-2_000);
    });
    child.once('error', (error) => this.failAll(error));
    child.once('exit', (code, signal) => {
      const detail = this.stderrTail.trim();
      this.failAll(new Error(`Plugin sandbox exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`));
    });
  }

  static async open(pluginFile: string, reload: boolean): Promise<SandboxPluginClient> {
    const args = ['--permission', '--disallow-code-generation-from-strings', `--allow-fs-read=${pluginFile}`, '--eval', SANDBOX_WORKER_SOURCE, pluginFile, reload ? `reload=${Date.now()}-${Math.random()}` : ''];
    const child = spawn(process.execPath, args, { cwd: path.dirname(pluginFile), env: sandboxEnvironment(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new SandboxPluginClient(child);
    try {
      const manifest = await client.waitForManifest();
      client.manifest = manifest;
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async invoke(toolIndex: number, args: unknown, context: ToolContext): Promise<unknown> {
    if (this.closed) throw Object.assign(new Error('Plugin sandbox is closed'), { code: 'plugin_sandbox_closed' });
    const id = `invoke-${this.nextId++}`;
    const signal = context.signal;
    if (signal?.aborted) throw Object.assign(new Error('Plugin execution was cancelled'), { code: 'user_cancelled' });
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.send({ type: 'cancel', invokeId: id });
        this.pending.delete(id);
        reject(Object.assign(new Error('Plugin execution was cancelled'), { code: 'user_cancelled' }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve, reject, context, cleanup: () => signal?.removeEventListener('abort', onAbort) });
      this.send({ type: 'invoke', id, toolIndex, args });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.send({ type: 'shutdown' });
    this.lines.close();
    this.failAll(new Error('Plugin sandbox closed'));
    await terminateProcessTree(this.child);
  }

  private async waitForManifest(): Promise<PluginManifest> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Plugin sandbox did not load within ${LOAD_TIMEOUT_MS} ms`)), LOAD_TIMEOUT_MS);
      const onReady = (manifest: PluginManifest) => { clearTimeout(timer); resolve(manifest); };
      this.pending.set('ready', { resolve: (value) => onReady(value as PluginManifest), reject });
    });
  }

  private handleLine(line: string): void {
    let message: WireMessage;
    try { message = JSON.parse(line) as WireMessage; } catch { return; }
    if (message.type === 'ready' && message.plugin) {
      const pending = this.pending.get('ready');
      if (pending) { this.pending.delete('ready'); pending.resolve(message.plugin); }
      return;
    }
    if (message.type === 'fatal' && message.error) {
      const pending = this.pending.get('ready');
      if (pending) { this.pending.delete('ready'); pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code })); }
      return;
    }
    if (message.type === 'workspace') { void this.handleWorkspace(message); return; }
    if (message.type !== 'result' || !message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.cleanup?.();
    if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code, details: message.error.details }));
    else pending.resolve(message.value);
  }

  private async handleWorkspace(message: WireMessage): Promise<void> {
    const pending = message.invokeId ? this.pending.get(message.invokeId) : undefined;
    const requestId = message.requestId;
    try {
      if (!pending?.context || !requestId || !message.operation || typeof message.path !== 'string') throw new Error('Invalid plugin workspace request');
      const workspace = pending.context.workspace ?? createPluginWorkspace(pending.context);
      const value = message.operation === 'readText'
        ? await workspace.readText(message.path)
        : await workspace.writeText(message.path, message.content ?? '', message.options);
      this.send({ type: 'workspace_result', invokeId: message.invokeId, requestId, value });
    } catch (error) {
      this.send({ type: 'workspace_result', invokeId: message.invokeId, requestId, error: serializeError(error) });
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.child.stdin.destroyed) return;
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* child exit is handled by the exit listener */ }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) { pending.cleanup?.(); pending.reject(error); }
    this.pending.clear();
  }
}

function sandboxEnvironment(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'TMP', 'TEMP'];
  return Object.fromEntries(keep.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key] as string]]));
}

function assertPluginSourceSafe(source: string, file: string): void {
  for (const capability of FORBIDDEN_PLUGIN_CAPABILITIES) {
    if (capability.pattern.test(source)) throw forbidden(`Plugin ${file} uses forbidden capability: ${capability.name}. Use host-mediated APIs instead.`);
  }
}
function serializeError(error: unknown): { message: string; code?: string; details?: unknown } {
  const value = error as { message?: unknown; code?: unknown; details?: unknown };
  return { message: typeof value?.message === 'string' ? value.message : String(error), ...(typeof value?.code === 'string' ? { code: value.code } : {}), ...(value?.details === undefined ? {} : { details: value.details }) };
}
function diagnostic(code: PluginLoadDiagnostic['code'], message: string, source?: string, pluginId?: string): PluginLoadDiagnostic {
  return { code, message, recoverable: true, ...(source ? { source } : {}), ...(pluginId ? { pluginId } : {}) };
}
function invalid(message: string): Error & { pluginValidation: true } { return Object.assign(new Error(message), { pluginValidation: true as const }); }
function forbidden(message: string): Error & { pluginValidation: true; pluginCapability: true } { return Object.assign(invalid(message), { pluginCapability: true as const }); }
function isValidationError(error: unknown): boolean { return typeof error === 'object' && error !== null && 'pluginValidation' in error; }
function isForbiddenCapabilityError(error: unknown): boolean { return typeof error === 'object' && error !== null && 'pluginCapability' in error; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
