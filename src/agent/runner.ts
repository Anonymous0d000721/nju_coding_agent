import type { AgentMessage, AgentRunOptions, AgentRunResult } from './types.js';
import type { ModelClient } from '../model/model-client.js';
import { ToolExecutor } from '../tools/executor.js';
import { toolResultToMessage } from '../tools/types.js';
import { compactMessages } from '../context/compactor.js';
import { HookRegistry } from './hooks.js';
import { evaluateGoalEvidence } from './goal-gate.js';

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
    const messages: AgentMessage[] = [...(options.initialMessages ?? []), { role: 'user', content: userPrompt, sessionEntryId: options.userMessageEntryId }];
    const stop = async (result: AgentRunResult): Promise<AgentRunResult> => {
      options.control?.drainQueue();
      options.control?.drainSteers();
      await this.deps.hooks?.run('onStop', { userPrompt, turn: result.turns, signal, result });
      return result;
    };
    await this.deps.hooks?.run('beforeRun', { userPrompt, turn: 0, message: messages[messages.length - 1], signal });
    if (options.persistUserMessage !== false) await this.deps.onMessage?.(messages[messages.length - 1]);
    let toolCalls = 0;
    const toolResults = [] as import('../tools/types.js').ToolResult[];

    for (let turn = 0; turn < options.maxTurns; turn += 1) {
      if (signal?.aborted) return stop({ stopReason: 'user_cancelled', messages, turns: turn, toolCalls });
      const steers = options.control?.drainSteers() ?? [];
      for (const steer of steers) messages.push({ role: 'user', content: `[Steering message]\n${steer}` });
      const compacted = (options.compactor ?? compactMessages)(messages, options.maxContextChars ?? 100_000);
      if (compacted.compacted) {
        messages.splice(0, messages.length, ...compacted.messages);
        await options.onCompaction?.({
          summary: compacted.summary,
          omittedMessages: compacted.omittedMessages,
          coveredEntryIds: compacted.coveredEntryIds,
          firstKeptEntryId: compacted.firstKeptEntryId,
          stats: compacted.stats,
        });
      }
      const request = {
        systemPrompt: this.deps.systemPrompt,
        messages: compacted.messages,
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
      if (assistant.toolCalls.length === 0) {
        const steersAfterAnswer = options.control?.drainSteers() ?? [];
        const queued = options.control?.drainQueue() ?? [];
        for (const message of steersAfterAnswer) messages.push({ role: 'user', content: `[Steering message]\n${message}` });
        for (const message of queued) messages.push({ role: 'user', content: `[Queued message]\n${message}` });
        if (steersAfterAnswer.length > 0 || queued.length > 0) continue;
        if (options.goalGate) {
          const decision = evaluateGoalEvidence(userPrompt, toolResults);
          if (!decision.satisfied && turn + 1 < options.maxTurns) {
            messages.push({ role: 'user', content: `[Host verification requirement]\n${decision.reason}\nUse available tools to gather the missing evidence before finalizing.` });
            continue;
          }
        }
        return stop({ stopReason: 'model_finished', messages, turns: turn + 1, toolCalls });
      }
      if (toolCalls + assistant.toolCalls.length > options.maxToolCalls) return stop({ stopReason: 'max_tool_calls', messages, turns: turn + 1, toolCalls });
      for (const toolCall of assistant.toolCalls) {
        await this.deps.hooks?.run('beforeTool', { userPrompt, turn, toolCall, signal });
        await options.onStreamEvent?.({ type: 'tool_call', toolCall });
      }
      const results = await this.deps.tools.executeBatch(assistant.toolCalls, signal);
      toolResults.push(...results);
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
