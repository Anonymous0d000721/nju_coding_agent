import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exampleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'nju-plugin-demo-'));
try {
  const fixtures = path.join(tempRoot, 'fixtures');
  await mkdir(fixtures);
  await writeFile(path.join(fixtures, 'valid.json'), await readFile(path.join(exampleRoot, 'fixtures', 'valid-manifest.json')));
  const adaptor = (await import(`${pathToFileURL(path.join(exampleRoot, 'nju-mcp-adaptor.mjs')).href}?demo=${Date.now()}`)).default;
  const result = await adaptor.tools[0].handler({ manifestPath: 'fixtures/valid.json' }, { workspaceRoot: tempRoot });
  console.log(JSON.stringify({ schemaVersion: 1, status: 'passed', mode: 'manifest-adaptor-demo', manifestPath: result.manifestPath, tools: result.tools.map((tool) => tool.name) }));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
