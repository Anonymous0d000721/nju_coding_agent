import { describe, expect, it } from 'vitest';
import { McpRuntime, type McpRuntimeServer } from '../../src/mcp/runtime.js';
import type { McpTransport } from '../../src/mcp/client.js';

function server(name = 'demo'): McpRuntimeServer {
  return { name, command: 'mock' };
}

function transport(tools: unknown[], closed?: () => void): McpTransport {
  return {
    request: async (method) => method === 'tools/list' ? { tools } : { protocolVersion: '2024-11-05' },
    close: async () => closed?.(),
  };
}

describe('McpRuntime', () => {
  it('reuses a connected server and reports catalog changes on reload', async () => {
    const runtime = new McpRuntime();
    let version = 1;
    const created: McpTransport[] = [];
    const result = await runtime.sync([server()], async () => {
      const next = transport(version === 1 ? [{ name: 'read', risk: 'read' }] : [{ name: 'read', risk: 'write' }, { name: 'extra', risk: 'external' }]);
      created.push(next);
      return next;
    });
    expect(result).toEqual({ changes: [{ qualifiedName: 'mcp__demo__read', kind: 'added' }], failures: [], connected: ['demo'], reloaded: [], disconnected: [] });

    version = 2;
    const reloaded = await runtime.sync([server()], async () => {
      const next = transport([{ name: 'read', risk: 'write' }, { name: 'extra', risk: 'external' }]);
      created.push(next);
      return next;
    }, true);

    expect(reloaded.failures).toEqual([]);
    expect(reloaded.changes).toEqual(expect.arrayContaining([
      { qualifiedName: 'mcp__demo__read', kind: 'risk_changed' },
      { qualifiedName: 'mcp__demo__extra', kind: 'added' },
    ]));
    expect(runtime.manager.status().reload).toMatchObject({ status: 'applied', changed: true });
    expect(created).toHaveLength(2);
    await runtime.close();
  });

  it('keeps the old server and marks reload failed when replacement discovery fails', async () => {
    const runtime = new McpRuntime();
    let oldClosed = false;
    await runtime.sync([server()], async () => transport([{ name: 'read', risk: 'read' }], () => { oldClosed = true; }));
    const result = await runtime.sync([server()], async () => ({ request: async () => { throw new Error('replacement unavailable'); } }), true);

    expect(result.failures).toHaveLength(1);
    expect(runtime.manager.definitions().map((tool) => tool.name)).toEqual(['mcp__demo__read']);
    expect(oldClosed).toBe(false);
    expect(runtime.manager.status().reload).toMatchObject({ status: 'failed', changed: false });
    await runtime.close();
    expect(oldClosed).toBe(true);
  });

  it('disconnects servers removed from configuration during reload', async () => {
    const runtime = new McpRuntime();
    let closed = false;
    await runtime.sync([server()], async () => transport([{ name: 'read', risk: 'read' }], () => { closed = true; }));
    const result = await runtime.sync([], async () => transport([]), true);

    expect(result).toEqual({ changes: [{ qualifiedName: 'mcp__demo__read', kind: 'removed' }], failures: [], connected: [], reloaded: [], disconnected: ['demo'] });
    expect(runtime.manager.serversStatus()).toEqual([]);
    expect(closed).toBe(true);
    await runtime.close();
  });
});
