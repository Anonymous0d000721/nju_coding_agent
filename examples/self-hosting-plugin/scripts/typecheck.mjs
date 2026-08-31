import { spawn } from 'node:child_process';

const files = ['nju-mcp-adaptor.mjs', 'tests/adaptor.test.mjs'];
for (const file of files) {
  const result = await run(['--check', file]);
  if (result.exitCode !== 0) process.exitCode = 1;
}
console.log(JSON.stringify({ schemaVersion: 1, status: process.exitCode ? 'failed' : 'passed', mode: 'node-syntax-check', files }));

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: 'inherit' });
    child.once('error', (error) => resolve({ exitCode: 1, error }));
    child.once('close', (exitCode) => resolve({ exitCode }));
  });
}
