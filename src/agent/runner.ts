import type { AgentMessage, AgentRunOptions, AgentRunProgress, AgentRunResult } from './types.js';
import type { ModelClient } from '../model/model-client.js';
import { ToolExecutor } from '../tools/executor.js';
import { toolResultToMessage } from '../tools/types.js';
import { compactMessages } from '../context/compactor.js';
import { HookRegistry } from './hooks.js';
import { collectVerificationEvidence, evaluateGoalEvidence, markVerificationStale, verificationPlanForGoal } from './goal-gate.js';
import { formatToolCallPreview } from '../tools/preview.js';
import { ConvergenceTracker, convergenceBlockedResult, convergenceStoppedResult } from './convergence.js';

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
    const warnings: string[] = [];
    const errors: string[] = [];
    let compactions = 0;
    const stop = async (result: AgentRunResult): Promise<AgentRunResult> => {
      options.control?.drainQueue();
      options.control?.drainSteers();
      const enriched: AgentRunResult = {
        ...result,
        compactions,
        ...(compactions > 0 ? { lastCompactionReason: 'threshold' as const } : {}),
        ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
        ...(errors.length > 0 ? { errors: [...new Set(errors)] } : {}),
      };
      await this.deps.hooks?.run('onStop', { userPrompt, turn: enriched.turns, signal, result: enriched });
      return enriched;
    };
    await this.deps.hooks?.run('beforeRun', { userPrompt, turn: 0, message: messages[messages.length - 1], signal });
    if (options.persistUserMessage !== false) await this.deps.onMessage?.(messages[messages.length - 1]);
    let toolCalls = 0;
    const toolResults = [] as import('../tools/types.js').ToolResult[];
    const verificationPlan = verificationPlanForGoal(userPrompt);
    let verificationEvidence = [] as import('./types.js').VerificationEvidence[];
    const convergence = new ConvergenceTracker({ workspaceRoot: this.deps.tools.workspaceRoot });
    let convergenceSummary: import('./convergence.js').ConvergenceSummary | undefined;
    let finalizingConvergence = false;

    const progress = async (phase: AgentRunProgress['phase'], currentToolName?: string): Promise<void> => {
      const verification = verificationEvidence.length
        ? { plan: verificationPlan, evidence: [...verificationEvidence], status: 'stale' as const }
        : verificationPlan.requirements.length
          ? { plan: verificationPlan, evidence: [], status: 'unverified' as const }
          : undefined;
      await options.onProgress?.({
        runId: options.runId,
        phase,
        turn,
        toolCalls,
        toolResults: [...toolResults],
        verification,
        compactions,
        ...(compactions > 0 ? { lastCompactionReason: 'threshold' as const } : {}),
        warnings: [...new Set(warnings)],
        errors: [...new Set(errors)],
        ...(currentToolName ? { currentToolName } : {}),
      });
    };

    let turn = 0;
    while (true) {
      if (signal?.aborted) return stop({ stopReason: 'user_cancelled', messages, turns: turn, toolCalls, toolResults, convergence: convergenceSummary, verification: verificationEvidence.length ? { plan: verificationPlan, evidence: verificationEvidence, status: 'stale' } : undefined });
      const steers = options.control?.drainSteers() ?? [];
      for (const steer of steers) messages.push({ role: 'user', content: `[Steering message]\n${steer}` });
      const compacted = (options.compactor ?? compactMessages)(messages, options.maxContextChars ?? 100_000);
      if (compacted.compacted) {
        compactions += 1;
        messages.splice(0, messages.length, ...compacted.messages);
        await options.onCompaction?.({
          summary: compacted.summary,
          omittedMessages: compacted.omittedMessages,
          coveredEntryIds: compacted.coveredEntryIds,
          firstKeptEntryId: compacted.firstKeptEntryId,
          stats: compacted.stats,
        });
        await progress('compaction');
      }
      const request = {
        systemPrompt: this.deps.systemPrompt,
        messages: compacted.messages,
        tools: finalizingConvergence ? [] : this.deps.toolDefinitions,
        thinking: options.thinking,
      };
      await progress('model_request');
      await this.deps.hooks?.run('beforeModelRequest', { userPrompt, turn, signal });
      const currentTurn = turn;
      const assistant = this.deps.model.stream
        ? await this.deps.model.stream(request, async (event) => { await options.onStreamEvent?.(event); }, signal)
        : await this.deps.model.complete(request, signal);
      const assistantMessage: AgentMessage = { role: 'assistant', content: assistant.text, toolCalls: assistant.toolCalls.map((toolCall) => ({ ...toolCall, preview: formatToolCallPreview(toolCall, options.previewLines) })) };
      messages.push(assistantMessage);
      await this.deps.onMessage?.(assistantMessage);
      turn += 1;
      if (assistant.toolCalls.length === 0) {
        await progress('turn_end');
        const steersAfterAnswer = options.control?.drainSteers() ?? [];
        const queued = options.control?.drainQueue() ?? [];
        for (const message of steersAfterAnswer) messages.push({ role: 'user', content: `[Steering message]\n${message}` });
        for (const message of queued) messages.push({ role: 'user', content: `[Queued message]\n${message}` });
        if (steersAfterAnswer.length > 0 || queued.length > 0) continue;
        if (finalizingConvergence) {
          convergenceSummary = convergenceSummary ? { ...convergenceSummary, status: 'finalized' } : undefined;
        }
        if (options.goalGate) {
          const decision = evaluateGoalEvidence(userPrompt, [], verificationEvidence, verificationPlan);
          if (!decision.satisfied) {
            messages.push({ role: 'user', content: `[Host verification requirement]\n${decision.reason}\nUse available tools to gather the missing evidence before finalizing.` });
            continue;
          }
          return stop({ stopReason: finalizingConvergence ? 'model_finished' : 'model_finished', messages, turns: turn, toolCalls, toolResults, verification: decision.summary, convergence: convergenceSummary });
        }
        return stop({ stopReason: 'model_finished', messages, turns: turn, toolCalls, toolResults, verification: { plan: verificationPlan, evidence: verificationEvidence, status: verificationPlan.requirements.length ? 'unverified' : 'not_required' }, convergence: convergenceSummary });
      }
      const results: import('../tools/types.js').ToolResult[] = [];
      const turnWarnings: string[] = [];
      for (const toolCall of assistant.toolCalls) {
        await this.deps.hooks?.run('beforeTool', { userPrompt, turn: currentTurn, toolCall, signal });
        const preview = formatToolCallPreview(toolCall, options.previewLines);
        await options.onStreamEvent?.({ type: 'tool_call', toolCall: { ...toolCall, preview }, preview });
        await progress('tool_start', toolCall.name);
        if (finalizingConvergence) {
          const observation = convergence.observe(toolCall);
          const summary = convergence.summary(observation, 'stopped', results.at(-1));
          convergenceSummary = summary;
          results.push(convergenceStoppedResult(toolCall, summary));
          continue;
        }
        const observation = convergence.observe(toolCall);
        if (observation.action === 'block') {
          const summary = convergence.summary(observation, 'blocked', results.at(-1));
          convergenceSummary = summary;
          results.push(convergenceBlockedResult(toolCall, observation, summary));
          finalizingConvergence = true;
          const warning = `Repeated tool call blocked (${observation.repeatCount} occurrences). Provide a concise final summary without using tools.`;
          warnings.push(warning);
          turnWarnings.push(warning);
          continue;
        }
        const [result] = await this.deps.tools.executeBatch([toolCall], signal);
        results.push(result!);
        if (observation.action === 'warn') {
          convergenceSummary = convergence.summary(observation, 'warning', result);
          const warning = `The same tool call has been repeated ${observation.repeatCount} times. Please change strategy if it is not making progress.`;
          warnings.push(warning);
          turnWarnings.push(warning);
        }
      }
      toolResults.push(...results);
      if (results.some((result) => result.ok && ['write_file', 'hashline_edit'].includes(result.toolName))) verificationEvidence = markVerificationStale(verificationEvidence);
      verificationEvidence = collectVerificationEvidence(results, verificationEvidence);
      toolCalls += results.length;
      await progress('tool_result');
      if (turnWarnings.length > 0) messages.push({ role: 'user', content: `[Host convergence warning]\n${turnWarnings.join('\n')}` });
      for (const result of results) {
        await options.onStreamEvent?.({ type: 'tool_result', result });
        await this.deps.hooks?.run('afterTool', { userPrompt, turn: currentTurn, toolCall: assistant.toolCalls.find((call) => call.id === result.toolCallId), toolResult: result, signal });
        const toolMessage = toolResultToMessage(result);
        messages.push(toolMessage);
        await this.deps.onMessage?.(toolMessage);
      }
      await this.deps.hooks?.run('afterTurn', { userPrompt, turn: currentTurn, signal });
      await progress('turn_end');
      if (convergenceSummary?.status === 'stopped') return stop({ stopReason: 'convergence_stopped', messages, turns: turn, toolCalls, toolResults, verification: verificationEvidence.length ? { plan: verificationPlan, evidence: verificationEvidence, status: 'stale' } : undefined, convergence: convergenceSummary });
    }
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
