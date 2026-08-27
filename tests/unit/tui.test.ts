import { describe, expect, it } from 'vitest';
import { applyAgentEvent, type TuiMessage } from '../../src/app/tui.js';
import type { AgentStreamEvent } from '../../src/agent/types.js';

const base: TuiMessage[] = [{ role: 'system', text: 'ready' }];

describe('TUI event rendering', () => {
  it('appends text deltas to the current assistant message', () => {
    const first = applyAgentEvent(base, { type: 'text_delta', delta: 'Hel' }, false);
    const second = applyAgentEvent(first, { type: 'text_delta', delta: 'lo' }, false);

    expect(second).toEqual([
      { role: 'system', text: 'ready' },
      { role: 'assistant', text: 'Hello' },
    ]);
  });

  it('hides reasoning deltas by default and shows them when enabled', () => {
    const event: AgentStreamEvent = { type: 'thinking_delta', delta: 'thinking' };

    expect(applyAgentEvent(base, event, false)).toBe(base);
    expect(applyAgentEvent(base, event, true)).toEqual([
      { role: 'system', text: 'ready' },
      { role: 'thinking', text: 'thinking' },
    ]);
  });

  it('renders tool call and tool result summaries only', () => {
    const withCall = applyAgentEvent(base, {
      type: 'tool_call',
      toolCall: { id: 'call-1', name: 'read_file', argumentsJson: '{"path":"secret"}' },
    }, false);
    const withResult = applyAgentEvent(withCall, {
      type: 'tool_result',
      result: { toolCallId: 'call-1', toolName: 'read_file', ok: false, content: '', error: { code: 'permission_denied', message: 'denied', recoverable: true }, elapsedMs: 1 },
    }, false);

    expect(withResult).toEqual([
      { role: 'system', text: 'ready' },
      { role: 'tool', text: '[tool] read_file' },
      { role: 'tool', text: '[tool result] read_file failed:permission_denied', ok: false },
    ]);
  });
});
