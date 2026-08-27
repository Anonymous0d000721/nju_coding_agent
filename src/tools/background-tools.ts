import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { ToolContext, ToolDefinition } from './types.js';
import { resolveWorkspacePath } from './path-guard.js';
import { redact } from '../shared/redact.js';

const MAX_OUTPUT = 12_000;
const managers = new Map<string, BackgroundCommandManager>();

export function getBackgroundCommandManager(workspaceRoot: string): BackgroundCommandManager {
  const root = path.resolve(workspaceRoot);
  let manager = managers.get(root);
  if (!manager) { manager = new BackgroundCommandManager(); managers.set(root, manager); }
  return manager;
}

export class BackgroundCommandManager {
  private readonly jobs = new Map<string, BackgroundJob>();

  async start(command: string, cwd: string, timeoutMs: number): Promise<BackgroundJob> {
    rejectClearlyDangerous(command);
    const id = randomUUID();
    const job: BackgroundJob = { id, command, cwd, status: 'running', startedAt: new Date().toISOString(), stdout: '', stderr: '', truncated: false };
    this.jobs.set(id, job);
    const executables = process.platform === 'win32' ? ['pwsh', 'powershell.exe'] : ['pwsh'];
    await launchJob(job, executables, timeoutMs);
    return snapshot(job);
  }

  get(id: string): BackgroundJob { const job = this.jobs.get(id); if (!job) throw Object.assign(new Error(`Unknown background job: ${id}`), { code: 'not_found' }); return snapshot(job); }
  cancel(id: string): BackgroundJob { const job = this.jobs.get(id); if (!job) throw Object.assign(new Error(`Unknown background job: ${id}`), { code: 'not_found' }); if (job.status === 'running') { job.cancelled = true; job.child?.kill(); } return snapshot(job); }
}

export interface BackgroundJob {
  id: string;
  command: string;
  cwd: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  cancelled?: boolean;
  child?: ChildProcess;
}

export function createBackgroundTools(manager: BackgroundCommandManager): ToolDefinition[] {
  return [
    { name: 'background_command', description: 'Start an explicit PowerShell command in the background. Use background_status or background_cancel by id.', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeoutMs: { type: 'integer' } }, required: ['command'], additionalProperties: false }, risk: 'shell', readonly: false, handler: async (args, ctx) => { const input = args as { command: string; cwd?: string; timeoutMs?: number }; const cwd = await resolveWorkspacePath(ctx.workspaceRoot, input.cwd ?? '.'); return manager.start(input.command, cwd.absolutePath, Math.max(1_000, Math.min(input.timeoutMs ?? 3_600_000, 3_600_000))); } },
    { name: 'background_status', description: 'Read the bounded status and output of a background command.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, risk: 'read', readonly: true, handler: async (args) => manager.get((args as { id: string }).id) },
    { name: 'background_cancel', description: 'Cancel a running background command by id.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, risk: 'shell', readonly: false, handler: async (args) => manager.cancel((args as { id: string }).id) },
  ];
}

async function launchJob(job: BackgroundJob, executables: string[], timeoutMs: number): Promise<void> {
  let index = 0;
  await new Promise<void>((resolve, reject) => {
    const launch = () => {
      const executable = executables[index];
      if (!executable) { job.status = 'failed'; job.finishedAt = new Date().toISOString(); reject(Object.assign(new Error('PowerShell executable not found'), { code: 'shell_not_found' })); return; }
      const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', job.command], { cwd: job.cwd, shell: false, windowsHide: true });
      job.child = child;
      const timer = setTimeout(() => { if (job.status === 'running') { job.status = 'timed_out'; child.kill(); } }, timeoutMs);
      const append = (key: 'stdout' | 'stderr', chunk: Buffer) => { const text = job[key] + chunk.toString('utf8'); if (text.length > MAX_OUTPUT) { job[key] = text.slice(0, MAX_OUTPUT); job.truncated = true; } else job[key] = text; };
      child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
      child.once('error', (error) => { clearTimeout(timer); if ((error as NodeJS.ErrnoException).code === 'ENOENT' && index < executables.length - 1) { index += 1; launch(); return; } job.status = 'failed'; job.finishedAt = new Date().toISOString(); reject(error); });
      child.once('spawn', () => resolve());
      child.once('close', (code) => { clearTimeout(timer); job.exitCode = code; job.finishedAt = new Date().toISOString(); if (job.cancelled) job.status = 'cancelled'; else if (job.status === 'running') job.status = code === 0 ? 'completed' : 'failed'; });
    };
    launch();
  });
}

function snapshot(job: BackgroundJob): BackgroundJob { const { child: _child, ...value } = job; return { ...value, stdout: redact(value.stdout.trimEnd()), stderr: redact(value.stderr.trimEnd()) }; }
function rejectClearlyDangerous(command: string): void { if (['format ', 'remove-item env:', 'get-childitem env:', 'gci env:', 'rm -rf /'].some((item) => command.toLowerCase().includes(item))) throw Object.assign(new Error('Command is denied by the P0 safety baseline'), { code: 'permission_denied' }); }
