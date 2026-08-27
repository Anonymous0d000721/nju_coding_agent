import { randomUUID } from 'node:crypto';
import type { AssistantTurn, ToolCall, Usage } from '../agent/types.js';
import type { ModelClient, ModelRequest } from './model-client.js';

interface OpenAIChatResponse {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface OpenAICompatibleClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export class OpenAICompatibleClient implements ModelClient {
  constructor(private readonly options: OpenAICompatibleClientOptions) {}

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<AssistantTurn> {
    const response = await fetch(`${trimTrailingSlash(this.options.baseUrl)}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: toOpenAIMessages(request),
        tools: request.tools.length > 0 ? request.tools : undefined,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Model request failed: HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    }

    const json = await response.json() as OpenAIChatResponse;
    return normalizeOpenAIResponse(json);
  }
}

export function normalizeOpenAIResponse(response: OpenAIChatResponse): AssistantTurn {
  const choice = response.choices?.[0];
  const message = choice?.message;
  if (!choice || !message) throw new Error('Model response did not include choices[0].message');

  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call) => ({
    id: call.id ?? randomUUID(),
    name: call.function?.name ?? '',
    argumentsJson: call.function?.arguments ?? '{}',
  }));

  return {
    id: response.id ?? randomUUID(),
    text: message.content ?? '',
    toolCalls,
    usage: normalizeUsage(response.usage),
    stopReason: normalizeStopReason(choice.finish_reason, toolCalls.length),
    raw: response,
  };
}

function toOpenAIMessages(request: ModelRequest): Array<Record<string, unknown>> {
  return [
    { role: 'system', content: request.systemPrompt },
    ...request.messages.map((message) => {
      if (message.role === 'assistant') {
        return {
          role: 'assistant',
          content: message.content,
          tool_calls: message.toolCalls?.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.argumentsJson },
          })),
        };
      }
      if (message.role === 'tool') {
        return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
      }
      return { role: message.role, content: message.content };
    }),
  ];
}

function normalizeUsage(usage: OpenAIChatResponse['usage']): Usage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

function normalizeStopReason(finishReason: string | null | undefined, toolCallCount: number): AssistantTurn['stopReason'] {
  if (toolCallCount > 0 || finishReason === 'tool_calls') return 'tool_calls';
  if (finishReason === 'length') return 'length';
  if (finishReason === 'content_filter') return 'content_filter';
  if (!finishReason || finishReason === 'stop') return 'end_turn';
  return 'error';
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}