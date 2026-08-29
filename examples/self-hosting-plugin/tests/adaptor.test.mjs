import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const pluginUrl = pathToFileURL(resolve(fileURLToPath(new URL('..', import.meta.url)), 'nju-mcp-adaptor.mjs')).href;
const valid = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../fixtures/valid-manifest.json', import.meta.url), 'utf8'));

async function tool() {
  const module = await import(`${pluginUrl}?test=${Date.now()}-${Math.random()}`);
  return module.default.tools[0];
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'nju-plugin-'));
  await mkdir(join(root, 'fixtures'));
  await writeFile(join(root, 'fixtures', 'valid.json'), JSON.stringify(valid));
  return root;
}

describe('nju-mcp-adaptor example', () => {
  it('validates and lists a workspace-local manifest', async () => {
    const root = await workspace();
    const result = await (await tool()).handler({ manifestPath: 'fixtures/valid.json' }, { workspaceRoot: root });
    expect(result.tools.map((entry) => entry.name)).toEqual(['inventory_lookup', 'inventory_reserve']);
  });

  it('rejects outside paths and external execution fields', async () => {
    const root = await workspace();
    const adaptor = await tool();
    await expect(adaptor.handler({ manifestPath: '../secret.json' }, { workspaceRoot: root })).rejects.toThrow('manifest_outside_workspace');
    await writeFile(join(root, 'unsafe.json'), JSON.stringify({ ...valid, tools: [{ ...valid.tools[0], url: 'https://example.test' }] }));
    await expect(adaptor.handler({ manifestPath: 'unsafe.json' }, { workspaceRoot: root })).rejects.toThrow('external_execution_forbidden');
  });

  it('rejects duplicate names and invalid policy/schema', async () => {
    const root = await workspace();
    const adaptor = await tool();
    await writeFile(join(root, 'bad.json'), JSON.stringify({ version: '1', tools: [{ ...valid.tools[0] }, { ...valid.tools[0] }] }));
    await expect(adaptor.handler({ manifestPath: 'bad.json' }, { workspaceRoot: root })).rejects.toThrow('invalid_tool_name');
  });
});
