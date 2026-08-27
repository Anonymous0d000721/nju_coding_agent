import type { AgentMessage, AgentRunOptions, AgentRunResult } from './types.js';
import type { ModelClient } from '../model/model-client.js';
import { ToolExecutor } from '../tools/executor.js';
import { toolResultToMessage } from '../tools/types.js';
import { compactMessages } from '../context/compactor.js';
import { HookRegistry } from './hooks.js';

export interface AgentRunnerDeps {
  model: ModelClient;
  tools: ToolExecutor;
  systemPrompt: string;
  toolDefinitions: ReturnType<import('../tools/registry.js').ToolRegistry['definitionsForModel']>;
  onMessage?: (message: AgentMessage) => Promise<void>;
  hooks?: HookRegistry;
}

export class AgentRunner {
  constructor(private readonly deps: AgentRunnerDeps) {}

  async run(userPrompt: string, options: AgentRunOptions, signal?: AbortSignal): Promise<AgentRunResult> {
    const messages: AgentMessage[] = [...(options.initialMessages ?? []), { role: 'user', content: userPrompt }];
    const stop = async (result: AgentRunResult): Promise<AgentRunResult> => {
      await this.deps.hooks?.run('onStop', { userPrompt, turn: result.turns, signal, result });
      return result;
    };
    await this.deps.hooks?.run('beforeRun', { userPrompt, turn: 0, message: messages[messages.length - 1], signal });
    if (options.persistUserMessage !== false) await this.deps.onMessage?.(messages[messages.length - 1]);
    let toolCalls = 0;

    for (let turn = 0; turn < options.maxTurns; turn += 1) {
      if (signal?.aborted) return stop({ stopReason: 'user_cancelled', messages, turns: turn, toolCalls });
      const request = {
        systemPrompt: this.deps.systemPrompt,
        messages: compactMessages(messages, options.maxContextChars ?? 100_000).messages,
        tools: this.deps.toolDefinitions,
        thinking: options.thinking,
      };
      await this.deps.hooks?.run('beforeModelRequest', { userPrompt, turn, signal });
      const assistant = this.deps.model.stream
        ? await this.deps.model.stream(request, async (event) => { await options.onStreamEvent?.(event); }, signal)
        : await this.deps.model.complete(request, signal);
      const assistantMessage: AgentMessage = { role: 'assistant', content: assistant.text, toolCalls: assistant.toolCalls };
      messages.push(assistantMessage);
      await this.deps.onMessage?.(assistantMessage);
      if (assistant.toolCalls.length === 0) return stop({ stopReason: 'model_finished', messages, turns: turn + 1, toolCalls });
      if (toolCalls + assistant.toolCalls.length > options.maxToolCalls) return stop({ stopReason: 'max_tool_calls', messages, turns: turn + 1, toolCalls });
      for (const toolCall of assistant.toolCalls) {
        await this.deps.hooks?.run('beforeTool', { userPrompt, turn, toolCall, signal });
        await options.onStreamEvent?.({ type: 'tool_call', toolCall });
      }
      const results = await this.deps.tools.executeBatch(assistant.toolCalls, signal);
      toolCalls += results.length;
      for (const result of results) {
        await options.onStreamEvent?.({ type: 'tool_result', result });
        await this.deps.hooks?.run('afterTool', { userPrompt, turn, toolCall: assistant.toolCalls.find((call) => call.id === result.toolCallId), toolResult: result, signal });
        const toolMessage = toolResultToMessage(result);
        messages.push(toolMessage);
        await this.deps.onMessage?.(toolMessage);
      }
      await this.deps.hooks?.run('afterTurn', { userPrompt, turn, signal });
    }
    const result = { stopReason: 'max_turns' as const, messages, turns: options.maxTurns, toolCalls };
    return stop(result);
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
