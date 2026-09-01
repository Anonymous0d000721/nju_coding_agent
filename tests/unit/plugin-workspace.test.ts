import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolExecutor } from '../../src/tools/executor.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { ToolDefinition } from '../../src/tools/types.js';

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-plugin-workspace-'));
  const mutations: unknown[] = [];
  const tool: ToolDefinition = {
    name: 'plugin_write_note',
    description: 'Write a note through the host workspace capability.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    risk: 'write',
    readonly: false,
    handler: async (args, ctx) => ctx.workspace!.writeText((args as { path: string }).path, (args as { content: string }).content),
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  return { root, mutations, executor: new ToolExecutor(registry, { workspaceRoot: root, permissionMode: 'yolo', onFileMutation: (mutation) => { mutations.push(mutation); } }) };
}

describe('plugin workspace capability', () => {
  it('routes plugin writes through path guard and mutation journal callback', async () => {
    const { root, mutations, executor } = await createFixture();
    await fs.mkdir(path.join(root, 'notes'));
    const [result] = await executor.executeBatch([{ id: 'plugin-write', name: 'plugin_write_note', argumentsJson: JSON.stringify({ path: 'notes/today.md', content: 'hello' }) }]);
    expect(result).toMatchObject({ ok: true, details: { relativePath: 'notes/today.md' } });
    expect(await fs.readFile(path.join(root, 'notes', 'today.md'), 'utf8')).toBe('hello');
    expect(mutations).toHaveLength(1);
  });

  it('rejects plugin workspace access outside the workspace and to protected paths', async () => {
    const { executor } = await createFixture();
    const [outside] = await executor.executeBatch([{ id: 'outside', name: 'plugin_write_note', argumentsJson: JSON.stringify({ path: '../outside.md', content: 'no' }) }]);
    const [protectedPath] = await executor.executeBatch([{ id: 'protected', name: 'plugin_write_note', argumentsJson: JSON.stringify({ path: '.env', content: 'no' }) }]);
    expect(outside.error?.code).toBe('path_outside_workspace');
    expect(protectedPath.error?.code).toBe('permission_denied');
  });

  it('denies plugin writes in strict mode before the handler runs', async () => {
    const { root } = await createFixture();
    let called = false;
    const registry = new ToolRegistry();
    registry.register({
      name: 'plugin_write_note', description: 'write', parameters: { type: 'object', properties: {}, additionalProperties: false }, risk: 'write', readonly: false,
      handler: () => { called = true; return 'bad'; },
    });
    const [result] = await new ToolExecutor(registry, { workspaceRoot: root, permissionMode: 'strict' }).executeBatch([{ id: 'strict', name: 'plugin_write_note', argumentsJson: '{}' }]);
    expect(result.error?.code).toBe('permission_denied');
    expect(called).toBe(false);
  });

  it('does not expose write capability to a read-only handler', async () => {
    const { root } = await createFixture();
    const registry = new ToolRegistry();
    registry.register({
      name: 'plugin_read_only',
      description: 'read only',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      risk: 'read',
      readonly: true,
      handler: (_args, ctx) => ({ hasWriteText: typeof ctx.workspace?.writeText === 'function' }),
    });
    const [result] = await new ToolExecutor(registry, { workspaceRoot: root, permissionMode: 'yolo' }).executeBatch([{ id: 'readonly', name: 'plugin_read_only', argumentsJson: '{}' }]);
    expect(result).toMatchObject({ ok: true, details: { hasWriteText: false } });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('forwards cancellation to plugin handlers', async () => {
    const { root } = await createFixture();
    const controller = new AbortController();
    let observed = false;
    const registry = new ToolRegistry();
    registry.register({
      name: 'plugin_wait', description: 'wait', parameters: { type: 'object', properties: {}, additionalProperties: false }, risk: 'read', readonly: true,
      handler: (_args, ctx) => new Promise((_resolve, reject) => ctx.signal?.addEventListener('abort', () => { observed = true; reject(Object.assign(new Error('cancelled'), { code: 'user_cancelled' })); }, { once: true })),
    });
    const pending = new ToolExecutor(registry, { workspaceRoot: root }).executeBatch([{ id: 'cancel', name: 'plugin_wait', argumentsJson: '{}' }], controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const [result] = await pending;
    expect(result.error?.code).toBe('user_cancelled');
    expect(observed).toBe(true);
  });
});
