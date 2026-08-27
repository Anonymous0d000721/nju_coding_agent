import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolExecutor } from '../../src/tools/executor.js';
import { createFileTools } from '../../src/tools/file-tools.js';
import { ToolRegistry } from '../../src/tools/registry.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-agent-'));
  const registry = new ToolRegistry();
  for (const tool of createFileTools()) registry.register(tool);
  return { root, executor: new ToolExecutor(registry, { workspaceRoot: root }) };
}

describe('file tools', () => {
  it('writes, lists, and reads workspace files', async () => {
    const { executor } = await fixture();

    const [write] = await executor.executeBatch([{ id: 'w1', name: 'write_file', argumentsJson: '{"path":"src/demo.txt","content":"alpha\\nbeta","createDirectories":true}' }]);
    expect(write.ok).toBe(true);

    const [list] = await executor.executeBatch([{ id: 'l1', name: 'list_files', argumentsJson: '{"path":".","depth":2}' }]);
    expect(list.content).toContain('src/demo.txt');

    const [read] = await executor.executeBatch([{ id: 'r1', name: 'read_file', argumentsJson: '{"path":"src/demo.txt","format":"hashline"}' }]);
    expect(read.content).toContain('1#');
    expect(read.content).toContain('alpha');
  });

  it('rejects workspace escape paths', async () => {
    const { executor } = await fixture();

    const [result] = await executor.executeBatch([{ id: 'x1', name: 'read_file', argumentsJson: '{"path":"../outside.txt"}' }]);

    expect(result.ok).toBe(false);
    expect(result.content).toContain('path_outside_workspace');
  });

  it('edits using hashline anchors and rejects stale anchors', async () => {
    const { executor } = await fixture();
    await executor.executeBatch([{ id: 'w1', name: 'write_file', argumentsJson: '{"path":"demo.txt","content":"one\\ntwo","createDirectories":true}' }]);
    const [read] = await executor.executeBatch([{ id: 'r1', name: 'read_file', argumentsJson: '{"path":"demo.txt","format":"hashline"}' }]);
    const anchor = /2#[a-f0-9]{6}/.exec(read.content)?.[0];
    expect(anchor).toBeTruthy();

    const [edit] = await executor.executeBatch([{ id: 'e1', name: 'hashline_edit', argumentsJson: JSON.stringify({ path: 'demo.txt', edits: [{ op: 'replace', start: anchor, content: 'TWO' }] }) }]);
    expect(edit.ok).toBe(true);

    const [stale] = await executor.executeBatch([{ id: 'e2', name: 'hashline_edit', argumentsJson: JSON.stringify({ path: 'demo.txt', edits: [{ op: 'replace', start: anchor, content: 'again' }] }) }]);
    expect(stale.ok).toBe(false);
    expect(stale.content).toContain('stale_anchor');
  });
});
