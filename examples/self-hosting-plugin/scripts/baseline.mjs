import { spawn } from 'node:child_process';
import path from 'node:path';

const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const result = await new Promise((resolve) => {
  const child = spawn(process.execPath, [npmCli, 'test', '--', '--run'], { cwd: process.cwd(), windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-4_000); });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
  child.once('error', (error) => resolve({ exitCode: null, stdout, stderr: `${stderr}${error.message}` }));
  child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
});

const output = `${result.stdout}${result.stderr}`.trim();
console.log(JSON.stringify({ schemaVersion: 1, status: result.exitCode === 0 ? 'passed' : 'failed', mode: 'manifest-adaptor-fixture', exitCode: result.exitCode, output: output.length > 1_000 ? `${output.slice(0, 1_000)}…` : output }));
if (result.exitCode !== 0) process.exitCode = 1;
