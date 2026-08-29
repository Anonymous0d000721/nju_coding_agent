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

  it('edits using hashline anchors, returns fresh anchors, and rejects stale anchors', async () => {
    const { executor } = await fixture();
    await executor.executeBatch([{ id: 'w1', name: 'write_file', argumentsJson: '{"path":"demo.txt","content":"one\\ntwo","createDirectories":true}' }]);
    const [read] = await executor.executeBatch([{ id: 'r1', name: 'read_file', argumentsJson: '{"path":"demo.txt","format":"hashline"}' }]);
    const anchor = /2#[a-f0-9]{6}/.exec(read.content)?.[0];
    expect(anchor).toBeTruthy();

    const [edit] = await executor.executeBatch([{ id: 'e1', name: 'hashline_edit', argumentsJson: JSON.stringify({ path: 'demo.txt', edits: [{ op: 'replace', start: `${anchor}:`, content: 'TWO' }] }) }]);
    expect(edit.ok).toBe(true);
    expect(edit.details).toMatchObject({ editsApplied: 1, newlineStyle: 'LF' });
    expect(JSON.stringify(edit.details)).toMatch(/2#[a-f0-9]{6}/);

    const [stale] = await executor.executeBatch([{ id: 'e2', name: 'hashline_edit', argumentsJson: JSON.stringify({ path: 'demo.txt', edits: [{ op: 'replace', start: anchor, content: 'again' }] }) }]);
    expect(stale.ok).toBe(false);
    expect(stale.content).toContain('stale_anchor');
    expect(stale.content).toContain('重新调用 read_file');
  });

  it('preserves CRLF and applies a validated batch atomically', async () => {
    const { executor, root } = await fixture();
    await fs.writeFile(path.join(root, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n', 'utf8');
    const [read] = await executor.executeBatch([{ id: 'r1', name: 'read_file', argumentsJson: '{"path":"crlf.txt","format":"hashline"}' }]);
    const anchors = [...read.content.matchAll(/(\d+#[a-f0-9]{6})/g)].map((match) => match[1]);
    const [edit] = await executor.executeBatch([{ id: 'e1', name: 'hashline_edit', argumentsJson: JSON.stringify({ path: 'crlf.txt', edits: [
      { op: 'replace', start: anchors[0], content: 'ONE' },
      { op: 'insert_after', anchor: anchors[1], content: 'between' },
    ] }) }]);
    expect(edit.ok).toBe(true);
    expect(await fs.readFile(path.join(root, 'crlf.txt'), 'utf8')).toBe('ONE\r\ntwo\r\nbetween\r\nthree\r\n');
  });

  it('rejects malformed edit shapes before the handler runs', async () => {
    const { executor } = await fixture();
    await executor.executeBatch([{ id: 'w1', name: 'write_file', argumentsJson: '{"path":"demo.txt","content":"one","createDirectories":true}' }]);
    const [result] = await executor.executeBatch([{ id: 'e1', name: 'hashline_edit', argumentsJson: JSON.stringify({ path: 'demo.txt', edits: [{ op: 'delete', anchor: '1#abc123' }] }) }]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_arguments');
  });

  it('serializes concurrent writes to the same file without corrupting content', async () => {
    const { executor, root } = await fixture();
    await Promise.all(Array.from({ length: 8 }, (_, index) => executor.executeBatch([{
      id: `w${index}`, name: 'write_file', argumentsJson: JSON.stringify({ path: 'concurrent.txt', content: `value-${index}` }),
    }] )));
    const content = await fs.readFile(path.join(root, 'concurrent.txt'), 'utf8');
    expect(content).toMatch(/^value-[0-7]$/);
    expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects stale file revisions, overlapping edits, and full-line anchor copies', async () => {
    const { executor } = await fixture();
    await executor.executeBatch([{ id: 'w1', name: 'write_file', argumentsJson: '{"path":"guard.txt","content":"one\\ntwo\\nthree","createDirectories":true}' }]);
    const [read] = await executor.executeBatch([{ id: 'r1', name: 'read_file', argumentsJson: '{"path":"guard.txt","format":"hashline"}' }]);
    const anchors = [...read.content.matchAll(/(\d+#[a-f0-9]{6})/g)].map((match) => match[1]);
    const [revision] = await executor.executeBatch([{ id: 'e1', name: 'hashline_edit', argumentsJson: JSON.stringify({ path: 'guard.txt', expectedFileHash: '000000000000', edits: [{ op: 'replace', start: anchors[0], content: 'ONE' }] }) }]);
    expect(revision.error?.code).toBe('file_revision_mismatch');
    expect(revision.content).toContain('重新调用 read_file');

    const [overlap] = await executor.executeBatch([{ id: 'e2', name: 'hashline_edit', argumentsJson: JSON.stringify({ path: 'guard.txt', edits: [{ op: 'replace', start: anchors[0], end: anchors[1], content: 'x' }, { op: 'delete', start: anchors[1] }] }) }]);
    expect(overlap.error?.code).toBe('overlapping_edits');

    const [fullAnchor] = await executor.executeBatch([{ id: 'e3', name: 'hashline_edit', argumentsJson: JSON.stringify({ path: 'guard.txt', edits: [{ op: 'replace', start: `${anchors[0]}: one`, content: 'ONE' }] }) }]);
    expect(fullAnchor.error?.code).toBe('invalid_arguments');
  });

  it('can reuse a returned changed anchor for a follow-up edit', async () => {
    const { executor } = await fixture();
    await executor.executeBatch([{ id: 'w1', name: 'write_file', argumentsJson: '{"path":"chain.txt","content":"one\\ntwo","createDirectories":true}' }]);
    const [read] = await executor.executeBatch([{ id: 'r1', name: 'read_file', argumentsJson: '{"path":"chain.txt","format":"hashline"}' }]);
    const anchor = /1#[a-f0-9]{6}/.exec(read.content)?.[0];
    const [first] = await executor.executeBatch([{ id: 'e1', name: 'hashline_edit', argumentsJson: JSON.stringify({ path: 'chain.txt', edits: [{ op: 'replace', start: anchor, content: 'ONE' }] }) }]);
    const changedAnchor = (first.details as { changedAnchors: Array<{ anchor: string; content: string }> }).changedAnchors.find((item) => item.content === 'ONE')?.anchor;
    expect(changedAnchor).toBeTruthy();
    const [second] = await executor.executeBatch([{ id: 'e2', name: 'hashline_edit', argumentsJson: JSON.stringify({ path: 'chain.txt', edits: [{ op: 'replace', start: changedAnchor, content: 'one again' }] }) }]);
    expect(second.ok).toBe(true);
  });
});
