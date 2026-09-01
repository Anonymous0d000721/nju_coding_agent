import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { redact } from '../shared/redact.js';

export type TelemetryMode = 'off' | 'normal' | 'debug';
export const TELEMETRY_SCHEMA_VERSION = 1;

/** Versioned event envelope shared by runtime, session, and external-tool telemetry. */
export interface TelemetryEvent {
  schemaVersion?: 1;
  eventId?: string;
  type: string;
  timestamp?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  approvalId?: string;
  verificationId?: string;
  compactionId?: string;
  mutationId?: string;
  data?: Record<string, unknown>;
}

export interface TelemetryQuery {
  type?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  approvalId?: string;
  verificationId?: string;
  compactionId?: string;
  mutationId?: string;
  limit?: number;
}

export interface TelemetryStoreOptions {
  /** Maximum bytes for the active JSONL file. Older files are rotated before this is exceeded. */
  maxBytes?: number;
  /** Number of rotated files retained in addition to the active file. */
  maxFiles?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
const MAX_STRING_CHARS = 2_000;
const MAX_ARRAY_ITEMS = 100;
const writeLocks = new Map<string, Promise<void>>();

/** Writes versioned, redacted JSONL telemetry with bounded rotation and simple field queries. */
export class TelemetryStore {
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(private readonly filePath: string, private readonly mode: TelemetryMode = 'normal', private readonly secrets: string[] = [], options: TelemetryStoreOptions = {}) {
    this.maxBytes = Math.max(1_024, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES));
    this.maxFiles = Math.max(1, Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES));
  }

  async append(event: TelemetryEvent): Promise<void> {
    if (this.mode === 'off') return;
    const previous = writeLocks.get(this.filePath) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.appendLocked(event));
    writeLocks.set(this.filePath, current);
    try {
      await current;
    } finally {
      if (writeLocks.get(this.filePath) === current) writeLocks.delete(this.filePath);
    }
  }

  async readEvents(): Promise<TelemetryEvent[]> {
    const events: TelemetryEvent[] = [];
    for (const file of await this.logFiles()) {
      let content: string;
      try { content = await fs.readFile(file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      for (const line of content.split(/\r?\n/).filter(Boolean)) {
        try {
          const parsed = JSON.parse(line) as unknown;
          if (isRecord(parsed) && typeof parsed.type === 'string') events.push(parsed as unknown as TelemetryEvent);
        } catch {
          // Ignore a torn line so one interrupted write cannot hide later evidence.
        }
      }
    }
    return events;
  }

  async query(query: TelemetryQuery = {}): Promise<TelemetryEvent[]> {
    const matches = (await this.readEvents()).filter((event) =>
      (!query.type || event.type === query.type) &&
      (!query.sessionId || event.sessionId === query.sessionId) &&
      (!query.runId || event.runId === query.runId) &&
      (!query.toolCallId || event.toolCallId === query.toolCallId) &&
      (!query.approvalId || event.approvalId === query.approvalId) &&
      (!query.verificationId || event.verificationId === query.verificationId) &&
      (!query.compactionId || event.compactionId === query.compactionId) &&
      (!query.mutationId || event.mutationId === query.mutationId));
    if (query.limit === undefined) return matches;
    const limit = Math.max(0, Math.floor(query.limit));
    return limit === 0 ? [] : matches.slice(-limit);
  }

  private async appendLocked(event: TelemetryEvent): Promise<void> {
    const normalized = normalizeEvent(event);
    const redacted = JSON.parse(redact(JSON.stringify(normalized), { extraSecrets: this.secrets })) as TelemetryEvent;
    const safe = fitEvent(redacted, this.maxBytes);
    const line = `${JSON.stringify(safe)}\n`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    let size = 0;
    try { size = (await fs.stat(this.filePath)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (size > 0 && size + Buffer.byteLength(line, 'utf8') > this.maxBytes) await this.rotate();
    await fs.appendFile(this.filePath, line, 'utf8');
  }

  private async rotate(): Promise<void> {
    for (let index = this.maxFiles; index >= 2; index -= 1) {
      const source = `${this.filePath}.${index - 1}`;
      const target = `${this.filePath}.${index}`;
      try { await fs.rename(source, target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    try { await fs.rename(this.filePath, `${this.filePath}.1`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  private async logFiles(): Promise<string[]> {
    const files: string[] = [];
    try { await fs.access(this.filePath); files.push(this.filePath); } catch { /* no current file */ }
    for (let index = 1; index <= this.maxFiles; index += 1) {
      const file = `${this.filePath}.${index}`;
      try { await fs.access(file); files.unshift(file); } catch { /* rotation slot is empty */ }
    }
    return files;
  }
}

function normalizeEvent(event: TelemetryEvent): TelemetryEvent {
  const data = event.data ?? {};
  const dataId = (key: string): string | undefined => typeof data[key] === 'string' ? data[key] as string : undefined;
  const field = (explicit: string | undefined, key: string): string | undefined => explicit ?? dataId(key);
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventId: event.eventId ?? randomUUID(),
    type: event.type,
    timestamp: event.timestamp ?? new Date().toISOString(),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
    ...(field(event.toolCallId, 'toolCallId') ? { toolCallId: field(event.toolCallId, 'toolCallId') } : {}),
    ...(field(event.approvalId, 'requestId') ? { approvalId: field(event.approvalId, 'requestId') } : {}),
    ...(field(event.verificationId, 'verificationId') ? { verificationId: field(event.verificationId, 'verificationId') } : {}),
    ...(field(event.compactionId, 'compactionId') ? { compactionId: field(event.compactionId, 'compactionId') } : {}),
    ...(field(event.mutationId, 'id') ? { mutationId: field(event.mutationId, 'id') } : {}),
    ...(Object.keys(data).length ? { data: boundTelemetryValue(data) as Record<string, unknown> } : {}),
  };
}

function fitEvent(event: TelemetryEvent, maxBytes: number): TelemetryEvent {
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') <= maxBytes) return event;
  const originalBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
  const data = { truncated: true, originalBytes, fields: Object.keys(event.data ?? {}) };
  return { ...event, data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function boundTelemetryValue(value: unknown): unknown {
  if (typeof value === 'string') return value.length <= MAX_STRING_CHARS ? value : `${value.slice(0, MAX_STRING_CHARS)}…`;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map(boundTelemetryValue);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, boundTelemetryValue(item)]));
  return value;
}
