import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HarnessPluginHost, type HarnessPlugin } from '../../src/context/harness.js';
import { MemoryPlugin } from '../../src/context/memory.js';

describe('HarnessPluginHost', () => {
  it('sorts contributions deterministically and isolates plugin failures', async () => {
    const plugins: HarnessPlugin[] = [
      { id: 'z', version: '1', beforeContextBuild: () => [{ id: 'z', priority: 'memory', label: 'memory', content: 'z', source: { plugin: 'z' }, trusted: true }] },
      { id: 'broken', version: '1', beforeContextBuild: () => { throw new Error('broken plugin'); } },
      { id: 'a', version: '1', beforeContextBuild: () => [{ id: 'a', priority: 'project', label: 'project_instruction', content: 'a', source: { plugin: 'a' }, trusted: true }] },
    ];
    const result = await new HarnessPluginHost(plugins).contributions({ workspaceRoot: process.cwd() });
    expect(result.contributions.map((item) => item.id)).toEqual(['a', 'z']);
    expect(result.diagnostics).toEqual([{ plugin: 'broken', phase: 'before_context_build', message: 'broken plugin' }]);
  });
});

describe('MemoryPlugin', () => {
  it('injects only a bounded index and reads topics on demand', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-memory-'));
    await fs.writeFile(path.join(root, 'MEMORY.md'), `${Array.from({ length: 205 }, (_, index) => `line-${index}`).join('\n')}\n`, 'utf8');
    await fs.writeFile(path.join(root, 'decisions.md'), 'Use deterministic compaction.\n', 'utf8');
    const plugin = new MemoryPlugin({ workspaceRoot: process.cwd(), rootDir: root });

    const contributions = await plugin.beforeContextBuild({ workspaceRoot: process.cwd() });
    expect(contributions[0]?.content).toContain('line-199');
    expect(contributions[0]?.content).not.toContain('line-200');
    expect(plugin.status()).toMatchObject({ truncated: true, topics: ['decisions'] });
    expect(plugin.search('deterministic')).toEqual([{ topic: 'decisions', score: 1, snippet: 'Use deterministic compaction.' }]);
    expect(plugin.get('decisions')).toMatchObject({ topic: 'decisions', content: 'Use deterministic compaction.\n', truncated: false });
  });

  it('does not read memory after it is disabled', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-memory-'));
    await fs.writeFile(path.join(root, 'MEMORY.md'), '# private index\n', 'utf8');
    await fs.writeFile(path.join(root, 'project.md'), 'private detail\n', 'utf8');
    const plugin = new MemoryPlugin({ workspaceRoot: process.cwd(), rootDir: root });
    plugin.setEnabled(false);

    expect(await plugin.beforeContextBuild({ workspaceRoot: process.cwd() })).toEqual([]);
    expect(() => plugin.search('private')).toThrow('disabled');
    expect(() => plugin.get('project')).toThrow('disabled');
  });

  it('requires explicit write enablement and evidence, then redacts stored values', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-memory-'));
    const disabled = new MemoryPlugin({ workspaceRoot: process.cwd(), rootDir: root });
    expect(() => disabled.write('preferences', 'Use pwsh', 'user-confirmed', true)).toThrow('explicit user request');

    const enabled = new MemoryPlugin({ workspaceRoot: process.cwd(), rootDir: root, allowWrite: true });
    expect(() => enabled.write('preferences', 'Use pwsh', '', true)).toThrow('requires evidence');
    enabled.write('preferences', 'Never store sk-abcdefghijk', 'user-confirmed', true);
    expect(enabled.get('preferences').content).toContain('[REDACTED_SECRET]');
    expect(enabled.forget('preferences')).toEqual({ topic: 'preferences', removed: true });
  });
});
