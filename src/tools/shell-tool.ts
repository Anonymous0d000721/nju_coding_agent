import { spawn } from 'node:child_process';
import type { ToolDefinition, ToolContext } from './types.js';
import { resolveWorkspacePath } from './path-guard.js';
import { redact } from '../shared/redact.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 12_000;

export function createShellTool(): ToolDefinition {
  return {
    name: 'run_command',
    description: 'Run a PowerShell command in the workspace with timeout, exit code, and bounded output.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'integer' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    risk: 'shell',
    readonly: false,
    async handler(args: unknown, ctx: ToolContext) {
      const input = asRecord(args);
      const command = asString(input.command);
      rejectClearlyDangerous(command);
      const cwd = await resolveWorkspacePath(ctx.workspaceRoot, asString(input.cwd, '.'));
      const timeoutMs = Math.max(1, Math.min(asNumber(input.timeoutMs, DEFAULT_TIMEOUT_MS), 120_000));
      return runPowerShell(command, cwd.absolutePath, timeoutMs, ctx.signal);
    },
  };
}

interface CommandResult {
  command: string;
  executable: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
  truncated: boolean;
}

async function runPowerShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
  const started = Date.now();
  const executable = process.platform === 'win32' ? 'pwsh' : 'pwsh';
  return await new Promise<CommandResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;
    let timedOut = false;

    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      cwd,
      shell: false,
      windowsHide: true,
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const onAbort = () => {
      child.kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      const appended = appendBounded(stdout, chunk.toString('utf8'));
      stdout = appended.value;
      truncated ||= appended.truncated;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const appended = appendBounded(stderr, chunk.toString('utf8'));
      stderr = appended.value;
      truncated ||= appended.truncated;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(Object.assign(error, { code: 'shell_not_found' }));
    });
    child.on('close', (exitCode, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        command,
        executable,
        exitCode,
        signal: closeSignal,
        stdout: redact(stdout.trimEnd()),
        stderr: redact(stderr.trimEnd()),
        timedOut,
        elapsedMs: Date.now() - started,
        truncated,
      });
    });
  });
}

function appendBounded(current: string, next: string): { value: string; truncated: boolean } {
  const combined = current + next;
  if (combined.length <= MAX_OUTPUT_CHARS) return { value: combined, truncated: false };
  return { value: combined.slice(0, MAX_OUTPUT_CHARS), truncated: true };
}

function rejectClearlyDangerous(command: string): void {
  const lower = command.toLowerCase();
  const denied = ['format ', 'remove-item env:', 'get-childitem env:', 'gci env:', 'rm -rf /'];
  if (denied.some((item) => lower.includes(item))) {
    throw Object.assign(new Error(`Command is denied by the P0 safety baseline: ${command}`), { code: 'permission_denied' });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw Object.assign(new Error('args must be an object'), { code: 'invalid_arguments' });
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string') throw Object.assign(new Error('expected string argument'), { code: 'invalid_arguments' });
  return value;
}

function asNumber(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number') throw Object.assign(new Error('expected number argument'), { code: 'invalid_arguments' });
  return value;
}