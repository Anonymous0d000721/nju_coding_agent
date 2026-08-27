import { randomUUID } from 'node:crypto';
import type { AssistantTurn, ToolCall, Usage } from '../agent/types.js';
import type { ModelClient, ModelRequest } from './model-client.js';
import { mappedThinkingValue } from './thinking.js';
import { emit, readSse } from './streaming.js';
import type { ModelStreamHandler } from './streaming.js';
import type { ToolDefinitionForModel } from '../tools/types.js';

export interface OpenAIResponsesClientOptions { apiKey: string; baseUrl: string; model: string; }
export interface OpenAIResponsesResponse { id?: string; status?: string; output_text?: string; output?: Array<Record<string, unknown>>; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }; }

export class OpenAIResponsesClient implements ModelClient {
  constructor(private readonly options: OpenAIResponsesClientOptions) {}

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<AssistantTurn> {
    const response = await fetch(`${trim(this.options.baseUrl)}/responses`, { method: 'POST', signal, headers: headers(this.options.apiKey), body: JSON.stringify(requestBody(request, this.options.model)) });
    if (!response.ok) throw modelError(response);
    return normalizeOpenAIResponsesResponse(await response.json() as OpenAIResponsesResponse);
  }

  async stream(request: ModelRequest, handler?: ModelStreamHandler, signal?: AbortSignal): Promise<AssistantTurn> {
    const response = await fetch(`${trim(this.options.baseUrl)}/responses`, { method: 'POST', signal, headers: headers(this.options.apiKey), body: JSON.stringify({ ...requestBody(request, this.options.model), stream: true }) });
    if (!response.ok) throw modelError(response);
    let id: string = randomUUID(); let text = ''; let status = 'completed';
    const calls = new Map<number, { id: string; name: string; args: string }>();
    await readSse(response, async (event, data) => {
      const value = data as Record<string, unknown>; id = String(value.id ?? id);
      if (event === 'response.output_text.delta') { const delta = String(value.delta ?? ''); text += delta; await emit(handler, { type: 'text_delta', delta }); }
      if (event === 'response.reasoning_text.delta' || event === 'response.reasoning_summary_text.delta') await emit(handler, { type: 'thinking_delta', delta: String(value.delta ?? '') });
      if (event === 'response.output_item.added') { const item = value.item as Record<string, unknown> | undefined; if (item?.type === 'function_call') calls.set(Number(value.output_index ?? 0), { id: String(item.call_id ?? item.id ?? randomUUID()), name: String(item.name ?? ''), args: String(item.arguments ?? '') }); }
      if (event === 'response.function_call_arguments.delta') { const index = Number(value.output_index ?? 0); const call = calls.get(index) ?? { id: String(value.call_id ?? randomUUID()), name: String(value.name ?? ''), args: '' }; call.args += String(value.delta ?? ''); calls.set(index, call); }
      if (event === 'response.completed') { const result = value.response as Record<string, unknown> | undefined; id = String(result?.id ?? id); status = String(result?.status ?? 'completed'); }
    });
    const toolCalls = [...calls.values()].map((call) => ({ id: call.id, name: call.name, argumentsJson: call.args || '{}' }));
    const turn: AssistantTurn = { id, text, toolCalls, stopReason: toolCalls.length ? 'tool_calls' : status === 'incomplete' ? 'length' : 'end_turn' };
    await emit(handler, { type: 'done', turn }); return turn;
  }
}

function requestBody(request: ModelRequest, model: string): Record<string, unknown> { return { model, instructions: request.systemPrompt, input: toResponsesInput(request), tools: request.tools.length > 0 ? request.tools.map(toResponsesTool) : undefined, ...(request.thinking?.level !== 'off' && request.thinking ? { reasoning: { effort: mappedThinkingValue(request.thinking.level, request.thinking.map) } } : {}) }; }

export function normalizeOpenAIResponsesResponse(response: OpenAIResponsesResponse): AssistantTurn {
  const output = response.output ?? [];
  const toolCalls: ToolCall[] = output.filter((item) => item.type === 'function_call').map((item) => ({ id: String(item.call_id ?? item.id ?? randomUUID()), name: String(item.name ?? ''), argumentsJson: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) }));
  const text = response.output_text ?? output.filter((item) => item.type === 'message').flatMap((item) => Array.isArray(item.content) ? item.content : []).filter((item) => (item as Record<string, unknown>).type === 'output_text').map((item) => String((item as Record<string, unknown>).text ?? '')).join('');
  return { id: response.id ?? randomUUID(), text, toolCalls, usage: normalizeUsage(response.usage), stopReason: toolCalls.length > 0 ? 'tool_calls' : response.status === 'incomplete' ? 'length' : 'end_turn', raw: response };
}
function toResponsesInput(request: ModelRequest): Array<Record<string, unknown>> { const input: Array<Record<string, unknown>> = []; for (const message of request.messages) { if (message.role === 'assistant') { if (message.content) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content }] }); for (const call of message.toolCalls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.argumentsJson }); } else if (message.role === 'tool') input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content }); else input.push({ type: 'message', role: message.role, content: [{ type: 'input_text', text: message.content }] }); } return input; }
function toResponsesTool(tool: ToolDefinitionForModel): Record<string, unknown> { return { type: 'function', name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }; }
function normalizeUsage(usage: OpenAIResponsesResponse['usage']): Usage | undefined { return usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens } : undefined; }
function headers(apiKey: string): Record<string, string> { return { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }; }
function modelError(response: Response): Error { return new Error(`Model request failed: HTTP ${response.status} ${response.statusText}`); }
function trim(value: string): string { return value.replace(/\/+$/, ''); }
