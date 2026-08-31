import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxOutput = 5_000;
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const examples = [
  {
    name: 'buggy-todo-cli',
    protectedFiles: ['src/order-service.ts', 'tests/order-service.test.ts', 'tests/todo.test.ts', 'fixtures/orders.json'],
    expectedTest: 'passed',
    expectedBaseline: 'expected_failed',
    expectedAccept: 'passed',
  },
  {
    name: 'feature-development',
    protectedFiles: ['src/inventory.ts', 'tests/inventory.test.ts', 'fixtures/inventory.json'],
    expectedTest: 'expected_failed',
    expectedBaseline: 'expected_failed',
    expectedAccept: 'exercise_pending',
  },
  {
    name: 'self-hosting-plugin',
    protectedFiles: ['nju-mcp-adaptor.mjs', 'tests/adaptor.test.mjs', 'fixtures/valid-manifest.json', 'fixtures/outside-manifest.json'],
    expectedTest: 'passed',
    expectedBaseline: 'passed',
    expectedAccept: 'passed',
  },
];

const report = {
  schemaVersion: 1,
  mode: 'deterministic-example-acceptance',
  startedAt: new Date().toISOString(),
  finishedAt: undefined,
  status: 'running',
  examples: [],
  errors: [],
};

try {
  for (const example of examples) report.examples.push(await verifyExample(example));
  report.status = 'completed';
} catch (error) {
  report.status = 'infrastructure_failed';
  report.errors.push(error instanceof Error ? error.message : String(error));
} finally {
  report.finishedAt = new Date().toISOString();
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== 'completed') process.exitCode = 1;

async function verifyExample(example) {
  const cwd = path.join(root, 'examples', example.name);
  const initialHashes = await snapshot(cwd, example.protectedFiles);
  const evidence = { name: example.name, commands: [], lifecycle: undefined, reset: undefined, protectedFiles: undefined, status: 'running' };

  await expectCommand(evidence, cwd, 'reset', (result) => result.exitCode === 0);
  evidence.lifecycle = await runJsonCommand(evidence, cwd, 'lifecycle', (value) => value.status === 'completed' && value.transitions.join('>') === 'running>cancelled>resumed>completed');
  await expectCommand(evidence, cwd, 'reset', (result) => result.exitCode === 0);
  await expectCommand(evidence, cwd, 'baseline', (result) => result.exitCode === 0 && result.evidence?.status === example.expectedBaseline);

  await expectCommand(evidence, cwd, 'demo', (result) => result.exitCode === 0);
  await expectCommand(evidence, cwd, 'demo', (result) => result.exitCode === 0);
  const testResult = await expectCommand(evidence, cwd, 'test', (result) => example.expectedTest === 'passed'
    ? result.exitCode === 0
    : result.exitCode !== 0 && result.combined.includes('reserveBatch_not_implemented'));
  if (example.expectedTest === 'passed' && testResult.exitCode !== 0) throw new Error(`${example.name}: tests failed unexpectedly`);
  await expectCommand(evidence, cwd, 'typecheck', (result) => result.exitCode === 0);
  await expectCommand(evidence, cwd, 'build', (result) => result.exitCode === 0);
  await expectCommand(evidence, cwd, 'accept', (result) => result.exitCode === 0 && result.evidence?.status === example.expectedAccept);

  await expectCommand(evidence, cwd, 'reset', (result) => result.exitCode === 0);
  const firstReset = await resetHash(cwd, example.name);
  await expectCommand(evidence, cwd, 'reset', (result) => result.exitCode === 0);
  const secondReset = await resetHash(cwd, example.name);
  evidence.reset = { repeated: true, first: firstReset, second: secondReset, stable: JSON.stringify(firstReset) === JSON.stringify(secondReset) };
  if (!evidence.reset.stable) throw new Error(`${example.name}: reset is not repeatable`);

  const finalHashes = await snapshot(cwd, example.protectedFiles);
  evidence.protectedFiles = { unchanged: JSON.stringify(initialHashes) === JSON.stringify(finalHashes), files: finalHashes };
  if (!evidence.protectedFiles.unchanged) throw new Error(`${example.name}: protected source, tests, or fixtures changed`);
  evidence.status = 'completed';
  return evidence;
}

async function expectCommand(evidence, cwd, script, predicate) {
  const result = await runCommand(cwd, ['run', script]);
  evidence.commands.push({ script, exitCode: result.exitCode, elapsedMs: result.elapsedMs, output: summarize(result) });
  if (!predicate(result)) throw new Error(`${path.basename(cwd)}: npm run ${script} did not meet its acceptance rule`);
  return result;
}

async function runJsonCommand(evidence, cwd, script, predicate) {
  const result = await expectCommand(evidence, cwd, script, (item) => item.exitCode === 0 && item.evidence && predicate(item.evidence));
  return result.evidence;
}

async function runCommand(cwd, args) {
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const started = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [npmCli, ...args], { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const append = (current, next) => `${current}${next}`.slice(-maxOutput);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk.toString()); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk.toString()); });
    child.once('error', (error) => resolve({ exitCode: null, stdout, stderr: `${stderr}${error.message}`, combined: `${stdout}${stderr}`, elapsedMs: Date.now() - started }));
    child.once('close', (exitCode) => {
      const combined = `${stdout}${stderr}`;
      resolve({ exitCode, stdout, stderr, combined, evidence: parseEvidence({ stdout }), elapsedMs: Date.now() - started });
    });
  });
}

function parseEvidence(result) {
  const lines = result.stdout.split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && 'status' in value) return value;
    } catch {
      // npm and build tools may add non-JSON lines.
    }
  }
  return undefined;
}

async function snapshot(cwd, files) {
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, await hash(path.join(cwd, file))])));
}

async function resetHash(cwd, name) {
  if (name === 'buggy-todo-cli' || name === 'feature-development') {
    const runtime = path.join(cwd, 'runtime', name === 'buggy-todo-cli' ? 'orders.json' : 'inventory.json');
    const fixture = path.join(cwd, 'fixtures', name === 'buggy-todo-cli' ? 'orders.json' : 'inventory.json');
    return { runtimeHash: await hash(runtime), fixtureHash: await hash(fixture) };
  }
  try {
    await stat(path.join(cwd, 'runtime'));
    throw new Error(`${name}: reset left runtime output behind`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { runtimeAbsent: true };
  }
}

async function hash(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function summarize(result) {
  const output = result.combined.trim();
  return output.length > 1_000 ? `${output.slice(0, 1_000)}…` : output;
}
