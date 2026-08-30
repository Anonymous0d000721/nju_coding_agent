import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRunReport, createRunStatus, readLatestRunReport, writeRunReport } from '../../src/telemetry/report.js';
import { formatRunStatus } from '../../src/app/tui.js';

describe('run report', () => {
  it('aggregates structured status from verification, commands, failures, and mutations', () => {
    const status = createRunStatus('run-2', {
      stopReason: 'user_cancelled', turns: 3, toolCalls: 3, compactions: 2, lastCompactionReason: 'threshold',
      warnings: ['warning'], errors: ['explicit error'],
      verification: { plan: { requirements: [{ kind: 'test' }], invalidateOnMutation: true }, evidence: [], status: 'stale' },
      messages: [],
      toolResults: [
        { toolCallId: 'command', toolName: 'run_command', ok: true, content: 'ok', details: { command: 'npm test', cwd: 'workspace', exitCode: 0, stdout: 'passed', stderr: '', elapsedMs: 12 }, elapsedMs: 12 },
        { toolCallId: 'write', toolName: 'write_file', ok: true, content: 'changed', details: { path: 'src/app.ts' }, elapsedMs: 2 },
        { toolCallId: 'failed', toolName: 'read_file', ok: false, content: 'failed', error: { code: 'permission_denied', message: 'denied', recoverable: true }, elapsedMs: 1 },
      ],
    }, { workspace: 'workspace', sessionId: 'session-2', model: 'test-model', effort: 'medium', permissionMode: 'yolo' });

    expect(status).toMatchObject({ state: 'cancelled', verification: { status: 'stale' }, toolSuccesses: 2, toolFailures: 1, compactions: 2, stopReason: 'user_cancelled' });
    expect(status.commands[0]).toMatchObject({ command: 'npm test', exitCode: 0, stdoutTail: 'passed' });
    expect(status.filesChanged).toEqual(['src/app.ts']);
    expect(status.errors).toEqual(['explicit error']);
  });

  it('reads the newest persisted report', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-latest-report-'));
    const report = createRunReport('run-latest', 'inspect', { stopReason: 'model_finished', turns: 1, toolCalls: 0, messages: [] });
    await writeRunReport(root, report);
    await expect(readLatestRunReport(root)).resolves.toMatchObject({ runId: 'run-latest' });
  });

  it('normalizes legacy reports before they reach status formatting', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-legacy-report-'));
    await fs.mkdir(path.join(root, 'runs'), { recursive: true });
    await fs.writeFile(path.join(root, 'runs', 'legacy.json'), JSON.stringify({
      runId: 'legacy', createdAt: new Date().toISOString(), goal: 'old run', stopReason: 'model_finished', turns: 1, toolCalls: 0, tools: [],
    }), 'utf8');

    const report = await readLatestRunReport(root);
    expect(report).toBeDefined();
    expect(() => formatRunStatus(report!)).not.toThrow();
    expect(report).toMatchObject({ commands: [], filesChanged: [], warnings: [], errors: [], verification: { status: 'not_required' } });
  });

  it('summarizes tool evidence and redacts the goal', async () => {
    const report = createRunReport('run-1', 'fix sk-test-secret', {
      stopReason: 'model_finished', turns: 2, toolCalls: 1,
      verification: { plan: { requirements: [{ kind: 'test' }], invalidateOnMutation: true }, evidence: [], status: 'stale' },
      messages: [
        { role: 'user', content: 'fix' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'run_command', argumentsJson: '{}' }] },
        { role: 'tool', toolCallId: 'call-1', content: 'Tool run_command failed (process_failed)' },
      ],
    });
    expect(report.goal).not.toContain('sk-test-secret');
    expect(report.tools).toEqual([{ name: 'run_command', ok: false }]);
    expect(report.verification.status).toBe('stale');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-report-'));
    const reportPath = await writeRunReport(root, report);
    expect(JSON.parse(await fs.readFile(reportPath, 'utf8'))).toMatchObject({ runId: 'run-1', toolCalls: 1 });
  });
});
