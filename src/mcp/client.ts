import type { JsonSchema, ToolDefinition, ToolResult } from '../tools/types.js';
import type { ToolCall } from '../agent/types.js';

export interface McpTransport {
  request(method: string, params?: unknown): Promise<unknown>;
  close?(): Promise<void>;
}

export interface McpTool { name: string; description?: string; inputSchema?: JsonSchema; risk?: 'read' | 'write' | 'external'; }
export interface McpServer { name: string; transport: McpTransport; tools: McpTool[]; }

export function safeMcpName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  if (!normalized) throw new Error('MCP name cannot be empty');
  return normalized;
}

export class McpManager {
  private readonly servers = new Map<string, McpServer>();

  async connect(name: string, transport: McpTransport): Promise<McpServer> {
    const serverName = safeMcpName(name);
    await transport.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'nju-agent', version: '0.1.0' } });
    const response = await transport.request('tools/list', {}) as { tools?: McpTool[] };
    const tools = Array.isArray(response?.tools) ? response.tools.filter((tool) => typeof tool?.name === 'string') : [];
    const server = { name: serverName, transport, tools };
    this.servers.set(serverName, server);
    return server;
  }

  disconnect(name: string): Promise<void> | undefined {
    const server = this.servers.get(safeMcpName(name));
    this.servers.delete(safeMcpName(name));
    return server?.transport.close?.();
  }

  async disconnectAll(): Promise<void> {
    const servers = [...this.servers.keys()];
    for (const name of servers) await this.disconnect(name);
  }

  definitions(): ToolDefinition[] {
    const result: ToolDefinition[] = [];
    const names = new Set<string>();
    for (const server of this.servers.values()) for (const tool of server.tools) {
      const name = `mcp__${server.name}__${safeMcpName(tool.name)}`;
      if (names.has(name)) throw new Error(`MCP tool name collision: ${name}`);
      names.add(name);
      result.push({ name, description: tool.description ?? `MCP tool ${tool.name}`, parameters: tool.inputSchema ?? { type: 'object' }, risk: tool.risk ?? 'external', readonly: tool.risk === 'read', handler: async (args) => this.call(name, args) });
    }
    return result;
  }

  async call(qualifiedName: string, args: unknown): Promise<unknown> {
    const separator = qualifiedName.indexOf('__', 6);
    if (!qualifiedName.startsWith('mcp__') || separator < 0) throw new Error(`Invalid MCP tool name: ${qualifiedName}`);
    const serverName = qualifiedName.slice(5, separator);
    const toolName = qualifiedName.slice(separator + 2);
    const server = this.servers.get(serverName);
    const tool = server?.tools.find((item) => safeMcpName(item.name) === toolName);
    if (!server || !tool) throw new Error(`Unknown MCP tool: ${qualifiedName}`);
    const response = await server.transport.request('tools/call', { name: tool.name, arguments: args }) as { content?: unknown; isError?: boolean };
    if (response?.isError) throw new Error(`MCP tool failed: ${qualifiedName}`);
    return response?.content ?? response;
  }
}
