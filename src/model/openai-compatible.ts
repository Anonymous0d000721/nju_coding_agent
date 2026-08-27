import { randomUUID } from 'node:crypto';
import type { AssistantTurn, ToolCall, Usage } from '../agent/types.js';
import type { ModelClient, ModelRequest } from './model-client.js';
import { mappedThinkingValue } from './thinking.js';
import { emit, readSse } from './streaming.js';
import type { ModelStreamHandler } from './streaming.js';

interface OpenAIChatResponse {
  id?: string;
  choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface OpenAICompatibleClientOptions { apiKey: string; baseUrl: string; model: string; }

export class OpenAICompatibleClient implements ModelClient {
  constructor(private readonly options: OpenAICompatibleClientOptions) {}

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<AssistantTurn> {
    const response = await fetch(`${trimTrailingSlash(this.options.baseUrl)}/chat/completions`, { method: 'POST', signal, headers: headers(this.options.apiKey), body: JSON.stringify(chatBody(request, this.options.model)) });
    if (!response.ok) throw modelError(response);
    return normalizeOpenAIResponse(await response.json() as OpenAIChatResponse);
  }

  async stream(request: ModelRequest, handler?: ModelStreamHandler, signal?: AbortSignal): Promise<AssistantTurn> {
    const response = await fetch(`${trimTrailingSlash(this.options.baseUrl)}/chat/completions`, { method: 'POST', signal, headers: headers(this.options.apiKey), body: JSON.stringify({ ...chatBody(request, this.options.model), stream: true }) });
    if (!response.ok) throw modelError(response);
    let id: string = randomUUID(); let text = ''; let finish: string | null | undefined;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    await readSse(response, async (_event, data) => {
      const chunk = data as { id?: string; choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }> };
      id = chunk.id ?? id;
      const choice = chunk.choices?.[0];
      finish = choice?.finish_reason ?? finish;
      const delta = choice?.delta;
      if (delta?.content) { text += delta.content; await emit(handler, { type: 'text_delta', delta: delta.content }); }
      if (delta?.reasoning_content) await emit(handler, { type: 'thinking_delta', delta: delta.reasoning_content });
      for (const item of delta?.tool_calls ?? []) {
        const index = item.index ?? 0;
        const call = calls.get(index) ?? { id: item.id ?? randomUUID(), name: '', args: '' };
        call.id = item.id ?? call.id; call.name += item.function?.name ?? ''; call.args += item.function?.arguments ?? '';
        calls.set(index, call);
      }
    });
    const toolCalls = [...calls.values()].map((call) => ({ id: call.id, name: call.name, argumentsJson: call.args || '{}' }));
    const turn: AssistantTurn = { id, text, toolCalls, stopReason: normalizeStopReason(finish, toolCalls.length) };
    await emit(handler, { type: 'done', turn });
    return turn;
  }
}

function chatBody(request: ModelRequest, model: string): Record<string, unknown> {
  return { model, messages: toOpenAIMessages(request), tools: request.tools.length > 0 ? request.tools : undefined, ...(request.thinking?.level !== 'off' && request.thinking ? { reasoning_effort: mappedThinkingValue(request.thinking.level, request.thinking.map) } : {}) };
}

export function normalizeOpenAIResponse(response: OpenAIChatResponse): AssistantTurn {
  const choice = response.choices?.[0]; const message = choice?.message;
  if (!choice || !message) throw new Error('Model response did not include choices[0].message');
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call) => ({ id: call.id ?? randomUUID(), name: call.function?.name ?? '', argumentsJson: call.function?.arguments ?? '{}' }));
  return { id: response.id ?? randomUUID(), text: message.content ?? '', toolCalls, usage: normalizeUsage(response.usage), stopReason: normalizeStopReason(choice.finish_reason, toolCalls.length), raw: response };
}

function toOpenAIMessages(request: ModelRequest): Array<Record<string, unknown>> {
  return [{ role: 'system', content: request.systemPrompt }, ...request.messages.map((message) => {
    if (message.role === 'assistant') return { role: 'assistant', content: message.content, tool_calls: message.toolCalls?.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.argumentsJson } })) };
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    return { role: message.role, content: message.content };
  })];
}
function normalizeUsage(usage: OpenAIChatResponse['usage']): Usage | undefined { return usage ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens } : undefined; }
function normalizeStopReason(finishReason: string | null | undefined, toolCallCount: number): AssistantTurn['stopReason'] { if (toolCallCount > 0 || finishReason === 'tool_calls') return 'tool_calls'; if (finishReason === 'length') return 'length'; if (finishReason === 'content_filter') return 'content_filter'; if (!finishReason || finishReason === 'stop') return 'end_turn'; return 'error'; }
function headers(apiKey: string): Record<string, string> { return { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }; }
function modelError(response: Response): Error { return new Error(`Model request failed: HTTP ${response.status} ${response.statusText}`); }
function trimTrailingSlash(value: string): string { return value.replace(/\/+$/, ''); }
