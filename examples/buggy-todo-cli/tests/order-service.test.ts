import { cp, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { loadStore, listTasks, summarize, updateTask } from '../src/order-service.js';

const fixture = new URL('../fixtures/orders.json', import.meta.url);
let file = '';

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nju-order-'));
  file = join(dir, 'orders.json');
  await cp(fixture, file);
});

describe('listTasks', () => {
  it('filters by status and applies offset/limit after filtering', async () => {
    const store = await loadStore(file);
    expect(listTasks(store, { status: 'pending', offset: 1, limit: 1 }).map((task) => task.id)).toEqual(['o-104']);
  });

  it('treats an exact due date as overdue', async () => {
    const store = await loadStore(file);
    expect(listTasks(store, { overdueAt: '2026-08-31T18:00:00.000Z' }).map((task) => task.id)).toEqual(['o-101', 'o-102']);
  });
});

describe('summarize', () => {
  it('counts only actionable pending/running amounts and excludes failed work', async () => {
    const store = await loadStore(file);
    expect(summarize(store, '2026-09-02T00:00:00.000Z')).toEqual({ pendingAmountCents: 92999, overdueCount: 2 });
  });
});

describe('updateTask', () => {
  it('increments store and task versions and writes atomically', async () => {
    const updated = await updateTask(file, 'o-100', 'running', 7);
    expect(updated.version).toBe(8);
    expect(updated.tasks.find((task) => task.id === 'o-100')?.version).toBe(2);
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(8);
  });

  it('rejects stale versions, unknown tasks, and reopening completed work', async () => {
    await expect(updateTask(file, 'o-100', 'done', 6)).rejects.toThrow('version_conflict:7');
    await expect(updateTask(file, 'o-999', 'running', 7)).rejects.toThrow('task_not_found:o-999');
    await expect(updateTask(file, 'o-102', 'running', 7)).rejects.toThrow('completed_task_is_immutable');
  });
});
