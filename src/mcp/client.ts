import type { JsonSchema, ToolDefinition } from '../tools/types.js';

export interface McpTransport {
  request(method: string, params?: unknown): Promise<unknown>;
  close?(): Promise<void>;
  diagnostics?(): { stderrTail?: string; pid?: number; closed?: boolean; exited?: boolean };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  risk?: 'read' | 'write' | 'external';
  timeoutMs?: number;
}

export interface McpServer {
  name: string;
  transport: McpTransport;
  tools: McpTool[];
  connectedAt: string;
  activeCalls: number;
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
  constructor(private readonly defaultTimeoutMs = 30_000) {}

  async connect(name: string, transport: McpTransport): Promise<McpServer> {
    const serverName = safeMcpName(name);
    const previous = this.servers.get(serverName);
    if (previous?.activeCalls) throw new McpError('mcp_connect_active', `MCP server cannot be replaced while ${previous.activeCalls} call(s) are active.`);
    const candidate = await this.discover(serverName, transport);
    try {
      this.validateCandidate(candidate);
    } catch (error) {
      await candidate.transport.close?.();
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
    this.servers.set(serverName, candidate);
    return candidate;
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
      await transport.close?.().catch(() => undefined);
      throw error;
    }
    try {
      await previous.transport.close?.();
    } catch (error) {
      await candidate.transport.close?.().catch(() => undefined);
      throw new McpError('mcp_reload_close_failed', `Could not close the previous MCP server: ${messageOf(error)}`);
    }
    this.servers.set(serverName, candidate);
    const after = this.toolSnapshot();
    const changes = diffSnapshots(before, after);
    return { server: serverName, changed: changes.length > 0, changes, toolCount: candidate.tools.length };
  }

  async disconnect(name: string): Promise<void> {
    const serverName = safeMcpName(name);
    const server = this.servers.get(serverName);
    this.servers.delete(serverName);
    await server?.transport.close?.();
  }

  async disconnectAll(): Promise<void> {
    const results = await Promise.allSettled([...this.servers.keys()].map((name) => this.disconnect(name)));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  serversStatus(): McpServerStatus[] {
    return [...this.servers.values()].map((server) => ({
      name: server.name,
      state: server.transport.diagnostics?.().closed ? 'closed' : server.transport.diagnostics?.().exited ? 'failed' : 'connected',
      toolCount: server.tools.length,
      activeCalls: server.activeCalls,
      connectedAt: server.connectedAt,
      ...server.transport.diagnostics?.(),
    }));
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
        risk: tool.risk ?? 'external',
        readonly: tool.risk === 'read',
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
      await requestWithControl(transport, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'nju-agent', version: '0.1.0' } }, undefined, this.defaultTimeoutMs, () => transport.close?.());
      const response = await requestWithControl(transport, 'tools/list', {}, undefined, this.defaultTimeoutMs, () => transport.close?.()) as { tools?: McpTool[] };
      const tools = Array.isArray(response?.tools) ? response.tools.filter((tool) => typeof tool?.name === 'string').map(normalizeMcpTool) : [];
      return { name, transport, tools, connectedAt: new Date().toISOString(), activeCalls: 0 };
    } catch (error) {
      await transport.close?.().catch(() => undefined);
      throw error;
    }
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
    for (const server of this.servers.values()) for (const tool of server.tools) snapshot.set(qualifiedToolName(server.name, tool.name), stableJson({ description: tool.description ?? '', risk: tool.risk ?? 'external', schema: tool.inputSchema ?? { type: 'object' } }));
    return snapshot;
  }
}

function qualifiedToolName(serverName: string, toolName: string): string { return `mcp__${serverName}__${safeMcpName(toolName)}`; }

function normalizeMcpTool(value: McpTool): McpTool {
  const risk = value.risk === 'read' || value.risk === 'write' || value.risk === 'external' ? value.risk : 'external';
  const inputSchema = value.inputSchema && typeof value.inputSchema === 'object' && !Array.isArray(value.inputSchema) ? value.inputSchema : { type: 'object' };
  return {
    name: value.name,
    ...(typeof value.description === 'string' ? { description: value.description.slice(0, 2_000) } : {}),
    inputSchema,
    risk,
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
