import { describe, expect, it } from 'vitest';
import { evaluateGoalEvidence } from '../../src/agent/goal-gate.js';

describe('GoalGate', () => {
  it('requires successful command evidence for verification-oriented goals', () => {
    expect(evaluateGoalEvidence('fix the bug and run tests', [])).toMatchObject({ satisfied: false });
    expect(evaluateGoalEvidence('fix the bug and run tests', [{ toolCallId: 'c', toolName: 'run_command', ok: true, content: '', elapsedMs: 1, details: { exitCode: 0 } }])).toEqual({ satisfied: true });
  });

  it('does not require a command for a plain explanation request', () => {
    expect(evaluateGoalEvidence('explain this module', [])).toEqual({ satisfied: true });
  });
});
