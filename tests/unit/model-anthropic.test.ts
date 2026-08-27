import { describe, expect, it } from 'vitest';
import { AnthropicClient, normalizeAnthropicResponse, toAnthropicMessages } from '../../src/model/anthropic.js';

describe('AnthropicClient', () => {
  it('normalizes text and tool use', () => {
    const turn = normalizeAnthropicResponse({ id: 'msg-1', stop_reason: 'tool_use', content: [
      { type: 'text', text: '先检查。' },
      { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'package.json' } },
    ], usage: { input_tokens: 4, output_tokens: 6 } });
    expect(turn).toMatchObject({ id: 'msg-1', text: '先检查。', stopReason: 'tool_calls', toolCalls: [{ id: 'tool-1', name: 'read_file', argumentsJson: '{"path":"package.json"}' }], usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } });
  });

  it('keeps tool results adjacent to their tool use blocks', () => {
    const messages = toAnthropicMessages({
      systemPrompt: 'system',
      tools: [],
      messages: [
        { role: 'user', content: 'inspect the workspace' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_01', name: 'list_files', argumentsJson: '{"path":"."}' }] },
        { role: 'tool', toolCallId: 'call_01', content: '{"files":["package.json"]}' },
      ],
    });
    expect(messages).toEqual([
      { role: 'user', content: 'inspect the workspace' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_01', name: 'list_files', input: { path: '.' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_01', content: '{"files":["package.json"]}' }] },
    ]);
  });

  it('groups consecutive tool results into one user message', () => {
    const messages = toAnthropicMessages({
      systemPrompt: 'system', tools: [], messages: [
        { role: 'assistant', content: '', toolCalls: [
          { id: 'call_01', name: 'read_file', argumentsJson: '{"path":"a.txt"}' },
          { id: 'call_02', name: 'read_file', argumentsJson: '{"path":"b.txt"}' },
        ] },
        { role: 'tool', toolCallId: 'call_01', content: 'a' },
        { role: 'tool', toolCallId: 'call_02', content: 'b' },
      ],
    });
    expect(messages[1]).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_01', content: 'a' },
      { type: 'tool_result', tool_use_id: 'call_02', content: 'b' },
    ] });
  });

  it('sends native Messages format', async () => {
    const originalFetch = globalThis.fetch;
    let init: RequestInit | undefined;
    globalThis.fetch = async (_input, requestInit) => { init = requestInit; return new Response(JSON.stringify({ id: 'msg-1', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }), { status: 200 }); };
    try {
      const turn = await new AnthropicClient({ apiKey: 'secret', baseUrl: 'https://api.anthropic.com', model: 'claude-test' }).complete({ systemPrompt: 'system', messages: [{ role: 'user', content: 'hello' }], tools: [], thinking: { level: 'high', map: { high: 'high' } } });
      const body = JSON.parse(String(init?.body));
      expect(turn.text).toBe('ok');
      expect(body).toMatchObject({ model: 'claude-test', system: 'system', messages: [{ role: 'user', content: 'hello' }], thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('secret');
    } finally { globalThis.fetch = originalFetch; }
  });
});
