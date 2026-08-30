import { readFile, rename, writeFile } from 'node:fs/promises';

export type OrderStatus = 'pending' | 'running' | 'done' | 'failed';
export interface OrderTask { id: string; title: string; status: OrderStatus; amountCents: number; dueAt: string; version: number; }
export interface OrderStore { version: number; tasks: OrderTask[]; }
export interface TaskQuery { status?: OrderStatus; overdueAt?: string; offset?: number; limit?: number; }

export async function loadStore(file: string): Promise<OrderStore> {
  return JSON.parse(await readFile(file, 'utf8')) as OrderStore;
}

export function listTasks(store: OrderStore, query: TaskQuery = {}): OrderTask[] {
  const filtered = store.tasks.filter((task) => (!query.status || task.status === query.status) && (!query.overdueAt || task.dueAt <= query.overdueAt));
  const offset = query.offset ?? 0;
  const limit = query.limit ?? filtered.length;
  return filtered.slice(offset, offset + limit);
}

export function summarize(store: OrderStore, now: string): { pendingAmountCents: number; overdueCount: number } {
  const pending = store.tasks.filter((task) => task.status === 'pending' || task.status === 'running');
  return {
    pendingAmountCents: pending.reduce((total, task) => total + task.amountCents, 0),
    overdueCount: pending.filter((task) => task.dueAt <= now).length,
  };
}

export async function updateTask(file: string, id: string, status: OrderStatus, expectedVersion: number): Promise<OrderStore> {
  const store = await loadStore(file);
  if (store.version !== expectedVersion) throw new Error(`version_conflict:${store.version}`);
  const task = store.tasks.find((item) => item.id === id);
  if (!task) throw new Error(`task_not_found:${id}`);
  if (task.status === 'done' && status !== 'done') throw new Error('completed_task_is_immutable');
  task.status = status;
  task.version += 1;
  store.version += 1;
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2) + '\n', 'utf8');
  await rename(temporary, file);
  return store;
}
