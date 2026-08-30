import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolveWorkspacePath, assertSafeWritePath } from '../tools/path-guard.js';
import { redact } from '../shared/redact.js';

const MAX_ARTIFACT_BYTES = 1_000_000;
const MAX_PREVIEW_CHARS = 4_000;

export interface FileMutationPayload {
  toolCallId?: string;
  operation: 'create' | 'modify' | 'delete';
  relativePath: string;
  beforeText?: string;
  afterText?: string;
  beforeHash?: string;
  afterHash?: string;
  preview?: string;
  reversible?: boolean;
}

export interface FileMutationRecord {
  id: string;
  runId: string;
  sessionId?: string;
  toolCallId: string;
  operation: FileMutationPayload['operation'];
  relativePath: string;
  beforeHash?: string;
  afterHash?: string;
  preview?: string;
  reversible: boolean;
  artifactPath?: string;
  createdAt: string;
  undoOf?: string;
}

export class ChangeJournal {
  private readonly rootDir: string;
  private readonly journalPath: string;
  private readonly artifactDir: string;
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string, private readonly runId = 'unknown', private readonly sessionId?: string, private readonly onRecord?: (record: FileMutationRecord) => Promise<void> | void) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.rootDir = path.join(this.workspaceRoot, '.nju-agent', 'logs');
    this.journalPath = path.join(this.rootDir, 'journal.jsonl');
    this.artifactDir = path.join(this.rootDir, 'journal-artifacts');
  }

  async record(payload: FileMutationPayload & { undoOf?: string }): Promise<FileMutationRecord> {
    assertSafeWritePath(payload.relativePath);
    const id = randomUUID();
    let artifactPath: string | undefined;
    const hasRestorableBefore = payload.beforeText !== undefined;
    const reversible = payload.reversible !== false && (hasRestorableBefore || payload.operation === 'create');
    const safeForArtifact = hasRestorableBefore && redact(payload.beforeText!) === payload.beforeText;
    if (reversible && safeForArtifact && Buffer.byteLength(payload.beforeText!, 'utf8') <= MAX_ARTIFACT_BYTES) {
      await fs.mkdir(this.artifactDir, { recursive: true });
      const artifact = path.join(this.artifactDir, `${id}.before`);
      await fs.writeFile(artifact, payload.beforeText!, 'utf8');
      artifactPath = path.relative(this.workspaceRoot, artifact).replaceAll(path.sep, '/');
    }
    const record: FileMutationRecord = {
      id,
      runId: this.runId,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      toolCallId: payload.toolCallId ?? 'unknown',
      operation: payload.operation,
      relativePath: payload.relativePath,
      ...(payload.beforeHash ? { beforeHash: payload.beforeHash } : {}),
      ...(payload.afterHash ? { afterHash: payload.afterHash } : {}),
      ...(payload.preview ? { preview: redact(payload.preview).slice(0, MAX_PREVIEW_CHARS) } : {}),
      reversible: payload.operation === 'create' ? reversible && Boolean(payload.afterHash) : reversible && Boolean(artifactPath),
      ...(artifactPath ? { artifactPath } : {}),
      createdAt: new Date().toISOString(),
      ...(payload.undoOf ? { undoOf: payload.undoOf } : {}),
    };
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.appendFile(this.journalPath, `${JSON.stringify(record)}\n`, 'utf8');
    await this.onRecord?.(record);
    return record;
  }

  async list(filter: { sessionId?: string; runId?: string } = {}): Promise<FileMutationRecord[]> {
    try {
      const content = await fs.readFile(this.journalPath, 'utf8');
      return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as FileMutationRecord)
        .filter((record) => (!filter.sessionId || record.sessionId === filter.sessionId) && (!filter.runId || record.runId === filter.runId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async formatDiff(filter: { sessionId?: string; runId?: string } = {}): Promise<string> {
    const records = await this.list(filter);
    if (records.length === 0) return 'No tracked file changes.';
    const entries = await Promise.all(records.slice(-20).map(async (record) => {
      const state = await this.currentState(record);
      const reversibility = record.reversible ? 'reversible' : 'not reversible';
      return `${record.operation} ${record.relativePath} · ${reversibility} · ${state}\n` +
        `before=${record.beforeHash ?? '-'} after=${record.afterHash ?? '-'} tool=${record.toolCallId} at=${record.createdAt}\n` +
        (record.preview ? record.preview : '(no diff preview)');
    }));
    return entries.join('\n\n');
  }

  async undoLast(filter: { sessionId?: string; runId?: string } = {}): Promise<{ ok: true; record: FileMutationRecord; undone: FileMutationRecord } | { ok: false; code: string; message: string }> {
    const records = await this.list();
    const scoped = records.filter((record) => (!filter.sessionId || record.sessionId === filter.sessionId) && (!filter.runId || record.runId === filter.runId));
    const undoneIds = new Set(scoped.flatMap((record) => record.undoOf ? [record.undoOf] : []));
    const target = [...scoped].reverse().find((record) => record.reversible && !undoneIds.has(record.id));
    if (!target || !target.afterHash) return { ok: false, code: 'undo_unavailable', message: 'No reversible tracked file change is available.' };
    const resolved = await resolveWorkspacePath(this.workspaceRoot, target.relativePath);
    try {
      await withJournalLock(resolved.absolutePath, async () => {
      if (target.operation === 'create') {
        let current: string;
        try { current = await fs.readFile(resolved.absolutePath, 'utf8'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw journalError('undo_conflict', `Current file is missing: ${target.relativePath}`);
          throw error;
        }
        if (hash(current) !== target.afterHash) throw journalError('undo_conflict', `File changed outside the journal: ${target.relativePath}`);
        await fs.rm(resolved.absolutePath);
        return;
      }
      if (!target.artifactPath) throw journalError('undo_unavailable', `No recovery artifact exists for ${target.relativePath}`);
      let current: string;
      try { current = await fs.readFile(resolved.absolutePath, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw journalError('undo_conflict', `Current file is missing: ${target.relativePath}`);
        throw error;
      }
      if (hash(current) !== target.afterHash) throw journalError('undo_conflict', `File changed outside the journal: ${target.relativePath}`);
      const before = await fs.readFile(path.join(this.workspaceRoot, target.artifactPath), 'utf8');
      await atomicWrite(resolved.absolutePath, before);
      });
    } catch (error) {
      const errorCode = codeOf(error);
      if (errorCode === 'undo_conflict' || errorCode === 'undo_unavailable') return { ok: false, code: errorCode, message: error instanceof Error ? error.message : String(error) };
      throw error;
    }
    const undone = await this.record({
      operation: target.operation === 'create' ? 'delete' : 'modify', relativePath: target.relativePath,
      beforeHash: target.afterHash, afterHash: target.beforeHash,
      preview: `undo ${target.id}: ${target.relativePath}`, reversible: false, toolCallId: `undo:${target.id}`, undoOf: target.id,
    });
    return { ok: true, record: target, undone };
  }

  private async currentState(record: FileMutationRecord): Promise<string> {
    if (!record.afterHash) return 'state unavailable';
    try {
      const resolved = await resolveWorkspacePath(this.workspaceRoot, record.relativePath);
      const current = await fs.readFile(resolved.absolutePath, 'utf8');
      return hash(current) === record.afterHash ? 'current' : 'externally modified';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'state unavailable';
    }
  }
}

export function hashMutationText(text: string): string { return hash(text); }
function hash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12); }
const journalLocks = new Map<string, Promise<void>>();
async function withJournalLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const previous = journalLocks.get(file) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  journalLocks.set(file, queued);
  await previous;
  try { return await operation(); } finally { release(); if (journalLocks.get(file) === queued) journalLocks.delete(file); }
}
function journalError(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
function codeOf(error: unknown): string | undefined { return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : undefined; }

async function atomicWrite(target: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, 'utf8');
    await fs.rename(temporary, target).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      await fs.rm(target, { force: true });
      await fs.rename(temporary, target);
    });
  } finally { await fs.rm(temporary, { force: true }); }
}
