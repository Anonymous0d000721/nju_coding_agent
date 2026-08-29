import { describe, expect, it } from 'vitest';
import { compactMessages } from '../../src/context/compactor.js';

describe('compactMessages', () => {
  it('keeps recent messages and does not orphan tool results', () => {
    const messages = [
      { role: 'user' as const, content: 'old request' },
      { role: 'assistant' as const, content: 'calling tool', toolCalls: [{ id: 'c1', name: 'read_file', argumentsJson: '{}' }] },
      { role: 'tool' as const, toolCallId: 'c1', content: 'old observation' },
      { role: 'user' as const, content: 'current request' },
      { role: 'assistant' as const, content: 'current answer' },
    ];
    const result = compactMessages(messages, 80, 2);

    expect(result.compacted).toBe(true);
    expect(result.messages[0]?.role).toBe('system');
    expect(result.messages.some((message) => message.role === 'tool' && message.toolCallId === 'c1')).toBe(false);
    expect(result.messages.at(-1)?.content).toBe('current answer');
  });

  it('does not compact within budget', () => {
    const messages = [{ role: 'user' as const, content: 'hello' }];
    expect(compactMessages(messages, 100)).toMatchObject({ messages, compacted: false, omittedMessages: 0, summary: '', coveredEntryIds: [] });
  });

  it('produces deterministic structured summaries with auditable entry coverage', () => {
    const messages = [
      { role: 'user' as const, content: 'Fix the parser', sessionEntryId: 'u1' },
      { role: 'assistant' as const, content: '', toolCalls: [{ id: 'c1', name: 'write_file', argumentsJson: '{}' }], sessionEntryId: 'a1' },
      { role: 'tool' as const, toolCallId: 'c1', content: 'changed parser.ts', sessionEntryId: 't1' },
      { role: 'user' as const, content: 'Run the checks', sessionEntryId: 'u2' },
      { role: 'assistant' as const, content: 'I will run the checks.', sessionEntryId: 'a2' },
      { role: 'user' as const, content: 'Keep this tail', sessionEntryId: 'u3' },
      { role: 'assistant' as const, content: 'tail', sessionEntryId: 'a3' },
      { role: 'user' as const, content: 'latest', sessionEntryId: 'u4' },
      { role: 'assistant' as const, content: 'latest answer', sessionEntryId: 'a4' },
    ];

    const first = compactMessages(messages, 10_000, 4, true);
    const second = compactMessages(messages, 10_000, 4, true);

    expect(first).toEqual(second);
    expect(first.compacted).toBe(true);
    expect(first.summary).toContain('[Session Goal]');
    expect(first.summary).toContain('[Files And Changes]');
    expect(first.coveredEntryIds).toEqual(['u1', 'a1', 't1', 'u2', 'a2']);
    expect(first.firstKeptEntryId).toBe('u3');
    expect(first.messages.some((message) => message.role === 'tool' && message.toolCallId === 'c1')).toBe(false);
  });
});
