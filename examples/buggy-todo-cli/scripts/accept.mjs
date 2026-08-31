import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStore, listTasks, summarize, updateTask } from '../dist/src/order-service.js';

const exampleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'nju-buggy-accept-'));
const file = path.join(tempRoot, 'orders.json');

try {
  await cp(path.join(exampleRoot, 'fixtures', 'orders.json'), file);
  const store = await loadStore(file);
  assertEqual(listTasks(store, { status: 'pending', offset: 1, limit: 1 }).map((task) => task.id), ['o-104'], 'filtered pagination');
  assertEqual(listTasks(store, { overdueAt: '2026-08-31T18:00:00.000Z' }).map((task) => task.id), ['o-101', 'o-102'], 'inclusive overdue boundary');
  assertEqual(summarize(store, '2026-09-02T00:00:00.000Z'), { pendingAmountCents: 92999, overdueCount: 2 }, 'actionable summary');
  const updated = await updateTask(file, 'o-100', 'running', store.version);
  assertEqual(updated.version, 8, 'store version');
  assertEqual(updated.tasks.find((task) => task.id === 'o-100')?.version, 2, 'task version');
  await assertRejects(() => updateTask(file, 'o-100', 'done', 7), 'version_conflict:8');
  await assertRejects(() => updateTask(file, 'o-102', 'running', 8), 'completed_task_is_immutable');
  assertEqual(JSON.parse(await readFile(file, 'utf8')).version, 8, 'atomic persisted state');
  console.log(JSON.stringify({ schemaVersion: 1, status: 'passed', mode: 'independent-order-service-acceptance', checks: ['filtered_pagination', 'inclusive_overdue_boundary', 'actionable_summary', 'versioning', 'immutable_completion', 'atomic_persist'] }));
} catch (error) {
  console.log(JSON.stringify({ schemaVersion: 1, status: 'failed', mode: 'independent-order-service-acceptance', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function assertRejects(operation, expectedMessage) {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(expectedMessage)) throw new Error(`unexpected rejection: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  throw new Error(`expected rejection: ${expectedMessage}`);
}
