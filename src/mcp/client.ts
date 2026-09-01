import { createHash } from 'node:crypto';
import type { JsonSchema, ToolDefinition, ToolRiskCategory } from '../tools/types.js';

export interface McpTransport {
  request(method: string, params?: unknown): Promise<unknown>;
  close?(): Promise<void>;
  diagnostics?(): { stderrTail?: string; pid?: number; closed?: boolean; exited?: boolean; error?: string };
}

export type McpRisk = 'readonly' | 'workspace_mutation' | 'external_side_effect' | 'unknown';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  risk?: McpRisk | 'read' | 'write' | 'external';
  readonly?: boolean;
  timeoutMs?: number;
}

export interface McpServer {
  name: string;
  transport: McpTransport;
  tools: McpTool[];
  connectedAt: string;
  activeCalls: number;
  protocolVersion?: string;
  version?: string;
  restartCount: number;
}

export interface McpConfiguredServer {
  name: string;
  command: string;
  cwd?: string;
  enabled: boolean;
  reason?: string;
}

export interface McpCatalogEntry {
  qualifiedName: string;
  server: string;
  name: string;
  description: string;
  risk: McpRisk;
  schema: JsonSchema;
}

export interface McpReloadState {
  status: 'idle' | 'scheduled' | 'applied' | 'failed';
  requested: boolean;
  changed: boolean;
  changes: McpToolChange[];
  at?: string;
  error?: string;
}

export interface McpStatus {
  configured: McpConfiguredServer[];
  servers: McpServerStatus[];
  toolCatalog: McpCatalogEntry[];
  catalogHash: string;
  reload: McpReloadState;
}

export function emptyMcpStatus(configured: McpConfiguredServer[] = [], reload: McpReloadState = { status: 'idle', requested: false, changed: false, changes: [] }): McpStatus {
  return { configured, servers: [], toolCatalog: [], catalogHash: catalogHash([]), reload };
}

export function configuredMcpStatus(servers: Array<{ name: string; command: string; cwd?: string }>, trusted: boolean, reload: McpReloadState = { status: 'idle', requested: false, changed: false, changes: [] }): McpStatus {
  return emptyMcpStatus(servers.map((server) => ({ name: server.name, command: server.command, ...(server.cwd ? { cwd: server.cwd } : {}), enabled: trusted, ...(trusted ? {} : { reason: 'workspace_untrusted' }) })), reload);
}

export interface McpToolChange {
  qualifiedName: string;
  kind: 'added' | 'removed' | 'risk_changed' | 'schema_changed' | 'description_changed';
}

export interface McpReloadReport {
  server: string;
  changed: boolean;
  changes: McpToolChange[];
  toolCount: number;
}

export interface McpServerStatus {
  name: string;
  state: 'connected' | 'failed' | 'closed';
  toolCount: number;
  activeCalls: number;
  connectedAt: string;
  protocolVersion?: string;
  version?: string;
  restartCount?: number;
  error?: string;
  stderrTail?: string;
  pid?: number;
}

export interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class McpError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'McpError';
  }
}

export function safeMcpName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  if (!normalized) throw new Error('MCP name cannot be empty');
  return normalized;
}

export class McpManager {
  private readonly servers = new Map<string, McpServer>();
  private readonly failures = new Map<string, { error: string; restartCount: number; connectedAt: string }>();
  private reloadState: McpReloadState = { status: 'idle', requested: false, changed: false, changes: [] };
  constructor(private readonly defaultTimeoutMs = 30_000) {}

  async connect(name: string, transport: McpTransport): Promise<McpServer> {
    const serverName = safeMcpName(name);
    const previous = this.servers.get(serverName);
    if (previous?.activeCalls) throw new McpError('mcp_connect_active', `MCP server cannot be replaced while ${previous.activeCalls} call(s) are active.`);
    let candidate: McpServer;
    try {
      candidate = await this.discover(serverName, transport);
      this.validateCandidate(candidate);
    } catch (error) {
      if (previous) this.failures.delete(serverName);
      else this.recordFailure(serverName, error);
      await transport.close?.().catch(() => undefined);
      throw error;
    }
    if (previous) {
      try {
        await previous.transport.close?.();
      } catch (error) {
        await candidate.transport.close?.().catch(() => undefined);
        throw new McpError('mcp_connect_close_failed', `Could not close the previous MCP server: ${messageOf(error)}`);
      }
    }
    candidate.restartCount = previous?.restartCount ?? this.failures.get(serverName)?.restartCount ?? 0;
    this.failures.delete(serverName);
    this.servers.set(serverName, candidate);
    return candidate;
  }

  async restart(name: string, transport: McpTransport): Promise<McpServer> {
    const serverName = safeMcpName(name);
    const current = this.servers.get(serverName);
    if (current?.activeCalls) throw new McpError('mcp_restart_active', `MCP server cannot restart while ${current.activeCalls} call(s) are active.`);
    const restartCount = (current?.restartCount ?? this.failures.get(serverName)?.restartCount ?? 0) + 1;
    const server = await this.connect(serverName, transport);
    server.restartCount = restartCount;
    return server;
  }

  async reload(name: string, transport: McpTransport): Promise<McpReloadReport> {
    const serverName = safeMcpName(name);
    const previous = this.servers.get(serverName);
    if (!previous) throw new McpError('mcp_server_not_connected', `MCP server is not connected: ${serverName}`);
    if (previous.activeCalls > 0) throw new McpError('mcp_reload_active', `MCP server cannot reload while ${previous.activeCalls} call(s) are active.`);
    const before = this.toolSnapshot();
    let candidate: McpServer;
    try {
      candidate = await this.discover(serverName, transport);
      this.validateCandidate(candidate);
    } catch (error) {
      this.reloadState = { status: 'failed', requested: true, changed: false, changes: [], at: new Date().toISOString(), error: messageOf(error) };
      await transport.close?.().catch(() => undefined);
      throw error;
    }
    try {
      await previous.transport.close?.();
    } catch (error) {
      await candidate.transport.close?.().catch(() => undefined);
      throw new McpError('mcp_reload_close_failed', `Could not close the previous MCP server: ${messageOf(error)}`);
    }
    candidate.restartCount = previous.restartCount;
    this.failures.delete(serverName);
    this.servers.set(serverName, candidate);
    const after = this.toolSnapshot();
    const changes = diffSnapshots(before, after);
    this.reloadState = { status: 'applied', requested: true, changed: changes.length > 0, changes, at: new Date().toISOString() };
    return { server: serverName, changed: changes.length > 0, changes, toolCount: candidate.tools.length };
  }

  async disconnect(name: string): Promise<void> {
    const serverName = safeMcpName(name);
    const server = this.servers.get(serverName);
    this.servers.delete(serverName);
    this.failures.delete(serverName);
    await server?.transport.close?.();
  }

  async disconnectAll(): Promise<void> {
    const results = await Promise.allSettled([...this.servers.keys()].map((name) => this.disconnect(name)));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  serversStatus(): McpServerStatus[] {
    const connected = [...this.servers.values()].map((server) => {
      const diagnostics = server.transport.diagnostics?.();
      return {
        name: server.name,
        state: diagnostics?.closed ? 'closed' as const : diagnostics?.exited ? 'failed' as const : 'connected' as const,
        toolCount: server.tools.length,
        activeCalls: server.activeCalls,
        connectedAt: server.connectedAt,
        ...(server.protocolVersion ? { protocolVersion: server.protocolVersion } : {}),
        ...(server.version ? { version: server.version } : {}),
        restartCount: server.restartCount,
        ...diagnostics,
      };
    });
    const failed = [...this.failures.entries()].map(([name, failure]) => ({ name, state: 'failed' as const, toolCount: 0, activeCalls: 0, connectedAt: failure.connectedAt, restartCount: failure.restartCount, error: failure.error }));
    return [...connected, ...failed];
  }

  requestReload(): void {
    this.reloadState = { status: 'scheduled', requested: true, changed: false, changes: [], at: new Date().toISOString() };
  }

  markReloadApplied(changes: McpToolChange[] = []): void {
    this.reloadState = { status: 'applied', requested: true, changed: changes.length > 0, changes, at: new Date().toISOString() };
  }

  markReloadFailed(error: unknown): void {
    this.reloadState = { status: 'failed', requested: true, changed: false, changes: [], at: new Date().toISOString(), error: messageOf(error) };
  }

  status(configured: McpConfiguredServer[] = [], reload: McpReloadState = this.reloadState): McpStatus {
    const toolCatalog = this.catalogSnapshot().tools;
    return { configured, servers: this.serversStatus(), toolCatalog, catalogHash: catalogHash(toolCatalog), reload };
  }

  health(): McpServerStatus[] {
    return this.serversStatus();
  }

  catalogSnapshot(): { version: 1; hash: string; tools: McpCatalogEntry[] } {
    const tools: McpCatalogEntry[] = [];
    for (const server of this.servers.values()) for (const tool of server.tools) {
      const risk = normalizeMcpRisk(tool.risk, tool.readonly);
      tools.push({ qualifiedName: qualifiedToolName(server.name, tool.name), server: server.name, name: tool.name, description: tool.description ?? '', risk, schema: tool.inputSchema ?? { type: 'object' } });
    }
    return { version: 1, hash: catalogHash(tools), tools };
  }

  definitions(): ToolDefinition[] {
    this.validateAll();
    const result: ToolDefinition[] = [];
    for (const server of this.servers.values()) for (const tool of server.tools) {
      const name = qualifiedToolName(server.name, tool.name);
      result.push({
        name,
        description: tool.description ?? `MCP tool ${tool.name}`,
        parameters: tool.inputSchema ?? { type: 'object' },
        risk: toolRisk(normalizeMcpRisk(tool.risk, tool.readonly)),
        readonly: normalizeMcpRisk(tool.risk, tool.readonly) === 'readonly',
        riskCategory: normalizeMcpRisk(tool.risk, tool.readonly) as ToolRiskCategory,
        ...(tool.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
        handler: async (args, context) => this.call(name, args, { signal: context.signal, timeoutMs: tool.timeoutMs }),
      });
    }
    return result;
  }

  async call(qualifiedName: string, args: unknown, options: McpCallOptions = {}): Promise<unknown> {
    const separator = qualifiedName.indexOf('__', 6);
    if (!qualifiedName.startsWith('mcp__') || separator < 0) throw new McpError('mcp_tool_name_invalid', `Invalid MCP tool name: ${qualifiedName}`);
    const serverName = qualifiedName.slice(5, separator);
    const toolName = qualifiedName.slice(separator + 2);
    const server = this.servers.get(serverName);
    const tool = server?.tools.find((item) => safeMcpName(item.name) === toolName);
    if (!server || !tool) throw new McpError('mcp_tool_not_found', `Unknown MCP tool: ${qualifiedName}`);
    server.activeCalls += 1;
    try {
      const response = await requestWithControl(server.transport, 'tools/call', { name: tool.name, arguments: args }, options.signal, options.timeoutMs ?? tool.timeoutMs ?? this.defaultTimeoutMs, () => this.disconnect(serverName));
      const result = response as { content?: unknown; isError?: boolean; error?: { message?: string } };
      if (result?.isError) throw new McpError('mcp_tool_failed', result.error?.message ?? `MCP tool failed: ${qualifiedName}`);
      return result?.content ?? response;
    } finally {
      server.activeCalls = Math.max(0, server.activeCalls - 1);
    }
  }

  private async discover(name: string, transport: McpTransport): Promise<McpServer> {
    try {
      const initialize = await requestWithControl(transport, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'nju-agent', version: '0.1.0' } }, undefined, this.defaultTimeoutMs, () => transport.close?.()) as { protocolVersion?: unknown; serverInfo?: { version?: unknown } };
      const response = await requestWithControl(transport, 'tools/list', {}, undefined, this.defaultTimeoutMs, () => transport.close?.()) as { tools?: McpTool[] };
      const tools = Array.isArray(response?.tools) ? response.tools.filter((tool) => typeof tool?.name === 'string').map(normalizeMcpTool) : [];
      return { name, transport, tools, connectedAt: new Date().toISOString(), activeCalls: 0, ...(typeof initialize?.protocolVersion === 'string' ? { protocolVersion: initialize.protocolVersion } : {}), ...(typeof initialize?.serverInfo?.version === 'string' ? { version: initialize.serverInfo.version } : {}), restartCount: 0 };
    } catch (error) {
      await transport.close?.().catch(() => undefined);
      throw error;
    }
  }

  private recordFailure(serverName: string, error: unknown): void {
    const previous = this.failures.get(serverName);
    this.failures.set(serverName, {
      error: messageOf(error),
      connectedAt: previous?.connectedAt ?? new Date().toISOString(),
      restartCount: (previous?.restartCount ?? 0) + 1,
    });
  }

  private validateCandidate(candidate: McpServer): void {
    const names = new Set<string>();
    for (const tool of candidate.tools) {
      const qualified = qualifiedToolName(candidate.name, tool.name);
      if (names.has(qualified)) throw new McpError('mcp_tool_name_collision', `MCP tool name collision: ${qualified}`);
      names.add(qualified);
    }
    for (const server of this.servers.values()) {
      if (server.name === candidate.name) continue;
      for (const tool of server.tools) for (const candidateTool of candidate.tools) {
        if (qualifiedToolName(server.name, tool.name) === qualifiedToolName(candidate.name, candidateTool.name)) throw new McpError('mcp_tool_name_collision', `MCP tool name collision: ${qualifiedToolName(candidate.name, candidateTool.name)}`);
      }
    }
  }

  private validateAll(): void {
    const seen = new Set<string>();
    for (const server of this.servers.values()) for (const tool of server.tools) {
      const name = qualifiedToolName(server.name, tool.name);
      if (seen.has(name)) throw new McpError('mcp_tool_name_collision', `MCP tool name collision: ${name}`);
      seen.add(name);
    }
  }

  private toolSnapshot(): Map<string, string> {
    const snapshot = new Map<string, string>();
    for (const server of this.servers.values()) for (const tool of server.tools) snapshot.set(qualifiedToolName(server.name, tool.name), stableJson({ description: tool.description ?? '', risk: normalizeMcpRisk(tool.risk, tool.readonly), schema: tool.inputSchema ?? { type: 'object' } }));
    return snapshot;
  }
}

function qualifiedToolName(serverName: string, toolName: string): string { return `mcp__${serverName}__${safeMcpName(toolName)}`; }

export function normalizeMcpRisk(value: McpTool['risk'], readonly?: boolean): McpRisk {
  if (value === 'readonly' || value === 'read') return 'readonly';
  if (value === 'workspace_mutation' || value === 'write') return 'workspace_mutation';
  if (value === 'external_side_effect' || value === 'external') return 'external_side_effect';
  return readonly === true ? 'readonly' : 'unknown';
}

function toolRisk(risk: McpRisk): 'read' | 'write' | 'external' {
  return risk === 'readonly' ? 'read' : risk === 'workspace_mutation' ? 'write' : 'external';
}

export function catalogHash(tools: McpCatalogEntry[]): string {
  return createHash('sha256').update(stableJson(tools)).digest('hex');
}

function normalizeMcpTool(value: McpTool): McpTool {
  const risk = normalizeMcpRisk(value.risk, value.readonly);
  const inputSchema = value.inputSchema && typeof value.inputSchema === 'object' && !Array.isArray(value.inputSchema) ? value.inputSchema : { type: 'object' };
  return {
    name: value.name,
    ...(typeof value.description === 'string' ? { description: value.description.slice(0, 2_000) } : {}),
    inputSchema,
    risk,
    readonly: risk === 'readonly',
    ...(typeof value.timeoutMs === 'number' && Number.isInteger(value.timeoutMs) && value.timeoutMs > 0 ? { timeoutMs: Math.min(value.timeoutMs, 300_000) } : {}),
  };
}

async function requestWithControl(transport: McpTransport, method: string, params: unknown, signal: AbortSignal | undefined, timeoutMs: number, onInterrupted: () => void | Promise<void>): Promise<unknown> {
  if (signal?.aborted) {
    await onInterrupted();
    throw new McpError('mcp_request_cancelled', `MCP request cancelled: ${method}`);
  }
  let request: Promise<unknown>;
  try { request = transport.request(method, params); }
  catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); callback(); };
    const onAbort = () => finish(() => { void Promise.resolve(onInterrupted()).catch(() => undefined); reject(new McpError('mcp_request_cancelled', `MCP request cancelled: ${method}`)); });
    const timer = setTimeout(() => finish(() => { void Promise.resolve(onInterrupted()).catch(() => undefined); reject(new McpError('mcp_request_timeout', `MCP request timed out: ${method}`)); }), Math.max(1, timeoutMs));
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    request.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))));
  });
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): McpToolChange[] {
  const changes: McpToolChange[] = [];
  for (const [name, previous] of before) {
    const current = after.get(name);
    if (current === undefined) { changes.push({ qualifiedName: name, kind: 'removed' }); continue; }
    const beforeValue = JSON.parse(previous) as { description: string; risk: string; schema: unknown };
    const afterValue = JSON.parse(current) as { description: string; risk: string; schema: unknown };
    if (beforeValue.risk !== afterValue.risk) changes.push({ qualifiedName: name, kind: 'risk_changed' });
    if (stableJson(beforeValue.schema) !== stableJson(afterValue.schema)) changes.push({ qualifiedName: name, kind: 'schema_changed' });
    if (beforeValue.description !== afterValue.description) changes.push({ qualifiedName: name, kind: 'description_changed' });
  }
  for (const name of after.keys()) if (!before.has(name)) changes.push({ qualifiedName: name, kind: 'added' });
  return changes;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
