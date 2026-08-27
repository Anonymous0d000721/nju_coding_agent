import { describe, expect, it } from 'vitest';
import { BackgroundCommandManager, createBackgroundTools } from '../../src/tools/background-tools.js';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(read: () => T, ready: (value: T) => boolean): Promise<T> { for (let attempt = 0; attempt < 40; attempt += 1) { const value = read(); if (ready(value)) return value; await pause(100); } return read(); }

describe('BackgroundCommandManager', () => {
  it('starts a bounded PowerShell job and reports completion', async () => {
    const manager = new BackgroundCommandManager();
    const job = await manager.start('Write-Output done', process.cwd(), 10_000);
    const completed = await waitFor(() => manager.get(job.id), (current) => current.status !== 'running');
    expect(completed).toMatchObject({ status: 'completed', stdout: 'done' });
  });

  it('exposes shell/read/shell tool risk boundaries and cancels a job', async () => {
    const manager = new BackgroundCommandManager();
    expect(createBackgroundTools(manager).map((tool) => [tool.name, tool.risk])).toEqual([['background_command', 'shell'], ['background_status', 'read'], ['background_cancel', 'shell']]);
    const job = await manager.start('Start-Sleep -Seconds 5', process.cwd(), 10_000);
    manager.cancel(job.id);
    const cancelled = await waitFor(() => manager.get(job.id), (current) => current.status !== 'running');
    expect(cancelled.status).toBe('cancelled');
  });
});
