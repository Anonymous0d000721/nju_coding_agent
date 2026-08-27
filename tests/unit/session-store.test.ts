import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlSessionStore, parseSessionJsonl } from '../../src/session/jsonl-store.js';
import { createMessageEntry, createRunEndEntry, createRunStartEntry, createSessionNameEntry } from '../../src/session/entries.js';

async function storeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-agent-session-'));
  return { root, store: new JsonlSessionStore(root) };
}

describe('JsonlSessionStore', () => {
  it('creates, appends, and opens an append-only session', async () => {
    const { store } = await storeFixture();
    const session = await store.create({ cwd: 'D:/repo', model: 'demo-model', appVersion: '0.1.0' });
    const user = createMessageEntry(session.id, { role: 'user', content: 'hello' });
    await store.append(session.id, user);
    await store.append(session.id, createRunStartEntry(session.id, user.id, { model: 'demo-model', permissionMode: 'yolo' }));
    await store.append(session.id, createRunEndEntry(session.id, { stopReason: 'model_finished', messages: [], turns: 1, toolCalls: 0 }));

    const opened = await store.open(session.id);

    expect(opened.id).toBe(session.id);
    expect(opened.entries.map((entry) => entry.type)).toEqual(['session_start', 'message', 'run_start', 'run_end']);
  });

  it('ignores one damaged trailing JSONL line when parsing', () => {
    const entries = parseSessionJsonl([
      JSON.stringify({ type: 'session_start', id: 'e1', sessionId: 's1', timestamp: 't', schemaVersion: 1, cwd: '.', model: 'm', appVersion: 'v' }),
      '{ damaged',
    ].join('\n'));

    expect(entries).toHaveLength(1);
  });

  it('forks resumable message and summary context into a child lineage', async () => {
    const { store } = await storeFixture();
    const parent = await store.create({ cwd: 'D:/repo', model: 'demo-model', appVersion: '0.1.0' });
    await store.append(parent.id, createMessageEntry(parent.id, { role: 'user', content: 'original task' }));
    const child = await store.fork(parent.id);
    const childStart = child.entries[0];

    expect(childStart).toMatchObject({ type: 'session_start', parentSessionId: parent.id });
    expect(child.entries.filter((entry) => entry.type === 'message')).toMatchObject([{ message: { content: 'original task' } }]);
  });


  it('derives the latest append-only session name in list and page metadata', async () => {
    const { store } = await storeFixture();
    const session = await store.create({ cwd: 'D:/repo', model: 'demo-model', appVersion: '0.1.0', name: 'initial' });
    await store.append(session.id, createSessionNameEntry(session.id, 'renamed'));

    expect((await store.list())[0]?.name).toBe('renamed');
    expect((await store.readDisplayPage(session.id)).name).toBe('renamed');
  });
  it('loads recent entries in chronological pages and tolerates a damaged tail', async () => {
    const { store } = await storeFixture();
    const session = await store.create({ cwd: 'D:/repo', model: 'demo-model', appVersion: '0.1.0' });
    const prompts = ['one', 'two', 'three'];
    for (const content of prompts) await store.append(session.id, createMessageEntry(session.id, { role: 'user', content }));
    await fs.appendFile(session.path, '{ damaged tail\n', 'utf8');

    const latest = await store.readDisplayPage(session.id, { limit: 2 });
    const earlier = await store.readDisplayPage(session.id, { beforeEntryId: latest.nextBeforeEntryId!, limit: 2 });

    expect(latest.entries.map((entry) => entry.type)).toEqual(['message', 'message']);
    expect((latest.entries[0] as { message: { content: string } }).message.content).toBe('two');
    expect(latest.hasMore).toBe(true);
    expect(earlier.entries.map((entry) => entry.type)).toEqual(['session_start', 'message']);
    expect(earlier.hasMore).toBe(false);
  });

  it('rejects an unknown display-history cursor', async () => {
    const { store } = await storeFixture();
    const session = await store.create({ cwd: 'D:/repo', model: 'demo-model', appVersion: '0.1.0' });

    await expect(store.readDisplayPage(session.id, { beforeEntryId: 'missing' })).rejects.toThrow('Unknown session history cursor');
  });
});
