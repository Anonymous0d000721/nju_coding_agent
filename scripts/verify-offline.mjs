import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exampleRoot = path.join(projectRoot, 'examples', 'buggy-todo-cli');
const artifactRoot = path.join(projectRoot, '.nju-agent', 'logs', 'offline-e2e');
const MAX_OUTPUT = 4_000;
const sourcePath = 'src/order-service.ts';
const fixturePath = 'fixtures/orders.json';
const testPaths = ['tests/order-service.test.ts', 'tests/todo.test.ts'];

const baselinePatch = [
  ['task.dueAt <= query.overdueAt', 'task.dueAt < query.overdueAt'],
  ["task.status === 'pending' || task.status === 'running'", "task.status !== 'done'"],
];

class FakeModel {
  #index = 0;
  #plan = [
    { name: 'read_file', path: sourcePath },
    { name: 'read_file', path: 'tests/order-service.test.ts' },
    { name: 'run_command', command: 'npm test -- --run', purpose: 'baseline' },
    { name: 'hashline_edit', path: sourcePath, purpose: 'fix-known-defects' },
    { name: 'run_command', command: 'npm test -- --run', purpose: 'verification' },
    { name: 'run_command', command: 'npm run typecheck', purpose: 'verification' },
    { name: 'run_command', command: 'npm run build', purpose: 'verification' },
  ];

  next() {
    const operation = this.#plan[this.#index++];
    if (!operation) throw new Error('FakeModel exhausted before completing the verification plan');
    return operation;
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'nju-offline-e2e-'));
  const report = {
    schemaVersion: 1,
    startedAt,
    finishedAt: undefined,
    mode: 'offline-fake-model',
    networkRequests: 0,
    stopReason: 'running',
    workspace: 'temporary-copy/examples/buggy-todo-cli',
    scenarios: [],
    errors: [],
  };

  try {
    await copyScenario(tempRoot);
    const initialHashes = await snapshotProtectedFiles(tempRoot);
    for (let iteration = 1; iteration <= 2; iteration += 1) {
      report.scenarios.push(await runScenario(tempRoot, iteration, initialHashes));
    }
    report.stopReason = 'completed';
  } catch (error) {
    report.stopReason = 'fatal_error';
    report.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    report.finishedAt = new Date().toISOString();
    await mkdir(artifactRoot, { recursive: true });
    const artifactPath = path.join(artifactRoot, `${Date.now()}.json`);
    await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await rm(tempRoot, { recursive: true, force: true });
    process.stdout.write(`${JSON.stringify({ ...report, artifactPath: path.relative(projectRoot, artifactPath).replaceAll('\\', '/') }, null, 2)}\n`);
  }

  if (report.stopReason !== 'completed') process.exitCode = 1;
}

async function copyScenario(tempRoot) {
  for (const entry of ['package.json', 'tsconfig.json']) await cp(path.join(exampleRoot, entry), path.join(tempRoot, entry));
  for (const directory of ['src', 'tests', 'fixtures']) await cp(path.join(exampleRoot, directory), path.join(tempRoot, directory), { recursive: true });
  await resetScenario(tempRoot);
}

async function runScenario(root, iteration, initialHashes) {
  const model = new FakeModel();
  const trace = [];
  const validations = [];
  const source = path.join(root, sourcePath);
  await resetScenario(root);
  await applyBaselineBug(source);

  let operation = model.next();
  await recordRead(root, operation, trace);
  operation = model.next();
  await recordRead(root, operation, trace);
  operation = model.next();
  const baseline = await runCommand(root, operation.command, operation.purpose);
  trace.push({ tool: operation.name, command: operation.command, purpose: operation.purpose, ok: baseline.exitCode === 0, exitCode: baseline.exitCode, elapsedMs: baseline.elapsedMs });
  if (baseline.exitCode === 0) throw new Error(`Scenario ${iteration}: baseline unexpectedly passed`);
  validations.push({ kind: 'baseline_test', status: 'expected_failed', exitCode: baseline.exitCode, output: outputSummary(baseline) });

  operation = model.next();
  await applyKnownFix(source);
  trace.push({ tool: operation.name, path: sourcePath, purpose: operation.purpose, ok: true });

  for (const command of [
    ['npm test -- --run', 'test'],
    ['npm run typecheck', 'typecheck'],
    ['npm run build', 'build'],
  ]) {
    operation = model.next();
    const result = await runCommand(root, command[0], operation.purpose);
    trace.push({ tool: operation.name, command: command[0], purpose: operation.purpose, ok: result.exitCode === 0, exitCode: result.exitCode, elapsedMs: result.elapsedMs });
    validations.push({ kind: command[1], status: result.exitCode === 0 ? 'passed' : 'failed', exitCode: result.exitCode, output: outputSummary(result) });
    if (result.exitCode !== 0) throw new Error(`Scenario ${iteration}: ${command[1]} failed`);
  }

  const finalHashes = await snapshotProtectedFiles(root);
  assertHashesEqual(initialHashes.tests, finalHashes.tests, `Scenario ${iteration}: tests changed`);
  assertHashesEqual(initialHashes.fixture, finalHashes.fixture, `Scenario ${iteration}: fixture changed`);
  await resetScenario(root);
  const resetHash = await hashFile(path.join(root, 'runtime', 'orders.json'));
  const fixtureHash = await hashFile(path.join(root, fixturePath));
  if (resetHash !== fixtureHash) throw new Error(`Scenario ${iteration}: reset did not restore fixture`);

  return { iteration, stopReason: 'completed', toolTrace: trace, validations, protectedFiles: { testsUnchanged: true, fixtureUnchanged: true }, reset: { repeated: true, fixtureRestored: true } };
}

async function recordRead(root, operation, trace) {
  const file = path.join(root, operation.path);
  const content = await readFile(file, 'utf8');
  trace.push({ tool: operation.name, path: operation.path, ok: true, bytes: Buffer.byteLength(content, 'utf8') });
}

async function applyBaselineBug(file) {
  let content = await readFile(file, 'utf8');
  for (const [fixed, buggy] of baselinePatch) {
    if (!content.includes(fixed)) throw new Error(`Baseline patch anchor not found: ${fixed}`);
    content = content.replace(fixed, buggy);
  }
  await writeFile(file, content, 'utf8');
}

async function applyKnownFix(file) {
  let content = await readFile(file, 'utf8');
  for (const [fixed, buggy] of baselinePatch) {
    if (!content.includes(buggy)) throw new Error(`Fix anchor not found: ${buggy}`);
    content = content.replace(buggy, fixed);
  }
  await writeFile(file, content, 'utf8');
}

async function resetScenario(root) {
  await mkdir(path.join(root, 'runtime'), { recursive: true });
  await cp(path.join(root, fixturePath), path.join(root, 'runtime', 'orders.json'));
}

async function runCommand(cwd, command, purpose) {
  const started = Date.now();
  const [executable, ...args] = command === 'npm test -- --run'
    ? [process.execPath, path.join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--root', cwd]
    : command === 'npm run typecheck'
      ? [process.execPath, path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']
      : [process.execPath, path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc')];
  return await new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const append = (current, next) => {
      const value = current + next;
      if (value.length <= MAX_OUTPUT) return value;
      truncated = true;
      return value.slice(0, MAX_OUTPUT);
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk.toString('utf8')); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk.toString('utf8')); });
    child.once('error', (error) => resolve({ command, purpose, exitCode: null, stdout: '', stderr: error.message, elapsedMs: Date.now() - started, truncated }));
    child.once('close', (exitCode) => resolve({ command, purpose, exitCode, stdout, stderr, elapsedMs: Date.now() - started, truncated }));
  });
}

async function snapshotProtectedFiles(root) {
  return {
    tests: Object.fromEntries(await Promise.all(testPaths.map(async (file) => [file, await hashFile(path.join(root, file))]))),
    fixture: await hashFile(path.join(root, fixturePath)),
  };
}

async function hashFile(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function assertHashesEqual(before, after, message) {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(message);
}

function outputSummary(result) {
  const output = `${result.stdout}${result.stderr}`.trim();
  return output.length > 1_000 ? `${output.slice(0, 1_000)}…` : output;
}

await main();
