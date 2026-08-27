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
    const messages: AgentMessage[] = [{ role: 'user', content: userPrompt }];
    await this.deps.onMessage?.(messages[0]);
    let toolCalls = 0;

    for (let turn = 0; turn < options.maxTurns; turn += 1) {
      if (signal?.aborted) return { stopReason: 'user_cancelled', messages, turns: turn, toolCalls };

      const assistant = await this.deps.model.complete({
        systemPrompt: this.deps.systemPrompt,
        messages,
        tools: this.deps.toolDefinitions,
      }, signal);

      const assistantMessage: AgentMessage = { role: 'assistant', content: assistant.text, toolCalls: assistant.toolCalls };
      messages.push(assistantMessage);
      await this.deps.onMessage?.(assistantMessage);

      if (assistant.toolCalls.length === 0) {
        return { stopReason: 'model_finished', messages, turns: turn + 1, toolCalls };
      }

      if (toolCalls + assistant.toolCalls.length > options.maxToolCalls) {
        return { stopReason: 'max_tool_calls', messages, turns: turn + 1, toolCalls };
      }

      const results = await this.deps.tools.executeBatch(assistant.toolCalls);
      toolCalls += results.length;
      for (const result of results) {
        const toolMessage = toolResultToMessage(result);
        messages.push(toolMessage);
        await this.deps.onMessage?.(toolMessage);
      }
    }

    return { stopReason: 'max_turns', messages, turns: options.maxTurns, toolCalls };
  }
}