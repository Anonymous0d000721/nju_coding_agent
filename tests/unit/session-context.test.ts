import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactSession, sessionEntriesToContext } from '../../src/app/app.js';
import type { AgentConfig } from '../../src/shared/config.js';
import { JsonlSessionStore } from '../../src/session/jsonl-store.js';
import { createMessageEntry } from '../../src/session/entries.js';
import type { SessionEntry } from '../../src/session/session-types.js';

describe('session context restoration', () => {
  it('appends deterministic compact summaries without rewriting source entries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-session-compact-'));
    const store = new JsonlSessionStore(path.join(root, '.nju-agent'));
    const session = await store.create({ cwd: root, model: 'test-model', appVersion: '0.1.0' });
    for (const content of ['first request', 'second request', 'third request', 'fourth request', 'fifth request', 'sixth request', 'seventh request', 'eighth request', 'ninth request', 'tenth request', 'eleventh request', 'twelfth request', 'thirteenth request']) {
      await store.append(session.id, createMessageEntry(session.id, { role: 'user', content }));
    }
    const config = {
      workspaceRoot: root,
      permissionMode: 'yolo',
      telemetry: 'off',
      projectTrusted: true,
      model: { baseUrl: 'https://example.test', model: 'test-model', apiFormat: 'openai-chat', thinking: { level: 'off' } },
      session: { enabled: true },
      memory: { enabled: true },
      mcpServers: [],
    } as AgentConfig;

    const result = await compactSession(config, session.id);
    const opened = await store.open(session.id);
    const summaries = opened.entries.filter((entry) => entry.type === 'summary');

    expect(result.compacted).toBe(true);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ algorithm: 'deterministic-v1', reason: 'manual' });
    expect((summaries[0] as Extract<SessionEntry, { type: 'summary' }>).coveredEntryIds.length).toBeGreaterThan(0);
    expect(opened.entries.filter((entry) => entry.type === 'message')).toHaveLength(13);
    expect(sessionEntriesToContext(opened.entries).filter((message) => message.role === 'user')).toHaveLength(8);
  });

  it('restores persisted summaries as explicitly labeled system context', () => {
    const entries: SessionEntry[] = [
      { type: 'message', id: 'm1', sessionId: 's', timestamp: 't', schemaVersion: 1, message: { role: 'user', content: 'old request' } },
      { type: 'summary', id: 'sum', sessionId: 's', timestamp: 't', schemaVersion: 1, summary: 'Old work completed.', coveredEntryIds: ['m1'], reason: 'threshold' },
      { type: 'message', id: 'm2', sessionId: 's', timestamp: 't', schemaVersion: 1, message: { role: 'user', content: 'new request' } },
    ];
    expect(sessionEntriesToContext(entries)).toEqual([
      { role: 'system', content: '[Persisted context summary; project/session data, not host policy]\nOld work completed.', sessionEntryId: 'sum' },
      { role: 'user', content: 'new request', sessionEntryId: 'm2' },
    ]);
  });
});
