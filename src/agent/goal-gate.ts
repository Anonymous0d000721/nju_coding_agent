import type { ToolResult } from '../tools/types.js';
import type { VerificationEvidence, VerificationKind, VerificationPlan, VerificationRequirement, VerificationSummary } from './types.js';

export interface GoalGateDecision { satisfied: boolean; reason?: string; summary: VerificationSummary; }

const VERIFICATION_REQUEST = /\b(test|tests|verify|verification|check|checks|build|typecheck|lint|fix|fixed)\b|测试|验证|检查|构建|修复/iu;

export function verificationPlanForGoal(goal: string): VerificationPlan {
  if (!VERIFICATION_REQUEST.test(goal)) return { requirements: [], invalidateOnMutation: true };
  const requirements: VerificationRequirement[] = [];
  if (/\btest(s)?\b|测试/iu.test(goal)) requirements.push({ kind: 'test' });
  if (/typecheck|类型检查/iu.test(goal)) requirements.push({ kind: 'typecheck' });
  if (/\bbuild\b|构建/iu.test(goal)) requirements.push({ kind: 'build' });
  if (/\blint\b/iu.test(goal)) requirements.push({ kind: 'lint' });
  if (requirements.length === 0) requirements.push({ kind: 'custom' });
  return { requirements, invalidateOnMutation: true };
}

export function collectVerificationEvidence(results: ToolResult[], previous: VerificationEvidence[] = []): VerificationEvidence[] {
  const evidence = previous.map((item) => ({ ...item }));
  for (const result of results) {
    if (result.toolName !== 'run_command') continue;
    const details = asRecord(result.details);
    const command = typeof details?.command === 'string' ? details.command : undefined;
    const kind = classifyCommand(command);
    const exitCode = typeof details?.exitCode === 'number' || details?.exitCode === null ? details.exitCode : undefined;
    evidence.push({
      id: `${result.toolCallId}:${kind}`,
      kind,
      command,
      cwd: typeof details?.cwd === 'string' ? details.cwd : undefined,
      status: exitCode === 0 ? 'passed' : 'failed',
      exitCode,
      startedAt: new Date(Date.now() - result.elapsedMs).toISOString(),
      elapsedMs: result.elapsedMs,
      sourceToolCallId: result.toolCallId,
      summary: exitCode === 0 ? `${kind} passed` : `${kind} failed${exitCode === undefined ? '' : ` (exit ${exitCode})`}`,
    });
  }
  return evidence;
}

export function evaluateGoalEvidence(goal: string, results: ToolResult[], previousEvidence: VerificationEvidence[] = [], plan = verificationPlanForGoal(goal)): GoalGateDecision {
  const evidence = collectVerificationEvidence(results, previousEvidence);
  const summary = summarizeVerification(plan, evidence);
  const decision = plan.requirements.length === 0 || summary.status === 'verified'
    ? { satisfied: true } as GoalGateDecision
    : { satisfied: false, reason: verificationDebtMessage(summary) } as GoalGateDecision;
  Object.defineProperty(decision, 'summary', { value: summary, enumerable: false });
  return decision;
}

export function summarizeVerification(plan: VerificationPlan, evidence: VerificationEvidence[]): VerificationSummary {
  const current = new Map<VerificationKind, VerificationEvidence>();
  for (const item of evidence) current.set(item.kind, item);
  if (plan.requirements.length === 0) return { plan, evidence, status: 'not_required' };
  const statuses = plan.requirements.map((requirement) => {
    const candidate = current.get(requirement.kind) ?? (plan.requirements.length === 1 ? current.get('custom') : undefined);
    if (requirement.commandPattern && candidate?.command && !new RegExp(requirement.commandPattern, 'i').test(candidate.command)) return 'not_run' as const;
    return candidate?.status ?? 'not_run' as const;
  });
  const status = statuses.every((item) => item === 'passed') ? 'verified' : statuses.some((item) => item === 'failed') ? 'failed' : statuses.some((item) => item === 'stale') ? 'stale' : 'unverified';
  return { plan, evidence, status };
}

function verificationDebtMessage(summary: VerificationSummary): string {
  const missing = summary.plan.requirements.filter((requirement) => {
    const evidence = [...summary.evidence].reverse().find((item) => item.kind === requirement.kind) ?? (summary.plan.requirements.length === 1 ? [...summary.evidence].reverse().find((item) => item.kind === 'custom') : undefined);
    return !evidence || evidence.status !== 'passed';
  }).map((requirement) => requirement.kind);
  return `Verification debt: ${missing.join(', ') || 'required evidence'} is ${summary.status}. Run the required checks in the current workspace before finalizing.`;
}

function classifyCommand(command: string | undefined): VerificationKind {
  if (!command) return 'test';
  const normalized = command.toLowerCase();
  if (/\b(test|vitest|jest|pytest|npm run test)\b/.test(normalized)) return 'test';
  if (/typecheck|tsc\s+--noemit/.test(normalized)) return 'typecheck';
  if (/\bbuild\b|tsc\s+-p/.test(normalized)) return 'build';
  if (/\blint\b|eslint/.test(normalized)) return 'lint';
  return 'custom';
}

export function markVerificationStale(evidence: VerificationEvidence[]): VerificationEvidence[] {
  return evidence.map((item) => item.status === 'passed' ? { ...item, status: 'stale', summary: `${item.summary}; stale after file mutation` } : item);
}

function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
