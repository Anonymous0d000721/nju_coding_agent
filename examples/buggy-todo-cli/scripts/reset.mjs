import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = resolve(root, 'fixtures', 'orders.json');
const target = resolve(root, 'runtime', 'orders.json');
await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
console.log(`reset ${target}`);
