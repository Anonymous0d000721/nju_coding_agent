import type { ToolResult } from '../tools/types.js';

export interface GoalGateDecision { satisfied: boolean; reason?: string; }

const VERIFICATION_REQUEST = /\b(test|tests|verify|verification|check|checks|fix|fixed)\b|测试|验证|检查|修复/iu;

export function evaluateGoalEvidence(goal: string, results: ToolResult[]): GoalGateDecision {
  if (!VERIFICATION_REQUEST.test(goal)) return { satisfied: true };
  const successfulCommand = results.some((result) => result.toolName === 'run_command' && result.ok && commandSucceeded(result.details));
  if (successfulCommand) return { satisfied: true };
  return { satisfied: false, reason: 'The goal requests a fix or verification, but no successful run_command validation is recorded.' };
}

function commandSucceeded(details: unknown): boolean {
  return Boolean(details && typeof details === 'object' && 'exitCode' in details && (details as { exitCode?: unknown }).exitCode === 0);
}
