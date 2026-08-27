import { describe, expect, it } from 'vitest';
import { OpenAIResponsesClient, normalizeOpenAIResponsesResponse } from '../../src/model/openai-responses.js';

describe('OpenAIResponsesClient', () => {
  it('normalizes output text and function calls', () => {
    const turn = normalizeOpenAIResponsesResponse({ id: 'resp-1', output: [
      { type: 'message', content: [{ type: 'output_text', text: '检查中。' }] },
      { type: 'function_call', call_id: 'call-1', name: 'list_files', arguments: '{"path":"."}' },
    ], status: 'completed', usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 } });
    expect(turn).toMatchObject({ id: 'resp-1', text: '检查中。', stopReason: 'tool_calls', toolCalls: [{ id: 'call-1', name: 'list_files', argumentsJson: '{"path":"."}' }], usage: { inputTokens: 3, outputTokens: 5 } });
  });

  it('sends native Responses format', async () => {
    const originalFetch = globalThis.fetch;
    let url = '';
    let init: RequestInit | undefined;
    globalThis.fetch = async (input, requestInit) => { url = String(input); init = requestInit; return new Response(JSON.stringify({ id: 'resp-1', output_text: 'ok', status: 'completed' }), { status: 200 }); };
    try {
      const turn = await new OpenAIResponsesClient({ apiKey: 'secret', baseUrl: 'https://api.openai.com/v1', model: 'gpt-test' }).complete({ systemPrompt: 'system', messages: [{ role: 'user', content: 'hello' }], tools: [], thinking: { level: 'high', map: { high: 'xhigh' } } });
      const body = JSON.parse(String(init?.body));
      expect(turn.text).toBe('ok');
      expect(url).toBe('https://api.openai.com/v1/responses');
      expect(body).toMatchObject({ model: 'gpt-test', instructions: 'system', input: [{ type: 'message', role: 'user' }], reasoning: { effort: 'xhigh' } });
    } finally { globalThis.fetch = originalFetch; }
  });
});
