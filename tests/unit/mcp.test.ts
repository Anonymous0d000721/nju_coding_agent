import { describe, expect, it } from 'vitest';
import { McpManager, safeMcpName, type McpTransport } from '../../src/mcp/client.js';
import { createStdioTransport } from '../../src/mcp/stdio.js';
import { registerMcpTools } from '../../src/mcp/registry-adapter.js';
import { ToolRegistry } from '../../src/tools/registry.js';

function transport(): McpTransport {
  return { request: async (method) => method === 'tools/list' ? { tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' }, risk: 'read' }] } : method === 'tools/call' ? { content: [{ type: 'text', text: 'ok' }] } : { protocolVersion: '2024-11-05' } };
}

describe('McpManager', () => {
  it('talks to the dependency-free mock stdio server', async () => {
    const transport = createStdioTransport({ command: process.execPath, args: ['examples/mock-mcp-server.mjs'], cwd: process.cwd() });
    const manager = new McpManager();
    await manager.connect('demo', transport);
    const tool = manager.definitions()[0];
    await expect(tool?.handler({ text: 'hello' }, {} as never)).resolves.toEqual([{ type: 'text', text: 'hello' }]);
    await manager.disconnectAll();
  });
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

  it('rejects duplicate normalized tool names before exposing definitions', async () => {
    const manager = new McpManager();
    const duplicate: McpTransport = { request: async (method) => method === 'tools/list' ? { tools: [{ name: 'read.file' }, { name: 'read file' }] } : {} };
    await expect(manager.connect('same', duplicate)).rejects.toMatchObject({ code: 'mcp_tool_name_collision' });
    expect(manager.definitions()).toEqual([]);
  });

  it('reloads atomically and reports tool definition changes', async () => {
    const manager = new McpManager();
    let closed = false;
    const oldTransport: McpTransport = { request: async (method) => method === 'tools/list' ? { tools: [{ name: 'read', description: 'old', risk: 'read' }] } : {}, close: async () => { closed = true; } };
    await manager.connect('demo', oldTransport);
    const report = await manager.reload('demo', { request: async (method) => method === 'tools/list' ? { tools: [{ name: 'read', description: 'new', risk: 'write' }, { name: 'extra', risk: 'external' }] } : {}, close: async () => undefined });
    expect(report).toMatchObject({ server: 'demo', changed: true, toolCount: 2 });
    expect(report.changes).toEqual(expect.arrayContaining([
      { qualifiedName: 'mcp__demo__read', kind: 'risk_changed' },
      { qualifiedName: 'mcp__demo__read', kind: 'description_changed' },
      { qualifiedName: 'mcp__demo__extra', kind: 'added' },
    ]));
    expect(closed).toBe(true);
    expect(manager.definitions().map((tool) => tool.name)).toEqual(['mcp__demo__read', 'mcp__demo__extra']);
  });

  it('reports schema changes during reload', async () => {
    const manager = new McpManager();
    await manager.connect('schema', { request: async (method) => method === 'tools/list' ? { tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, risk: 'read' }] } : {} });
    const report = await manager.reload('schema', { request: async (method) => method === 'tools/list' ? { tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'number' } } }, risk: 'read' }] } : {} });
    expect(report.changes).toContainEqual({ qualifiedName: 'mcp__schema__lookup', kind: 'schema_changed' });
  });

  it('keeps the old server when reload discovery fails', async () => {
    const manager = new McpManager();
    let oldClosed = false;
    await manager.connect('demo', { request: async (method) => method === 'tools/list' ? { tools: [{ name: 'read', risk: 'read' }] } : {}, close: async () => { oldClosed = true; } });
    await expect(manager.reload('demo', { request: async () => { throw new Error('reload failed'); }, close: async () => undefined })).rejects.toThrow('reload failed');
    expect(oldClosed).toBe(false);
    expect(manager.definitions()[0]?.name).toBe('mcp__demo__read');
  });

  it('rejects reload while a tool call is active', async () => {
    let release!: () => void;
    const manager = new McpManager();
    await manager.connect('demo', { request: async (method) => {
      if (method === 'initialize') return { protocolVersion: '2024-11-05' };
      if (method === 'tools/list') return { tools: [{ name: 'slow', risk: 'read' }] };
      await new Promise<void>((resolve) => { release = resolve; });
      return { content: 'done' };
    } });
    const call = manager.call('mcp__demo__slow', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(manager.reload('demo', transport())).rejects.toMatchObject({ code: 'mcp_reload_active' });
    release();
    await expect(call).resolves.toBe('done');
  });

  it('normalizes untrusted tool metadata to safe defaults and exposes lifecycle status', async () => {
    const manager = new McpManager();
    await manager.connect('status server', {
      request: async (method) => method === 'tools/list' ? { tools: [{ name: 'opaque', risk: 'not-a-risk', inputSchema: 'not-a-schema', description: 'x'.repeat(3_000), timeoutMs: -1 }] } : {},
      diagnostics: () => ({ pid: 42, stderrTail: 'warning' }),
    });
    const definition = manager.definitions()[0];
    expect(definition).toMatchObject({ risk: 'external', readonly: false, parameters: { type: 'object' } });
    expect(definition?.description).toHaveLength(2_000);
    expect(manager.serversStatus()).toMatchObject([{ name: 'status_server', state: 'connected', toolCount: 1, activeCalls: 0, pid: 42, stderrTail: 'warning' }]);
  });

  it('times out and cancels calls while releasing the server slot', async () => {
    const manager = new McpManager(5);
    await manager.connect('slow', { request: async (method) => method === 'initialize' ? {} : method === 'tools/list' ? { tools: [{ name: 'wait', risk: 'read' }] } : new Promise(() => undefined) });
    await expect(manager.call('mcp__slow__wait', {})).rejects.toMatchObject({ code: 'mcp_request_timeout' });
    expect(manager.serversStatus()).toEqual([]);

    const controller = new AbortController();
    const cancelManager = new McpManager(100);
    await cancelManager.connect('cancel', { request: async (method) => method === 'initialize' ? {} : method === 'tools/list' ? { tools: [{ name: 'wait', risk: 'read' }] } : new Promise(() => undefined) });
    const pending = cancelManager.call('mcp__cancel__wait', {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'mcp_request_cancelled' });
    expect(cancelManager.serversStatus()).toEqual([]);
  });

  it('exposes configured, health, catalog, and reload state without replacing the catalog silently', async () => {
    const manager = new McpManager();
    await manager.connect('host', transport());
    const status = manager.status([{ name: 'host', command: 'node', cwd: '.' , enabled: true }]);
    expect(status).toMatchObject({ configured: [{ name: 'host', enabled: true }], servers: [{ name: 'host', state: 'connected', protocolVersion: '2024-11-05' }], toolCatalog: [{ qualifiedName: 'mcp__host__read_file', risk: 'readonly' }], reload: { status: 'idle' } });
    expect(status.catalogHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manager.health()).toEqual(status.servers);
    manager.requestReload();
    expect(manager.status().reload).toMatchObject({ status: 'scheduled', requested: true });
    await manager.reload('host', { request: async (method) => method === 'tools/list' ? { tools: [{ name: 'new_tool', risk: 'external_side_effect' }] } : { protocolVersion: '2024-11-05' } });
    expect(manager.status().reload).toMatchObject({ status: 'applied', changed: true });
    expect(manager.definitions().map((tool) => tool.name)).toEqual(['mcp__host__new_tool']);
  });

  it('isolates failed servers and tracks restart health independently', async () => {
    const manager = new McpManager();
    await expect(manager.connect('broken', { request: async () => { throw new Error('broken server'); }, close: async () => undefined })).rejects.toThrow('broken server');
    await manager.connect('healthy', transport());
    expect(manager.health()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'broken', state: 'failed', error: 'broken server' }),
      expect.objectContaining({ name: 'healthy', state: 'connected' }),
    ]));
    await manager.restart('healthy', transport());
    expect(manager.health()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'healthy', state: 'connected', restartCount: 1 })]));
  });

  it('registers discovered tools through the host registry boundary', async () => {
    const manager = new McpManager();
    await manager.connect('host', transport());
    const registry = new ToolRegistry();
    expect(registerMcpTools(manager, registry)).toBe(1);
    expect(registry.get('mcp__host__read_file')?.risk).toBe('read');
    expect(registry.get('mcp__host__read_file')?.riskCategory).toBe('readonly');
  });
});

