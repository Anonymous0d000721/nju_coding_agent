import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InventoryService } from '../dist/src/inventory.js';

const exampleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'nju-inventory-accept-'));
const fixture = path.join(exampleRoot, 'fixtures', 'inventory.json');
const stateFile = path.join(tempRoot, 'inventory.json');

try {
  await cp(fixture, stateFile);
  const initial = JSON.parse(await readFile(stateFile, 'utf8'));
  const service = new InventoryService(structuredClone(initial));
  try {
    const first = service.reserveBatch([{ sku: 'book-red', quantity: 2 }, { sku: 'pen-black', quantity: 5 }], 'accept-1');
    assert(first.items.find((item) => item.sku === 'book-red')?.available === 10, 'multi-line reservation');
    assert(first.audit.length === 2 && first.audit.every((event) => event.requestId === 'accept-1'), 'per-line audit');
    assertEqual(service.reserveBatch([{ sku: 'book-red', quantity: 2 }, { sku: 'pen-black', quantity: 5 }], 'accept-1'), first, 'idempotent retry');
    const beforeRollback = service.snapshot();
    await assertRejects(() => service.reserveBatch([{ sku: 'book-red', quantity: 1 }, { sku: 'book-blue', quantity: 99 }], 'accept-rollback'), 'insufficient_stock:book-blue');
    assertEqual(service.snapshot(), beforeRollback, 'atomic rollback');
    await assertRejects(() => service.reserveBatch([{ sku: 'missing', quantity: 1 }], 'accept-unknown'), 'unknown_sku:missing');
    await assertRejects(() => service.reserveBatch([{ sku: 'book-red', quantity: 0 }], 'accept-invalid'), 'invalid_quantity');
    service.release('book-red', 1);
    console.log(JSON.stringify({ schemaVersion: 1, status: 'passed', mode: 'independent-inventory-acceptance', checks: ['atomic_reservation', 'per_line_audit', 'idempotent_retry', 'rollback', 'validation', 'legacy_release'] }));
  } catch (error) {
    if (error instanceof Error && error.message === 'reserveBatch_not_implemented') {
      console.log(JSON.stringify({ schemaVersion: 1, status: 'exercise_pending', mode: 'independent-inventory-acceptance', reason: 'reserveBatch_not_implemented', expected: ['atomic_reservation', 'idempotent_retry', 'rollback', 'audit'] }));
    } else {
      throw error;
    }
  }
} catch (error) {
  console.log(JSON.stringify({ schemaVersion: 1, status: 'failed', mode: 'independent-inventory-acceptance', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function assert(condition, message) { if (!condition) throw new Error(message); }
function assertEqual(actual, expected, label) { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: mismatch`); }
async function assertRejects(operation, expectedMessage) {
  try { await operation(); } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(expectedMessage)) throw new Error(`unexpected rejection: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  throw new Error(`expected rejection: ${expectedMessage}`);
}
