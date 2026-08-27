import type { AgentMessage, AgentRunOptions, AgentRunResult } from './types.js';
import type { ModelClient } from '../model/model-client.js';
import { ToolExecutor } from '../tools/executor.js';
import { toolResultToMessage } from '../tools/types.js';

export interface AgentRunnerDeps {
  model: ModelClient;
  tools: ToolExecutor;
  systemPrompt: string;
  toolDefinitions: ReturnType<import('../tools/registry.js').ToolRegistry['definitionsForModel']>;
  onMessage?: (message: AgentMessage) => Promise<void>;
}

export class AgentRunner {
  constructor(private readonly deps: AgentRunnerDeps) {}

  async run(userPrompt: string, options: AgentRunOptions, signal?: AbortSignal): Promise<AgentRunResult> {
    const messages: AgentMessage[] = [...(options.initialMessages ?? []), { role: 'user', content: userPrompt }];
    if (options.persistUserMessage !== false) await this.deps.onMessage?.(messages[messages.length - 1]);
    let toolCalls = 0;

    for (let turn = 0; turn < options.maxTurns; turn += 1) {
      if (signal?.aborted) return { stopReason: 'user_cancelled', messages, turns: turn, toolCalls };
      const request = {
        systemPrompt: this.deps.systemPrompt,
        messages: trimContext(messages, options.maxContextChars ?? 100_000),
        tools: this.deps.toolDefinitions,
        thinking: options.thinking,
      };
      const assistant = this.deps.model.stream
        ? await this.deps.model.stream(request, async (event) => { await options.onStreamEvent?.(event); }, signal)
        : await this.deps.model.complete(request, signal);
      const assistantMessage: AgentMessage = { role: 'assistant', content: assistant.text, toolCalls: assistant.toolCalls };
      messages.push(assistantMessage);
      await this.deps.onMessage?.(assistantMessage);
      if (assistant.toolCalls.length === 0) return { stopReason: 'model_finished', messages, turns: turn + 1, toolCalls };
      if (toolCalls + assistant.toolCalls.length > options.maxToolCalls) return { stopReason: 'max_tool_calls', messages, turns: turn + 1, toolCalls };
      for (const toolCall of assistant.toolCalls) await options.onStreamEvent?.({ type: 'tool_call', toolCall });
      const results = await this.deps.tools.executeBatch(assistant.toolCalls, signal);
      toolCalls += results.length;
      for (const result of results) {
        await options.onStreamEvent?.({ type: 'tool_result', result });
        const toolMessage = toolResultToMessage(result);
        messages.push(toolMessage);
        await this.deps.onMessage?.(toolMessage);
      }
    }
    return { stopReason: 'max_turns', messages, turns: options.maxTurns, toolCalls };
  }
}

function trimContext(messages: AgentMessage[], maxChars: number): AgentMessage[] {
  if (maxChars < 1) return messages.slice(-1);
  const result = [...messages];
  const size = () => result.reduce((total, message) => total + message.content.length + JSON.stringify(message.toolCalls ?? []).length, 0);
  while (result.length > 1 && size() > maxChars) {
    const removed = result.shift();
    if (removed?.role === 'assistant' && removed.toolCalls?.length) {
      while (result[0]?.role === 'tool') result.shift();
    }
    while (result[0]?.role === 'tool') result.shift();
  }
  return result;
}

export { trimContext };
