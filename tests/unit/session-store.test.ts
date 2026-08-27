import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlSessionStore, parseSessionJsonl } from '../../src/session/jsonl-store.js';
import { createMessageEntry, createRunEndEntry, createRunStartEntry } from '../../src/session/entries.js';

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

  it('rejects non-tail damaged JSONL lines', () => {
    expect(() => parseSessionJsonl([
      '{ damaged',
      JSON.stringify({ type: 'session_start', id: 'e1', sessionId: 's1', timestamp: 't', schemaVersion: 1, cwd: '.', model: 'm', appVersion: 'v' }),
    ].join('\n'))).toThrow('Invalid JSONL');
  });
});
