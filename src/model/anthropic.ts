import { randomUUID } from 'node:crypto';
import type { AssistantTurn, ToolCall } from '../agent/types.js';
import type { ModelClient, ModelRequest } from './model-client.js';
import type { ToolDefinitionForModel } from '../tools/types.js';
import { mappedThinkingValue } from './thinking.js';
import { emit, readSse } from './streaming.js';
import type { ModelStreamHandler } from './streaming.js';

export interface AnthropicClientOptions { apiKey: string; baseUrl: string; model: string; }
export interface AnthropicResponse { id?: string; content?: Array<Record<string, unknown>>; stop_reason?: string | null; usage?: { input_tokens?: number; output_tokens?: number }; }

export class AnthropicClient implements ModelClient {
  constructor(private readonly options: AnthropicClientOptions) {}

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<AssistantTurn> {
    const response = await fetch(`${endpoint(this.options.baseUrl)}/messages`, { method: 'POST', signal, headers: anthropicHeaders(this.options.apiKey), body: JSON.stringify(requestBody(request, this.options.model)) });
    if (!response.ok) throw modelError(response);
    return normalizeAnthropicResponse(await response.json() as AnthropicResponse);
  }

  async stream(request: ModelRequest, handler?: ModelStreamHandler, signal?: AbortSignal): Promise<AssistantTurn> {
    const response = await fetch(`${endpoint(this.options.baseUrl)}/messages`, { method: 'POST', signal, headers: anthropicHeaders(this.options.apiKey), body: JSON.stringify({ ...requestBody(request, this.options.model), stream: true }) });
    if (!response.ok) throw modelError(response);
    let id: string = randomUUID(); let text = ''; let stopReason: string | undefined;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    await readSse(response, async (event, data) => {
      const value = data as Record<string, unknown>;
      if (event === 'message_start') { const message = value.message as Record<string, unknown> | undefined; id = String(message?.id ?? id); }
      if (event === 'content_block_start') { const block = value.content_block as Record<string, unknown> | undefined; if (block?.type === 'tool_use') calls.set(Number(value.index ?? 0), { id: String(block.id ?? randomUUID()), name: String(block.name ?? ''), args: '' }); }
      if (event === 'content_block_delta') {
        const delta = value.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta') { const part = String(delta.text ?? ''); text += part; await emit(handler, { type: 'text_delta', delta: part }); }
        if (delta?.type === 'thinking_delta') await emit(handler, { type: 'thinking_delta', delta: String(delta.thinking ?? '') });
        if (delta?.type === 'input_json_delta') { const call = calls.get(Number(value.index ?? 0)); if (call) call.args += String(delta.partial_json ?? ''); }
      }
      if (event === 'message_delta') { const delta = value.delta as Record<string, unknown> | undefined; stopReason = String(delta?.stop_reason ?? stopReason); }
    });
    const toolCalls = [...calls.values()].map((call) => ({ id: call.id, name: call.name, argumentsJson: call.args || '{}' }));
    const turn: AssistantTurn = { id, text, toolCalls, stopReason: toolCalls.length || stopReason === 'tool_use' ? 'tool_calls' : stopReason === 'max_tokens' ? 'length' : 'end_turn' };
    await emit(handler, { type: 'done', turn }); return turn;
  }
}

function requestBody(request: ModelRequest, model: string): Record<string, unknown> {
  return { model, max_tokens: 8192, system: request.systemPrompt, messages: toAnthropicMessages(request), tools: request.tools.length > 0 ? request.tools.map(toAnthropicTool) : undefined,
    ...(request.thinking && request.thinking.level !== 'off' && request.thinking.format !== 'anthropic-budget' ? { thinking: { type: 'adaptive' }, output_config: { effort: mappedThinkingValue(request.thinking.level, request.thinking.map) } } : {}),
    ...(request.thinking && request.thinking.format === 'anthropic-budget' && request.thinking.level !== 'off' ? { thinking: { type: 'enabled', budget_tokens: request.thinking.budgets?.[request.thinking.level as Exclude<typeof request.thinking.level, 'off'>] ?? 4096 } } : {}) };
}

export function normalizeAnthropicResponse(response: AnthropicResponse): AssistantTurn {
  const content = response.content ?? [];
  const toolCalls: ToolCall[] = content.filter((block) => block.type === 'tool_use').map((block) => ({ id: String(block.id ?? randomUUID()), name: String(block.name ?? ''), argumentsJson: JSON.stringify(block.input ?? {}) }));
  const text = content.filter((block) => block.type === 'text').map((block) => String(block.text ?? '')).join('');
  return { id: response.id ?? randomUUID(), text, toolCalls, usage: response.usage ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, totalTokens: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0) } : undefined, stopReason: response.stop_reason === 'max_tokens' ? 'length' : toolCalls.length > 0 || response.stop_reason === 'tool_use' ? 'tool_calls' : response.stop_reason === 'end_turn' || !response.stop_reason ? 'end_turn' : 'error', raw: response };
}

export function toAnthropicMessages(request: ModelRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (let index = 0; index < request.messages.length; index += 1) {
    const message = request.messages[index];
    if (message.role === 'tool') {
      const content: Array<Record<string, unknown>> = [];
      while (index < request.messages.length && request.messages[index].role === 'tool') { const tool = request.messages[index]; if (!tool.toolCallId) throw new Error('Tool result is missing toolCallId'); content.push({ type: 'tool_result', tool_use_id: tool.toolCallId, content: tool.content }); index += 1; }
      index -= 1; messages.push({ role: 'user', content }); continue;
    }
    if (message.role === 'assistant') { messages.push({ role: 'assistant', content: [...(message.content ? [{ type: 'text', text: message.content }] : []), ...(message.toolCalls?.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: parseArguments(call.argumentsJson) })) ?? [])] }); continue; }
    messages.push({ role: 'user', content: message.content });
  }
  return messages;
}
function parseArguments(value: string): unknown { try { return JSON.parse(value); } catch { return {}; } }
function toAnthropicTool(tool: ToolDefinitionForModel): Record<string, unknown> { return { name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters }; }
function anthropicHeaders(apiKey: string): Record<string, string> { return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }; }
function modelError(response: Response): Error { return new Error(`Model request failed: HTTP ${response.status} ${response.statusText}`); }
function endpoint(value: string): string { const trimmed = value.replace(/\/+$/, ''); return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`; }
