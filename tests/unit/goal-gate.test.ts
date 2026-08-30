import { describe, expect, it } from 'vitest';
import { evaluateGoalEvidence, markVerificationStale, summarizeVerification, verificationPlanForGoal } from '../../src/agent/goal-gate.js';
import type { VerificationEvidence } from '../../src/agent/types.js';

describe('GoalGate', () => {
  it('requires successful command evidence for verification-oriented goals', () => {
    expect(evaluateGoalEvidence('fix the bug and run tests', [])).toMatchObject({ satisfied: false });
    expect(evaluateGoalEvidence('fix the bug and run tests', [{ toolCallId: 'c', toolName: 'run_command', ok: true, content: '', elapsedMs: 1, details: { exitCode: 0 } }])).toEqual({ satisfied: true });
  });

  it('does not require a command for a plain explanation request', () => {
    expect(evaluateGoalEvidence('explain this module', [])).toEqual({ satisfied: true });
  });

  it('classifies the required checks and records structured evidence', () => {
    const plan = verificationPlanForGoal('fix the bug, run tests, typecheck, and build');
    expect(plan.requirements.map((item) => item.kind)).toEqual(['test', 'typecheck', 'build']);
    const decision = evaluateGoalEvidence('fix the bug, run tests, typecheck, and build', [
      { toolCallId: 'test', toolName: 'run_command', ok: true, content: '', elapsedMs: 10, details: { command: 'npm test', cwd: 'workspace', exitCode: 0 } },
      { toolCallId: 'types', toolName: 'run_command', ok: true, content: '', elapsedMs: 11, details: { command: 'npm run typecheck', cwd: 'workspace', exitCode: 0 } },
      { toolCallId: 'build', toolName: 'run_command', ok: true, content: '', elapsedMs: 12, details: { command: 'npm run build', cwd: 'workspace', exitCode: 0 } },
    ], [], plan);
    expect(decision.satisfied).toBe(true);
    expect(decision.summary.status).toBe('verified');
    expect(decision.summary.evidence.map((item) => [item.kind, item.status])).toEqual([
      ['test', 'passed'], ['typecheck', 'passed'], ['build', 'passed'],
    ]);
  });

  it('marks passed evidence stale after a file mutation', () => {
    const evidence: VerificationEvidence[] = [{ id: 'test:test', kind: 'test', status: 'passed', startedAt: '2026-01-01T00:00:00.000Z', elapsedMs: 1, sourceToolCallId: 'test', summary: 'test passed' }];
    const summary = summarizeVerification({ requirements: [{ kind: 'test' }], invalidateOnMutation: true }, markVerificationStale(evidence));
    expect(summary.status).toBe('stale');
    expect(summary.evidence[0]).toMatchObject({ status: 'stale' });
  });
});
