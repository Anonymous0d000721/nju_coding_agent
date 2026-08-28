import { describe, expect, it } from 'vitest';
import { renderRunResult } from '../../src/app/renderer.js';

describe('run result rendering', () => {
  const result = {
    stopReason: 'model_finished' as const,
    turns: 2,
    toolCalls: 1,
    messages: [
      { role: 'user' as const, content: 'inspect the project' },
      { role: 'assistant' as const, content: '', toolCalls: [{ id: 'call-1', name: 'read_file', argumentsJson: '{}' }] },
      { role: 'tool' as const, toolCallId: 'call-1', content: 'file contents' },
      { role: 'assistant' as const, content: 'Inspection complete.' },
    ],
  };

  it('renders only final assistant text after streamed tool events', () => {
    expect(renderRunResult(result, false)).toBe('');
  });

  it('does not repeat tool results or emit a run-end summary', () => {
    expect(renderRunResult(result)).toBe('assistant: Inspection complete.\n');
  });
});
