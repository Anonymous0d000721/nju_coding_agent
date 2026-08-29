import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { InventoryService } from '../dist/src/inventory.js';
const file = fileURLToPath(new URL('../runtime/inventory.json', import.meta.url));
const state = JSON.parse(await readFile(file, 'utf8'));
const service = new InventoryService(state);
console.log(JSON.stringify(service.reserveBatch([{ sku: 'book-red', quantity: 2 }, { sku: 'pen-black', quantity: 5 }], 'demo-001'), null, 2));
await import('node:fs/promises').then(({ writeFile }) => writeFile(file, JSON.stringify(service.snapshot(), null, 2) + '\n'));
