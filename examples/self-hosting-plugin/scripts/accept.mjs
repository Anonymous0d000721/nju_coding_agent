import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exampleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'nju-plugin-accept-'));
try {
  const fixtures = path.join(tempRoot, 'fixtures');
  await mkdir(fixtures);
  const valid = JSON.parse(await readFile(path.join(exampleRoot, 'fixtures', 'valid-manifest.json'), 'utf8'));
  await writeFile(path.join(fixtures, 'valid.json'), JSON.stringify(valid));
  const adaptor = (await import(`${pathToFileURL(path.join(exampleRoot, 'nju-mcp-adaptor.mjs')).href}?accept=${Date.now()}`)).default.tools[0];
  const result = await adaptor.handler({ manifestPath: 'fixtures/valid.json' }, { workspaceRoot: tempRoot });
  assert(result.tools.length === 2, 'valid manifest catalog');
  await assertRejects(() => adaptor.handler({ manifestPath: '../outside.json' }, { workspaceRoot: tempRoot }), 'manifest_outside_workspace');
  await writeFile(path.join(tempRoot, 'unsafe.json'), JSON.stringify({ ...valid, tools: [{ ...valid.tools[0], url: 'https://example.test' }] }));
  await assertRejects(() => adaptor.handler({ manifestPath: 'unsafe.json' }, { workspaceRoot: tempRoot }), 'external_execution_forbidden');
  await writeFile(path.join(tempRoot, 'duplicate.json'), JSON.stringify({ version: '1', tools: [valid.tools[0], valid.tools[0]] }));
  await assertRejects(() => adaptor.handler({ manifestPath: 'duplicate.json' }, { workspaceRoot: tempRoot }), 'invalid_tool_name');
  console.log(JSON.stringify({ schemaVersion: 1, status: 'passed', mode: 'independent-manifest-acceptance', checks: ['valid_manifest', 'outside_path', 'external_field', 'duplicate_name'] }));
} catch (error) {
  console.log(JSON.stringify({ schemaVersion: 1, status: 'failed', mode: 'independent-manifest-acceptance', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function assert(condition, message) { if (!condition) throw new Error(message); }
async function assertRejects(operation, expectedMessage) {
  try { await operation(); } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(expectedMessage)) throw new Error(`unexpected rejection: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  throw new Error(`expected rejection: ${expectedMessage}`);
}
