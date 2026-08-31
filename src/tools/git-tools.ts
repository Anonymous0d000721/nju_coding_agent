import { spawn } from 'node:child_process';
import type { ToolContext, ToolDefinition } from './types.js';
import { redact } from '../shared/redact.js';
import { terminateProcessTree } from '../shared/process-control.js';

const MAX_OUTPUT = 12_000;

export function createGitTools(): ToolDefinition[] {
  return [
    gitTool('git_status', 'Show bounded git status for the workspace.', ['status', '--short']),
    gitTool('git_diff', 'Show a bounded read-only git diff for the workspace.', ['diff']),
    {
      name: 'git_log', description: 'Show recent read-only git commit history.',
      parameters: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false },
      risk: 'read', readonly: true,
      handler: async (args, ctx) => runGit(['log', '--oneline', `-${Math.max(1, Math.min(asLimit(args), 50))}`], ctx),
    },
  ];
}

function gitTool(name: string, description: string, command: string[]): ToolDefinition {
  return { name, description, parameters: { type: 'object', properties: {}, additionalProperties: false }, risk: 'read', readonly: true, handler: async (_args, ctx) => runGit(command, ctx) };
}

function asLimit(args: unknown): number {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 10;
  const value = (args as { limit?: unknown }).limit;
  return typeof value === 'number' && Number.isFinite(value) ? value : 10;
}

function runGit(command: string[], ctx: ToolContext): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', command, { cwd: ctx.workspaceRoot, shell: false, windowsHide: true });
    let settled = false;
    let cancelled = ctx.signal?.aborted ?? false;
    const timeout = setTimeout(() => { if (!settled) void terminateProcessTree(child).catch(() => undefined); }, 30_000);
    const onAbort = () => { cancelled = true; if (!settled) void terminateProcessTree(child).catch(() => undefined); };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const collect = (current: string, chunk: Buffer) => { const next = current + chunk.toString('utf8'); if (next.length <= MAX_OUTPUT) return next; truncated = true; return next.slice(0, MAX_OUTPUT); };
    child.stdout.on('data', (chunk: Buffer) => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = collect(stderr, chunk); });
    child.once('error', (error) => { if (settled) return; settled = true; clearTimeout(timeout); ctx.signal?.removeEventListener('abort', onAbort); reject(Object.assign(error, { code: 'git_unavailable' })); });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ctx.signal?.removeEventListener('abort', onAbort);
      if (cancelled || ctx.signal?.aborted) { reject(Object.assign(new Error('Git command cancelled'), { code: 'user_cancelled' })); return; }
      const safeError = redact(stderr.trim());
      if (exitCode !== 0) reject(Object.assign(new Error(safeError || `git ${command[0]} failed with exit code ${exitCode}`), { code: 'git_failed' }));
      else resolve({ command: command.join(' '), cwd: ctx.workspaceRoot, executable: 'git', exitCode, content: redact(stdout.trimEnd()), stderr: safeError || undefined, truncated });
    });
  });
}
