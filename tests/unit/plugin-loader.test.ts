import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadUserPlugins, pluginTools } from '../../src/plugins/loader.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-plugin-'));
  const directory = path.join(root, '.nju-agent', 'plugins');
  await fs.mkdir(directory, { recursive: true });
  return { root, directory };
}

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
      tools: [{ name: 'demo_tool', description: 'demo', risk: 'read', readonly: true, parameters: { type: 'object' }, handler: () => 'ok' }]
    };`, 'utf8');
    const plugins = await loadUserPlugins(root, true);
    expect(plugins).toHaveLength(1);
    expect(pluginTools(plugins).map((tool) => tool.name)).toEqual(['demo_tool']);
  });

  it('reloads an updated module when requested', async () => {
    const { root, directory } = await fixture();
    const file = path.join(directory, 'demo.mjs');
    await fs.writeFile(file, "export default { id: 'demo', tools: [] };", 'utf8');
    expect((await loadUserPlugins(root, true))[0]?.id).toBe('demo');
    await fs.writeFile(file, "export default { id: 'demo-v2', tools: [] };", 'utf8');
    expect((await loadUserPlugins(root, true, true))[0]?.id).toBe('demo-v2');
  });
});
