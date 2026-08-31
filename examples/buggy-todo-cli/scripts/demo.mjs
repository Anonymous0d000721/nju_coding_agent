import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadStore, listTasks, summarize, updateTask } from '../dist/src/order-service.js';

const file = fileURLToPath(new URL('../runtime/orders.json', import.meta.url));
const before = await loadStore(file);
console.log(JSON.stringify({ page: listTasks(before, { status: 'pending', limit: 2 }).map((task) => task.id), summary: summarize(before, '2026-09-02T00:00:00.000Z') }, null, 2));
const existing = before.tasks.find((task) => task.id === 'o-100');
const updated = existing?.status === 'pending' ? await updateTask(file, 'o-100', 'running', before.version) : before;
console.log(JSON.stringify({ version: updated.version, task: updated.tasks.find((task) => task.id === 'o-100'), repeated: existing?.status !== 'pending' }, null, 2));
console.log(`persistedBytes=${(await readFile(file)).byteLength}`);
