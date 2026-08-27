import { describe, expect, it } from 'vitest';
import { applyAgentEvent, sessionEntriesToTuiMessages, type TuiMessage } from '../../src/app/tui.js';
import type { SessionEntry } from '../../src/session/session-types.js';
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
      { role: 'tool', text: 'read_file · failed:permission_denied', ok: false, toolCallId: 'call-1' },
    ]);
  });

  it('updates the active tool card instead of appending a trailing result overview', () => {
    const withCall = applyAgentEvent(base, {
      type: 'tool_call',
      toolCall: { id: 'call-1', name: 'read_file', argumentsJson: '{"path":"a"}' },
    }, false);
    const completed = applyAgentEvent(withCall, {
      type: 'tool_result',
      result: { toolCallId: 'call-1', toolName: 'read_file', ok: true, content: 'hidden', elapsedMs: 1 },
    }, false);

    expect(completed).toEqual([
      { role: 'system', text: 'ready' },
      { role: 'tool', text: 'read_file · completed', ok: true, toolCallId: 'call-1' },
    ]);
  });

  it('rebuilds persisted conversation and tool status for session hydration', () => {
    const entries: SessionEntry[] = [
      { type: 'message', id: 'u', sessionId: 's', timestamp: 't', schemaVersion: 1, message: { role: 'user', content: 'Fix **this**.' } },
      { type: 'message', id: 'a', sessionId: 's', timestamp: 't', schemaVersion: 1, message: { role: 'assistant', content: 'I will inspect it.', toolCalls: [{ id: 'call-1', name: 'read_file', argumentsJson: '{}' }] } },
      { type: 'message', id: 'r', sessionId: 's', timestamp: 't', schemaVersion: 1, message: { role: 'tool', toolCallId: 'call-1', content: 'contents' } },
      { type: 'run_end', id: 'end', sessionId: 's', timestamp: 't', schemaVersion: 1, stopReason: 'user_cancelled', turns: 1, toolCalls: 1 },
    ];

    expect(sessionEntriesToTuiMessages(entries)).toEqual([
      { role: 'user', text: 'Fix **this**.' },
      { role: 'assistant', text: 'I will inspect it.' },
      { role: 'tool', text: 'read_file · completed', ok: true, toolCallId: 'call-1' },
      { role: 'cancelled', text: 'Run interrupted.' },
    ]);
  });
});
