import { describe, expect, it } from 'vitest';
import { McpManager, safeMcpName, type McpTransport } from '../../src/mcp/client.js';
import { registerMcpTools } from '../../src/mcp/registry-adapter.js';
import { ToolRegistry } from '../../src/tools/registry.js';

function transport(): McpTransport {
  return { request: async (method) => method === 'tools/list' ? { tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' }, risk: 'read' }] } : method === 'tools/call' ? { content: [{ type: 'text', text: 'ok' }] } : { protocolVersion: '2024-11-05' } };
}

describe('McpManager', () => {
  it('initializes, discovers and calls a normalized external tool', async () => {
    const manager = new McpManager();
    await manager.connect('Demo Server', transport());
    const definition = manager.definitions()[0];
    expect(definition?.name).toBe('mcp__demo_server__read_file');
    expect(definition?.risk).toBe('read');
    await expect(definition?.handler({ path: 'x' }, {} as never)).resolves.toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('turns protocol failures and unknown tools into explicit errors', async () => {
    const manager = new McpManager();
    await expect(manager.connect('broken', { request: async () => { throw new Error('server unavailable'); } })).rejects.toThrow('server unavailable');
    await expect(manager.call('mcp__missing__tool', {})).rejects.toThrow('Unknown MCP tool');
  });

  it('rejects duplicate normalized tool names', async () => {
    const manager = new McpManager();
    const duplicate: McpTransport = { request: async (method) => method === 'tools/list' ? { tools: [{ name: 'read.file' }, { name: 'read file' }] } : {} };
    await manager.connect('same', duplicate);
    expect(() => manager.definitions()).toThrow('collision');
  });

  it('registers discovered tools through the host registry boundary', async () => {
    const manager = new McpManager();
    await manager.connect('host', transport());
    const registry = new ToolRegistry();
    expect(registerMcpTools(manager, registry)).toBe(1);
    expect(registry.get('mcp__host__read_file')?.risk).toBe('read');
  });
});

