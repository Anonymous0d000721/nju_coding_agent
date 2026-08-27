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
    expect(compactMessages(messages, 100)).toEqual({ messages, compacted: false, omittedMessages: 0, summary: '' });
  });
});
