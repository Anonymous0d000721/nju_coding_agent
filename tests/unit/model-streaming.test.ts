import { describe, expect, it } from 'vitest';
import { AnthropicClient } from '../../src/model/anthropic.js';
import { OpenAICompatibleClient } from '../../src/model/openai-compatible.js';
import { OpenAIResponsesClient } from '../../src/model/openai-responses.js';
import type { ModelClient, ModelRequest } from '../../src/model/model-client.js';

const request: ModelRequest = { systemPrompt: 'system', messages: [{ role: 'user', content: 'hello' }], tools: [] };

function sse(lines: string[]): Response { return new Response(lines.join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }); }

async function withFetch(response: Response, action: (request: { body?: string }) => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  const request: { body?: string } = {};
  globalThis.fetch = async (_input, init) => { request.body = init?.body as string | undefined; return response; };
  try { await action(request); } finally { globalThis.fetch = originalFetch; }
}

describe('streaming model clients', () => {
  it('streams OpenAI Chat text and accumulates tool arguments', async () => {
    const client = new OpenAICompatibleClient({ apiKey: 'key', baseUrl: 'https://example.test/v1', model: 'test' });
    const deltas: string[] = [];
    await withFetch(sse([
      'data: {"id":"chat-1","choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"id":"chat-1","choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call-1","function":{"name":"echo","arguments":"{\\"value\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ok\\"}"}}]},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ]), async (captured) => {
      const turn = await client.stream!(request, (event) => { if (event.type === 'text_delta') deltas.push(event.delta); });
      expect(turn).toMatchObject({ id: 'chat-1', text: 'Hello', stopReason: 'tool_calls', toolCalls: [{ id: 'call-1', name: 'echo', argumentsJson: '{"value":"ok"}' }] });
      expect(JSON.parse(captured.body ?? '').stream).toBe(true);
    });
    expect(deltas).toEqual(['Hel', 'lo']);
  });

  it('streams Responses text, reasoning, and function-call arguments', async () => {
    const client = new OpenAIResponsesClient({ apiKey: 'key', baseUrl: 'https://example.test/v1', model: 'test' });
    const deltas: string[] = [];
    const thinking: string[] = [];
    await withFetch(sse([
      'event: response.reasoning_summary_text.delta\ndata: {"delta":"Checking"}',
      'event: response.output_text.delta\ndata: {"delta":"Hi"}',
      'event: response.output_item.added\ndata: {"output_index":0,"item":{"type":"function_call","call_id":"call-1","name":"echo","arguments":""}}',
      'event: response.function_call_arguments.delta\ndata: {"output_index":0,"delta":"{}"}',
      'event: response.completed\ndata: {"response":{"id":"resp-1","status":"completed"}}',
    ]), async (captured) => {
      const turn = await client.stream!(request, (event) => {
        if (event.type === 'text_delta') deltas.push(event.delta);
        if (event.type === 'thinking_delta') thinking.push(event.delta);
      });
      expect(turn).toMatchObject({ id: 'resp-1', text: 'Hi', stopReason: 'tool_calls', toolCalls: [{ id: 'call-1', name: 'echo', argumentsJson: '{}' }] });
      expect(JSON.parse(captured.body ?? '').stream).toBe(true);
    });
    expect(deltas).toEqual(['Hi']);
    expect(thinking).toEqual(['Checking']);
  });

  it('streams Anthropic text and tool input JSON', async () => {
    const client = new AnthropicClient({ apiKey: 'key', baseUrl: 'https://api.anthropic.com', model: 'test' });
    const deltas: string[] = [];
    await withFetch(sse([
      'event: message_start\ndata: {"message":{"id":"msg-1"}}',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      'event: content_block_start\ndata: {"index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"echo"}}',
      'event: content_block_delta\ndata: {"index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
      'event: message_delta\ndata: {"delta":{"stop_reason":"tool_use"}}',
    ]), async (captured) => {
      const turn = await client.stream!(request, (event) => { if (event.type === 'text_delta') deltas.push(event.delta); });
      expect(turn).toMatchObject({ id: 'msg-1', text: 'Hi', stopReason: 'tool_calls', toolCalls: [{ id: 'tool-1', name: 'echo', argumentsJson: '{}' }] });
      expect(JSON.parse(captured.body ?? '').stream).toBe(true);
    });
    expect(deltas).toEqual(['Hi']);
  });
});
