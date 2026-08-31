import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const exampleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(exampleRoot, '../..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'nju-buggy-baseline-'));

try {
  for (const entry of ['package.json', 'tsconfig.json']) await cp(path.join(exampleRoot, entry), path.join(tempRoot, entry));
  for (const entry of ['src', 'tests', 'fixtures']) await cp(path.join(exampleRoot, entry), path.join(tempRoot, entry), { recursive: true });
  const source = path.join(tempRoot, 'src', 'order-service.ts');
  let content = await readFile(source, 'utf8');
  content = content.replace('task.dueAt <= query.overdueAt', 'task.dueAt < query.overdueAt');
  content = content.replace("task.status === 'pending' || task.status === 'running'", "task.status !== 'done'");
  await writeFile(source, content, 'utf8');
  const result = await runTests(tempRoot);
  console.log(JSON.stringify({ schemaVersion: 1, status: result.exitCode === 0 ? 'unexpected_pass' : 'expected_failed', mode: 'buggy-fixture-copy', exitCode: result.exitCode, output: summarize(result) }));
  if (result.exitCode === 0) process.exitCode = 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function runTests(cwd) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--root', cwd], { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-4_000); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.once('error', (error) => resolve({ exitCode: null, stdout, stderr: `${stderr}${error.message}` }));
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function summarize(result) {
  const output = `${result.stdout}${result.stderr}`.trim();
  return output.length > 1_000 ? `${output.slice(0, 1_000)}…` : output;
}
