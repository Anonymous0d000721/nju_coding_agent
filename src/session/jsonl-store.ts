import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMessageEntry, createSummaryEntry } from './entries.js';
import type { AgentSession, CreateSessionOptions, SessionDisplayPage, SessionEntry, SessionStartEntry } from './session-types.js';

export class JsonlSessionStore {
  constructor(private readonly rootDir: string) {}

  async create(options: CreateSessionOptions): Promise<AgentSession> {
    const sessionId = randomUUID();
    const sessionPath = this.sessionPath(sessionId);
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    const start: SessionStartEntry = {
      type: 'session_start',
      id: randomUUID(),
      sessionId,
      timestamp: new Date().toISOString(),
      schemaVersion: 1,
      cwd: options.cwd,
      model: options.model,
      appVersion: options.appVersion,
      parentSessionId: options.parentSessionId,
      name: options.name,
    };
    await this.appendLine(sessionPath, start);
    return { id: sessionId, path: sessionPath, entries: [start] };
  }

  async open(idOrPath: string): Promise<AgentSession> {
    const sessionPath = idOrPath.endsWith('.jsonl') ? path.resolve(idOrPath) : this.sessionPath(idOrPath);
    const content = await fs.readFile(sessionPath, 'utf8');
    const entries = parseSessionJsonl(content, sessionPath);
    const first = entries[0];
    if (!first || first.type !== 'session_start') throw new Error(`Session file lacks session_start: ${sessionPath}`);
    return { id: first.sessionId, path: sessionPath, entries };
  }

  async readDisplayPage(sessionId: string, options: { beforeEntryId?: string; limit?: number } = {}): Promise<SessionDisplayPage> {
    const session = await this.open(sessionId);
    const limit = options.limit ?? 80;
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`Invalid session history page limit: ${limit}`);
    const boundary = options.beforeEntryId === undefined
      ? session.entries.length
      : session.entries.findIndex((entry) => entry.id === options.beforeEntryId);
    if (boundary < 0) throw new Error(`Unknown session history cursor: ${options.beforeEntryId}`);
    const start = Math.max(0, boundary - limit);
    const entries = session.entries.slice(start, boundary);
    return { entries, name: sessionName(session.entries), hasMore: start > 0, nextBeforeEntryId: start > 0 ? entries[0]?.id : undefined };
  }

  async fork(sessionId: string, throughEntryId?: string): Promise<AgentSession> {
    const parent = await this.open(sessionId);
    const boundary = throughEntryId === undefined ? parent.entries.length : parent.entries.findIndex((entry) => entry.id === throughEntryId) + 1;
    if (boundary < 1) throw new Error(`Unknown fork entry: ${throughEntryId}`);
    const start = parent.entries.find((entry) => entry.type === 'session_start');
    if (!start || start.type !== 'session_start') throw new Error(`Session file lacks session_start: ${parent.path}`);
    const child = await this.create({ cwd: start.cwd, model: start.model, appVersion: start.appVersion, parentSessionId: parent.id, name: start.name ? `${start.name} fork` : undefined });
    for (const entry of parent.entries.slice(1, boundary)) {
      if (entry.type === 'message') await this.append(child.id, createMessageEntry(child.id, entry.message));
      if (entry.type === 'summary') await this.append(child.id, createSummaryEntry(child.id, entry.summary, [], entry.reason));
    }
    return this.open(child.id);
  }

  async append(sessionId: string, entry: SessionEntry): Promise<void> {
    if (entry.sessionId !== sessionId) throw new Error(`Entry sessionId mismatch: ${entry.sessionId} !== ${sessionId}`);
    await fs.mkdir(path.join(this.rootDir, 'sessions'), { recursive: true });
    await this.appendLine(this.sessionPath(sessionId), entry);
  }

  async list(): Promise<Array<{ id: string; path: string; mtimeMs: number; name?: string }>> {
    const sessionsDir = path.join(this.rootDir, 'sessions');
    try {
      const files = await fs.readdir(sessionsDir, { withFileTypes: true });
      const summaries = await Promise.all(files
        .filter((file) => file.isFile() && file.name.endsWith('.jsonl'))
        .map(async (file) => {
          const sessionPath = path.join(sessionsDir, file.name);
          const stat = await fs.stat(sessionPath);
          const entries = parseSessionJsonl(await fs.readFile(sessionPath, 'utf8'), sessionPath);
          return { id: file.name.slice(0, -'.jsonl'.length), path: sessionPath, mtimeMs: stat.mtimeMs, name: sessionName(entries) };
        }));
      return summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.rootDir, 'sessions', `${sessionId}.jsonl`);
  }

  private async appendLine(filePath: string, entry: SessionEntry): Promise<void> {
    await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

export function sessionName(entries: SessionEntry[]): string | undefined {
  const renamed = [...entries].reverse().find((entry) => entry.type === 'session_name');
  if (renamed?.type === 'session_name') return renamed.name;
  const start = entries.find((entry) => entry.type === 'session_start');
  return start?.type === 'session_start' ? start.name : undefined;
}

export function parseSessionJsonl(content: string, source = '<memory>'): SessionEntry[] {
  const lines = content.split('\n');
  const entries: SessionEntry[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as SessionEntry;
      if (entry.schemaVersion !== 1) throw new Error(`Unsupported schemaVersion: ${String(entry.schemaVersion)}`);
      entries.push(entry);
    } catch (error) {
      const isLastNonEmpty = lines.slice(i + 1).every((later) => !later.trim());
      if (isLastNonEmpty) break;
      throw new Error(`Invalid JSONL at ${source}:${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return entries;
}