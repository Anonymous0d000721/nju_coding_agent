import { describe, expect, it } from 'vitest';
import { AnthropicClient, normalizeAnthropicResponse } from '../../src/model/anthropic.js';

describe('AnthropicClient', () => {
  it('normalizes text and tool use', () => {
    const turn = normalizeAnthropicResponse({ id: 'msg-1', stop_reason: 'tool_use', content: [
      { type: 'text', text: '先检查。' },
      { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'package.json' } },
    ], usage: { input_tokens: 4, output_tokens: 6 } });
    expect(turn).toMatchObject({ id: 'msg-1', text: '先检查。', stopReason: 'tool_calls', toolCalls: [{ id: 'tool-1', name: 'read_file', argumentsJson: '{"path":"package.json"}' }], usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } });
  });

  it('sends native Messages format', async () => {
    const originalFetch = globalThis.fetch;
    let init: RequestInit | undefined;
    globalThis.fetch = async (_input, requestInit) => { init = requestInit; return new Response(JSON.stringify({ id: 'msg-1', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }), { status: 200 }); };
    try {
      const turn = await new AnthropicClient({ apiKey: 'secret', baseUrl: 'https://api.anthropic.com', model: 'claude-test' }).complete({ systemPrompt: 'system', messages: [{ role: 'user', content: 'hello' }], tools: [] });
      const body = JSON.parse(String(init?.body));
      expect(turn.text).toBe('ok');
      expect(body).toMatchObject({ model: 'claude-test', system: 'system', messages: [{ role: 'user', content: 'hello' }] });
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('secret');
    } finally { globalThis.fetch = originalFetch; }
  });
});
