import type { AgentMessage, AgentRunOptions, AgentRunProgress, AgentRunResult } from './types.js';
import type { ModelClient } from '../model/model-client.js';
import { ToolExecutor } from '../tools/executor.js';
import { toolResultToMessage } from '../tools/types.js';
import { compactMessages } from '../context/compactor.js';
import { HookRegistry } from './hooks.js';
import { collectVerificationEvidence, evaluateGoalEvidence, markVerificationStale, summarizeVerification, verificationPlanForGoal } from './goal-gate.js';
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
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const runController = new AbortController();
    let deadlineExceeded = false;
    const onParentAbort = () => runController.abort(signal?.reason);
    if (signal?.aborted) runController.abort(signal.reason);
    else signal?.addEventListener('abort', onParentAbort, { once: true });
    const deadlineMs = options.maxDurationMs;
    const deadline = deadlineMs === undefined ? undefined : setTimeout(() => {
      deadlineExceeded = true;
      runController.abort(new Error('Agent runtime deadline exceeded'));
    }, Math.max(1, deadlineMs));
    const runSignal = runController.signal;
    const stopReason = (): AgentRunResult['stopReason'] => deadlineExceeded ? 'budget_exhausted' : 'user_cancelled';
    const messages: AgentMessage[] = [...(options.initialMessages ?? []), { role: 'user', content: userPrompt, sessionEntryId: options.userMessageEntryId }];
    const warnings: string[] = [];
    const errors: string[] = [];
    let compactions = 0;
    const stop = async (result: AgentRunResult): Promise<AgentRunResult> => {
      if (deadline) clearTimeout(deadline);
      signal?.removeEventListener('abort', onParentAbort);
      options.control?.drainQueue();
      options.control?.drainSteers();
      const enriched: AgentRunResult = {
        ...result,
        compactions,
        startedAt,
        endedAt: new Date().toISOString(),
        elapsedMs: Date.now() - started,
        ...(deadlineMs !== undefined ? { budget: { maxDurationMs: deadlineMs, ...(deadlineExceeded ? { exhausted: true } : {}) } } : {}),
        ...(compactions > 0 ? { lastCompactionReason: 'threshold' as const } : {}),
        ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
        ...(errors.length > 0 ? { errors: [...new Set(errors)] } : {}),
      };
      await options.onProgress?.({
        runId: options.runId,
        phase: 'stop',
        turn: enriched.turns,
        toolCalls: enriched.toolCalls,
        toolResults: [...toolResults],
        verification: enriched.verification,
        compactions,
        warnings: enriched.warnings ?? [],
        errors: enriched.errors ?? [],
        elapsedMs: enriched.elapsedMs,
        budget: enriched.budget,
      });
      await this.deps.hooks?.run('onStop', { userPrompt, turn: enriched.turns, signal: runSignal, result: enriched });
      return enriched;
    };
    await this.deps.hooks?.run('beforeRun', { userPrompt, turn: 0, message: messages[messages.length - 1], signal: runSignal });
    if (options.persistUserMessage !== false) await this.deps.onMessage?.(messages[messages.length - 1]);
    let toolCalls = 0;
    const toolResults = [] as import('../tools/types.js').ToolResult[];
    const verificationPlan = verificationPlanForGoal(userPrompt);
    let verificationEvidence = [] as import('./types.js').VerificationEvidence[];
    const convergence = new ConvergenceTracker({ workspaceRoot: this.deps.tools.workspaceRoot });
    let convergenceSummary: import('./convergence.js').ConvergenceSummary | undefined;
    let finalizingConvergence = false;

    const verificationSummary = (): import('./types.js').VerificationSummary | undefined => verificationPlan.requirements.length
      ? summarizeVerification(verificationPlan, verificationEvidence)
      : undefined;
    const progress = async (phase: AgentRunProgress['phase'], currentToolName?: string): Promise<void> => {
      const verification = verificationSummary();
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
        elapsedMs: Date.now() - started,
        ...(deadlineMs !== undefined ? { budget: { maxDurationMs: deadlineMs, ...(deadlineExceeded ? { exhausted: true } : {}) } } : {}),
        ...(currentToolName ? { currentToolName } : {}),
      });
    };

    let turn = 0;
    while (true) {
      if (runSignal.aborted) return stop({ stopReason: stopReason(), messages, turns: turn, toolCalls, toolResults, convergence: convergenceSummary, verification: verificationSummary() });
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
      await this.deps.hooks?.run('beforeModelRequest', { userPrompt, turn, signal: runSignal });
      const currentTurn = turn;
      let assistant;
      try {
        assistant = this.deps.model.stream
          ? await this.deps.model.stream(request, async (event) => { await options.onStreamEvent?.(event); }, runSignal)
          : await this.deps.model.complete(request, runSignal);
      } catch (error) {
        if (runSignal.aborted) return stop({ stopReason: stopReason(), messages, turns: turn, toolCalls, toolResults, convergence: convergenceSummary, verification: verificationSummary() });
        throw error;
      }
      if (runSignal.aborted) return stop({ stopReason: stopReason(), messages, turns: turn, toolCalls, toolResults, convergence: convergenceSummary, verification: verificationSummary() });
      const assistantMessage: AgentMessage = { role: 'assistant', content: assistant.text, toolCalls: assistant.toolCalls.map((toolCall) => ({ ...toolCall, preview: formatToolCallPreview(toolCall, options.previewLines) })) };
      messages.push(assistantMessage);
      await this.deps.onMessage?.(assistantMessage);
      if (runSignal.aborted) return stop({ stopReason: stopReason(), messages, turns: turn, toolCalls, toolResults, convergence: convergenceSummary, verification: verificationSummary() });
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
      const executableCalls: import('./types.js').ToolCall[] = [];
      const immediateResults = new Map<string, import('../tools/types.js').ToolResult>();
      for (const toolCall of assistant.toolCalls) {
        await this.deps.hooks?.run('beforeTool', { userPrompt, turn: currentTurn, toolCall, signal: runSignal });
        const preview = formatToolCallPreview(toolCall, options.previewLines);
        await options.onStreamEvent?.({ type: 'tool_call', toolCall: { ...toolCall, preview }, preview });
        await progress('tool_start', toolCall.name);
        if (finalizingConvergence) {
          const observation = convergence.observe(toolCall);
          const summary = convergence.summary(observation, 'stopped', immediateResults.get(toolCall.id));
          convergenceSummary = summary;
          immediateResults.set(toolCall.id, convergenceStoppedResult(toolCall, summary));
          continue;
        }
        const observation = convergence.observe(toolCall);
        if (observation.action === 'block') {
          const summary = convergence.summary(observation, 'blocked', immediateResults.get(toolCall.id));
          convergenceSummary = summary;
          immediateResults.set(toolCall.id, convergenceBlockedResult(toolCall, observation, summary));
          finalizingConvergence = true;
          const warning = `Repeated tool call blocked (${observation.repeatCount} occurrences). Provide a concise final summary without using tools.`;
          warnings.push(warning);
          turnWarnings.push(warning);
          continue;
        }
        executableCalls.push(toolCall);
        if (observation.action === 'warn') {
          convergenceSummary = convergence.summary(observation, 'warning');
          const warning = `The same tool call has been repeated ${observation.repeatCount} times. Please change strategy if it is not making progress.`;
          warnings.push(warning);
          turnWarnings.push(warning);
        }
      }
      const executedResults = executableCalls.length > 0 ? await this.deps.tools.executeBatch(executableCalls, runSignal, options.maxConcurrency) : [];
      const executedById = new Map(executedResults.map((result) => [result.toolCallId, result]));
      for (const toolCall of assistant.toolCalls) {
        const result = immediateResults.get(toolCall.id) ?? executedById.get(toolCall.id);
        if (result) results.push(result);
      }
      toolResults.push(...results);
      if (results.some((result) => result.ok && ['write_file', 'hashline_edit'].includes(result.toolName))) verificationEvidence = markVerificationStale(verificationEvidence);
      verificationEvidence = collectVerificationEvidence(results, verificationEvidence);
      toolCalls += results.length;
      await progress('tool_result');
      if (turnWarnings.length > 0) messages.push({ role: 'user', content: `[Host convergence warning]\n${turnWarnings.join('\n')}` });
      for (const result of results) {
        await options.onStreamEvent?.({ type: 'tool_result', result });
        await this.deps.hooks?.run('afterTool', { userPrompt, turn: currentTurn, toolCall: assistant.toolCalls.find((call) => call.id === result.toolCallId), toolResult: result, signal: runSignal });
        const toolMessage = toolResultToMessage(result);
        messages.push(toolMessage);
        await this.deps.onMessage?.(toolMessage);
      }
      await this.deps.hooks?.run('afterTurn', { userPrompt, turn: currentTurn, signal: runSignal });
      await progress('turn_end');
      if (convergenceSummary?.status === 'stopped') return stop({ stopReason: 'convergence_stopped', messages, turns: turn, toolCalls, toolResults, verification: verificationSummary(), convergence: convergenceSummary });
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
