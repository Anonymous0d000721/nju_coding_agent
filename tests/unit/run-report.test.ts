import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRunReport, writeRunReport } from '../../src/telemetry/report.js';

describe('run report', () => {
  it('summarizes tool evidence and redacts the goal', async () => {
    const report = createRunReport('run-1', 'fix sk-test-secret', {
      stopReason: 'model_finished', turns: 2, toolCalls: 1,
      messages: [
        { role: 'user', content: 'fix' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'run_command', argumentsJson: '{}' }] },
        { role: 'tool', toolCallId: 'call-1', content: 'Tool run_command failed (process_failed)' },
      ],
    });
    expect(report.goal).not.toContain('sk-test-secret');
    expect(report.tools).toEqual([{ name: 'run_command', ok: false }]);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-report-'));
    const reportPath = await writeRunReport(root, report);
    expect(JSON.parse(await fs.readFile(reportPath, 'utf8'))).toMatchObject({ runId: 'run-1', toolCalls: 1 });
  });
});
