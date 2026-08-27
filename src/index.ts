import { createApp } from './app/app.js';
import { CliError } from './shared/errors.js';

async function main(): Promise<void> {
  const app = createApp({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), stdin: process.stdin, stdout: process.stdout });
  const result = await app.run();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

main().catch((error: unknown) => {
  const cliError = CliError.from(error);
  process.stderr.write(`${cliError.message}\n`);
  process.exitCode = cliError.exitCode;
});