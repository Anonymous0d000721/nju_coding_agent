import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadUserPluginReport, loadUserPlugins, pluginTools } from '../../src/plugins/loader.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-plugin-'));
  const directory = path.join(root, '.nju-agent', 'plugins');
  await fs.mkdir(directory, { recursive: true });
  return { root, directory };
}

const readSchema = '{ type: \'object\', properties: {}, additionalProperties: false }';

describe('user plugin loader', () => {
  it('does not load plugins from an untrusted workspace', async () => {
    const { root, directory } = await fixture();
    await fs.writeFile(path.join(directory, 'demo.mjs'), 'export default { id: "demo", tools: [] };', 'utf8');
    expect(await loadUserPlugins(root, false)).toEqual([]);
  });

  it('loads standard tools from trusted workspace plugins', async () => {
    const { root, directory } = await fixture();
    await fs.writeFile(path.join(directory, 'demo.mjs'), `export default {
      id: 'demo',
      version: '1.0.0',
      tools: [{ name: 'demo_tool', description: 'demo', risk: 'read', readonly: true, parameters: ${readSchema}, handler: () => 'ok' }]
    };`, 'utf8');
    const plugins = await loadUserPlugins(root, true);
    expect(plugins).toHaveLength(1);
    expect(pluginTools(plugins).map((tool) => tool.name)).toEqual(['demo_tool']);
    expect(plugins[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reloads an updated module when requested', async () => {
    const { root, directory } = await fixture();
    const file = path.join(directory, 'demo.mjs');
    await fs.writeFile(file, "export default { id: 'demo', tools: [] };", 'utf8');
    expect((await loadUserPlugins(root, true))[0]?.id).toBe('demo');
    await fs.writeFile(file, "export default { id: 'demo-v2', tools: [] };", 'utf8');
    expect((await loadUserPlugins(root, true, true))[0]?.id).toBe('demo-v2');
  });

  it('runs handlers in a permission-restricted child and mediates workspace access', async () => {
    const { root, directory } = await fixture();
    await fs.writeFile(path.join(directory, 'demo.mjs'), `export default {
      id: 'demo',
      tools: [{ name: 'demo_tool', description: 'demo', risk: 'write', readonly: false, parameters: ${readSchema}, handler: async (_args, ctx) => ctx.workspace.writeText('note.md', 'sandboxed') }]
    };`, 'utf8');
    const plugins = await loadUserPlugins(root, true);
    const tool = plugins[0]?.tools[0];
    await expect(tool?.handler({}, { workspaceRoot: root })).resolves.toMatchObject({ relativePath: 'note.md' });
    await expect(fs.readFile(path.join(root, 'note.md'), 'utf8')).resolves.toBe('sandboxed');
    await plugins[0]?.dispose?.();
  });

  it('enforces child permission boundaries for obfuscated filesystem access', async () => {
    const { root, directory } = await fixture();
    const secret = path.join(root, 'host-secret.txt');
    await fs.writeFile(secret, 'host-only', 'utf8');
    await fs.writeFile(path.join(directory, 'escape.mjs'), `export default {
      id: 'escape',
      tools: [{ name: 'escape_tool', description: 'escape', risk: 'read', readonly: true, parameters: ${readSchema}, handler: async () => {
        const fs = await import('node:' + 'fs/promises');
        return fs.readFile(${JSON.stringify(secret)}, 'utf8');
      } }]
    };`, 'utf8');
    const plugins = await loadUserPlugins(root, true);
    await expect(plugins[0]?.tools[0]?.handler({}, { workspaceRoot: root })).rejects.toThrow(/permission|denied|access/i);
    await plugins[0]?.dispose?.();
  });

  it('rejects hard-coded sensitive reads in a sandboxed plugin', async () => {
    const { root, directory } = await fixture();
    await fs.writeFile(path.join(root, '.env'), 'secret=value', 'utf8');
    await fs.writeFile(path.join(directory, 'readonly.mjs'), `export default {
      id: 'readonly',
      tools: [{ name: 'readonly_tool', description: 'read secret', risk: 'read', readonly: true, parameters: ${readSchema}, handler: async (_args, ctx) => ctx.workspace.readText('.env') }]
    };`, 'utf8');
    const plugins = await loadUserPlugins(root, true);
    const tool = plugins[0]?.tools[0];
    await expect(tool?.handler({}, { workspaceRoot: root })).rejects.toMatchObject({ code: 'sensitive_path' });
    await expect(fs.readFile(path.join(root, '.env'), 'utf8')).resolves.toBe('secret=value');
    await plugins[0]?.dispose?.();
  });

  it('does not expose writeText to a read-only sandboxed plugin', async () => {
    const { root, directory } = await fixture();
    await fs.writeFile(path.join(directory, 'readonly.mjs'), `export default {
      id: 'readonly',
      tools: [{ name: 'readonly_tool', description: 'read only', risk: 'read', readonly: true, parameters: ${readSchema}, handler: async (_args, ctx) => ({ hasWriteText: typeof ctx.workspace.writeText === 'function' }) }]
    };`, 'utf8');
    const plugins = await loadUserPlugins(root, true);
    const tool = plugins[0]?.tools[0];
    await expect(tool?.handler({}, { workspaceRoot: root })).resolves.toEqual({ hasWriteText: false });
    await expect(fs.readdir(root)).resolves.toEqual([expect.stringMatching(/^\.nju-agent$/)]);
    await plugins[0]?.dispose?.();
  });

  it('propagates cancellation into sandboxed plugin handlers', async () => {
    const { root, directory } = await fixture();
    await fs.writeFile(path.join(directory, 'wait.mjs'), `export default {
      id: 'wait',
      tools: [{ name: 'wait_tool', description: 'wait', risk: 'read', readonly: true, parameters: ${readSchema}, handler: async (_args, ctx) => new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'user_cancelled' })), { once: true })) }]
    };`, 'utf8');
    const plugins = await loadUserPlugins(root, true);
    const controller = new AbortController();
    const pending = plugins[0]!.tools[0]!.handler({}, { workspaceRoot: root, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'user_cancelled' });
    await plugins[0]?.dispose?.();
  });

  it('rejects plugins that request direct host capabilities before execution', async () => {
    const { root, directory } = await fixture();
    await fs.writeFile(path.join(directory, 'unsafe.mjs'), `import { readFile } from 'node:fs/promises';
      export default { id: 'unsafe', tools: [], readFile };`, 'utf8');
    const report = await loadUserPluginReport(root, true);
    expect(report.loaded).toEqual([]);
    expect(report.diagnostics[0]).toMatchObject({ code: 'forbidden_capability', recoverable: true });
  });

  it('fails soft when one plugin cannot load and reports a source diagnostic', async () => {
    const { root, directory } = await fixture();
    await fs.writeFile(path.join(directory, 'broken.mjs'), 'throw new Error("broken plugin");', 'utf8');
    await fs.writeFile(path.join(directory, 'good.mjs'), "export default { id: 'good', tools: [] };", 'utf8');
    const report = await loadUserPluginReport(root, true);
    expect(report.loaded.map((plugin) => plugin.id)).toEqual(['good']);
    expect(report.diagnostics).toEqual([expect.objectContaining({ code: 'load_failed', source: path.join(directory, 'broken.mjs'), recoverable: true })]);
  });

  it('rejects broad or dangerous plugin schemas without stopping other plugins', async () => {
    const { root, directory } = await fixture();
    await fs.writeFile(path.join(directory, 'broad.mjs'), `export default { id: 'broad', tools: [{ name: 'broad_tool', description: 'broad', risk: 'read', readonly: true, parameters: { type: 'object', additionalProperties: true }, handler: () => 'bad' }] };`, 'utf8');
    await fs.writeFile(path.join(directory, 'dangerous.mjs'), `export default { id: 'dangerous', tools: [{ name: 'dangerous_tool', description: 'dangerous', risk: 'read', readonly: true, parameters: { type: 'object', properties: { command: { type: 'string' } }, additionalProperties: false }, handler: () => 'bad' }] };`, 'utf8');
    await fs.writeFile(path.join(directory, 'good.mjs'), "export default { id: 'good', tools: [] };", 'utf8');
    const report = await loadUserPluginReport(root, true);
    expect(report.loaded.map((plugin) => plugin.id)).toEqual(['good']);
    expect(report.diagnostics.map((item) => item.code)).toEqual(['invalid_manifest', 'invalid_manifest']);
  });

  it('reports duplicate ids, tool names, and trusted source hashes', async () => {
    const { root, directory } = await fixture();
    await fs.writeFile(path.join(directory, 'a.mjs'), `export default { id: 'same', version: '1.0.0', tools: [{ name: 'shared_tool', description: 'a', risk: 'read', readonly: true, parameters: ${readSchema}, handler: () => 'a' }] };`, 'utf8');
    await fs.writeFile(path.join(directory, 'b.mjs'), `export default { id: 'same', version: '2.0.0', tools: [{ name: 'other_tool', description: 'b', risk: 'read', readonly: true, parameters: ${readSchema}, handler: () => 'b' }] };`, 'utf8');
    await fs.writeFile(path.join(directory, 'c.mjs'), `export default { id: 'other', version: '1.0.0', tools: [{ name: 'shared_tool', description: 'c', risk: 'read', readonly: true, parameters: ${readSchema}, handler: () => 'c' }] };`, 'utf8');
    const report = await loadUserPluginReport(root, true);
    expect(report.loaded.map((plugin) => plugin.id)).toEqual(['same']);
    expect(report.diagnostics.map((item) => item.code)).toEqual(['version_conflict', 'tool_name_conflict']);
    expect(report.trustNotices[0]).toMatchObject({ source: '.nju-agent/plugins/a.mjs', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('explains why untrusted workspaces do not load plugins', async () => {
    const { root } = await fixture();
    const report = await loadUserPluginReport(root, false);
    expect(report.loaded).toEqual([]);
    expect(report.diagnostics[0]).toMatchObject({ code: 'untrusted_workspace', recoverable: true });
  });
});
