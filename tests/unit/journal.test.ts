import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChangeJournal, hashMutationText } from '../../src/telemetry/journal.js';

describe('change journal', () => {
  it('records writes, keeps bounded redacted recovery artifacts, formats diff, and undoes safely', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-journal-'));
    await fs.writeFile(path.join(root, 'note.txt'), 'before\n', 'utf8');
    const journal = new ChangeJournal(root, 'run-1', 'session-1');
    const record = await journal.record({ operation: 'modify', relativePath: 'note.txt', toolCallId: 'tool-1', beforeText: 'before\n', afterHash: hashMutationText('after\n'), beforeHash: hashMutationText('before\n'), preview: '- before\n+ after' });
    await fs.writeFile(path.join(root, 'note.txt'), 'after\n', 'utf8');

    expect(record.reversible).toBe(true);
    expect(record.artifactPath).toContain('.nju-agent/logs/journal-artifacts/');
    await expect(journal.formatDiff({ sessionId: 'session-1' })).resolves.toContain('current');
    const undone = await journal.undoLast({ sessionId: 'session-1' });
    expect(undone.ok).toBe(true);
    expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('before\n');
    expect((await journal.list({ sessionId: 'session-1' })).at(-1)).toMatchObject({ undoOf: record.id });
  });

  it('refuses undo after an external edit and never overwrites it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-journal-conflict-'));
    const journal = new ChangeJournal(root, 'run-2', 'session-2');
    const record = await journal.record({ operation: 'modify', relativePath: 'note.txt', toolCallId: 'tool-2', beforeText: 'before', beforeHash: hashMutationText('before'), afterHash: hashMutationText('after') });
    await fs.writeFile(path.join(root, 'note.txt'), 'external', 'utf8');
    const result = await journal.undoLast({ sessionId: 'session-2' });
    expect(result).toEqual({ ok: false, code: 'undo_conflict', message: 'File changed outside the journal: note.txt' });
    expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('external');
    expect(record.reversible).toBe(true);
  });

  it('does not create reversible artifacts for secret content', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-journal-secret-'));
    const journal = new ChangeJournal(root, 'run-3');
    const record = await journal.record({ operation: 'modify', relativePath: 'config.txt', beforeText: 'sk-test-secret-123456789', beforeHash: hashMutationText('sk-test-secret-123456789'), afterHash: hashMutationText('safe') });
    expect(record.reversible).toBe(false);
    expect(record.artifactPath).toBeUndefined();
  });
});
