import { describe, expect, it } from 'vitest';
import { sessionEntriesToContext } from '../../src/app/app.js';
import type { SessionEntry } from '../../src/session/session-types.js';

describe('session context restoration', () => {
  it('restores persisted summaries as explicitly labeled system context', () => {
    const entries: SessionEntry[] = [
      { type: 'message', id: 'm1', sessionId: 's', timestamp: 't', schemaVersion: 1, message: { role: 'user', content: 'old request' } },
      { type: 'summary', id: 'sum', sessionId: 's', timestamp: 't', schemaVersion: 1, summary: 'Old work completed.', coveredEntryIds: ['m1'], reason: 'threshold' },
      { type: 'message', id: 'm2', sessionId: 's', timestamp: 't', schemaVersion: 1, message: { role: 'user', content: 'new request' } },
    ];
    expect(sessionEntriesToContext(entries)).toEqual([
      { role: 'user', content: 'old request' },
      { role: 'system', content: '[Persisted context summary; project/session data, not host policy]\nOld work completed.' },
      { role: 'user', content: 'new request' },
    ]);
  });
});
