import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { InventoryService } from '../dist/src/inventory.js';
const file = fileURLToPath(new URL('../runtime/inventory.json', import.meta.url));
const state = JSON.parse(await readFile(file, 'utf8'));
const service = new InventoryService(state);
try {
  const result = service.reserveBatch([{ sku: 'book-red', quantity: 2 }, { sku: 'pen-black', quantity: 5 }], 'demo-001');
  console.log(JSON.stringify({ schemaVersion: 1, status: 'passed', mode: 'inventory-demo', result }, null, 2));
  await import('node:fs/promises').then(({ writeFile }) => writeFile(file, JSON.stringify(service.snapshot(), null, 2) + '\n'));
} catch (error) {
  if (!(error instanceof Error) || error.message !== 'reserveBatch_not_implemented') throw error;
  console.log(JSON.stringify({ schemaVersion: 1, status: 'exercise_pending', mode: 'inventory-demo', reason: 'reserveBatch_not_implemented' }));
}
