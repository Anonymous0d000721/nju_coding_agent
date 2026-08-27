import { randomUUID } from 'node:crypto';
import type { AssistantTurn, ToolCall, Usage } from '../agent/types.js';
import type { ModelClient, ModelRequest } from './model-client.js';
import type { ToolDefinitionForModel } from '../tools/types.js';

export interface OpenAIResponsesClientOptions { apiKey: string; baseUrl: string; model: string; }

export interface OpenAIResponsesResponse {
  id?: string;
  status?: string;
  output_text?: string;
  output?: Array<Record<string, unknown>>;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

export class OpenAIResponsesClient implements ModelClient {
  constructor(private readonly options: OpenAIResponsesClientOptions) {}

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<AssistantTurn> {
    const response = await fetch(`${trim(this.options.baseUrl)}/responses`, {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.options.model,
        instructions: request.systemPrompt,
        input: toResponsesInput(request),
        tools: request.tools.length > 0 ? request.tools.map(toResponsesTool) : undefined,
      }),
    });
    if (!response.ok) throw new Error(`Model request failed: HTTP ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 500)}`);
    const json = await response.json() as OpenAIResponsesResponse;
    return normalizeOpenAIResponsesResponse(json);
  }
}

export function normalizeOpenAIResponsesResponse(response: OpenAIResponsesResponse): AssistantTurn {
  const output = response.output ?? [];
  const toolCalls: ToolCall[] = output.filter((item) => item.type === 'function_call').map((item) => ({
    id: String(item.call_id ?? item.id ?? randomUUID()), name: String(item.name ?? ''), argumentsJson: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
  }));
  const text = response.output_text ?? output.filter((item) => item.type === 'message').flatMap((item) => Array.isArray(item.content) ? item.content : []).filter((item) => (item as Record<string, unknown>).type === 'output_text').map((item) => String((item as Record<string, unknown>).text ?? '')).join('');
  return { id: response.id ?? randomUUID(), text, toolCalls, usage: normalizeUsage(response.usage), stopReason: toolCalls.length > 0 ? 'tool_calls' : response.status === 'incomplete' ? 'length' : 'end_turn', raw: response };
}

function toResponsesInput(request: ModelRequest): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of request.messages) {
    if (message.role === 'assistant') {
      if (message.content) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
      for (const call of message.toolCalls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.argumentsJson });
    } else if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
    } else {
      input.push({ type: 'message', role: message.role, content: [{ type: 'input_text', text: message.content }] });
    }
  }
  return input;
}

function toResponsesTool(tool: ToolDefinitionForModel): Record<string, unknown> { return { type: 'function', name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }; }
function normalizeUsage(usage: OpenAIResponsesResponse['usage']): Usage | undefined { return usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens } : undefined; }
function trim(value: string): string { return value.replace(/\/+$/, ''); }
