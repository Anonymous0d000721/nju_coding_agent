import { randomUUID } from 'node:crypto';
import type { AssistantTurn, ToolCall, Usage } from '../agent/types.js';
import type { ModelClient, ModelRequest } from './model-client.js';
import type { ToolDefinitionForModel } from '../tools/types.js';

export interface AnthropicClientOptions { apiKey: string; baseUrl: string; model: string; }
export interface AnthropicResponse { id?: string; content?: Array<Record<string, unknown>>; stop_reason?: string | null; usage?: { input_tokens?: number; output_tokens?: number; }; }

export class AnthropicClient implements ModelClient {
  constructor(private readonly options: AnthropicClientOptions) {}
  async complete(request: ModelRequest, signal?: AbortSignal): Promise<AssistantTurn> {
    const response = await fetch(`${endpoint(this.options.baseUrl)}/messages`, {
      method: 'POST', signal,
      headers: { 'x-api-key': this.options.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.options.model, max_tokens: 8192, system: request.systemPrompt, messages: toAnthropicMessages(request), tools: request.tools.length > 0 ? request.tools.map(toAnthropicTool) : undefined }),
    });
    if (!response.ok) throw new Error(`Model request failed: HTTP ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 500)}`);
    return normalizeAnthropicResponse(await response.json() as AnthropicResponse);
  }
}

export function normalizeAnthropicResponse(response: AnthropicResponse): AssistantTurn {
  const content = response.content ?? [];
  const toolCalls: ToolCall[] = content.filter((block) => block.type === 'tool_use').map((block) => ({ id: String(block.id ?? randomUUID()), name: String(block.name ?? ''), argumentsJson: JSON.stringify(block.input ?? {}) }));
  const text = content.filter((block) => block.type === 'text').map((block) => String(block.text ?? '')).join('');
  return { id: response.id ?? randomUUID(), text, toolCalls, usage: response.usage ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, totalTokens: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0) } : undefined, stopReason: response.stop_reason === 'max_tokens' ? 'length' : toolCalls.length > 0 || response.stop_reason === 'tool_use' ? 'tool_calls' : response.stop_reason === 'end_turn' || !response.stop_reason ? 'end_turn' : 'error', raw: response };
}

function toAnthropicMessages(request: ModelRequest): Array<Record<string, unknown>> {
  return request.messages.map((message) => {
    if (message.role === 'assistant') return { role: 'assistant', content: [...(message.content ? [{ type: 'text', text: message.content }] : []), ...(message.toolCalls?.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: parseArguments(call.argumentsJson) })) ?? [])] };
    if (message.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }] };
    return { role: 'user', content: message.content };
  });
}
function parseArguments(value: string): unknown { try { return JSON.parse(value); } catch { return {}; } }
function toAnthropicTool(tool: ToolDefinitionForModel): Record<string, unknown> { return { name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters }; }
function endpoint(value: string): string { const trimmed = value.replace(/\/+$/, ''); return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`; }
