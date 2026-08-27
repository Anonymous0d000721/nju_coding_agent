import { describe, expect, it } from 'vitest';
import { OpenAICompatibleClient, normalizeOpenAIResponse } from '../../src/model/openai-compatible.js';

describe('normalizeOpenAIResponse', () => {
  it('normalizes plain text responses', () => {
    const turn = normalizeOpenAIResponse({ id: 'chatcmpl-1', choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
    expect(turn).toMatchObject({ id: 'chatcmpl-1', text: 'hello', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } });
  });

  it('normalizes function tool calls', () => {
    const turn = normalizeOpenAIResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }] }, finish_reason: 'tool_calls' }] });
    expect(turn.text).toBe('');
    expect(turn.stopReason).toBe('tool_calls');
    expect(turn.toolCalls).toEqual([{ id: 'call-1', name: 'read_file', argumentsJson: '{"path":"package.json"}' }]);
  });

  it('sends mapped reasoning effort', async () => {
    const originalFetch = globalThis.fetch;
    let init: RequestInit | undefined;
    globalThis.fetch = async (_input, requestInit) => { init = requestInit; return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 }); };
    try {
      await new OpenAICompatibleClient({ apiKey: 'secret', baseUrl: 'https://example.test/v1', model: 'demo' }).complete({ systemPrompt: 's', messages: [{ role: 'user', content: 'u' }], tools: [], thinking: { level: 'medium', map: { medium: 'balanced' } } });
      expect(JSON.parse(String(init?.body)).reasoning_effort).toBe('balanced');
    } finally { globalThis.fetch = originalFetch; }
  });
});
