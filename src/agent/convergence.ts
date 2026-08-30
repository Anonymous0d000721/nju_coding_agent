import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ToolCall } from './types.js';
import type { ToolResult } from '../tools/types.js';

export interface ConvergenceOptions {
  workspaceRoot: string;
  warningThreshold?: number;
  blockThreshold?: number;
  windowSize?: number;
}

export interface ConvergenceObservation {
  fingerprint: string;
  repeatCount: number;
  action: 'execute' | 'warn' | 'block';
}

export interface ConvergenceSummary {
  status: 'warning' | 'blocked' | 'finalized' | 'stopped';
  fingerprint: string;
  repeatCount: number;
  warningThreshold: number;
  blockThreshold: number;
  lastError?: { code?: string; message?: string };
}

export class ConvergenceTracker {
  readonly warningThreshold: number;
  readonly blockThreshold: number;
  private readonly workspaceRoot: string;
  private readonly windowSize: number;
  private readonly history: string[] = [];
  private readonly warned = new Set<string>();

  constructor(options: ConvergenceOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.warningThreshold = Math.max(2, options.warningThreshold ?? 3);
    this.blockThreshold = Math.max(this.warningThreshold + 1, options.blockThreshold ?? this.warningThreshold + 1);
    this.windowSize = Math.max(this.blockThreshold, options.windowSize ?? 8);
  }

  observe(call: ToolCall): ConvergenceObservation {
    const fingerprint = fingerprintToolCall(call, this.workspaceRoot);
    this.history.push(fingerprint);
    if (this.history.length > this.windowSize) this.history.shift();
    const repeatCount = this.history.filter((item) => item === fingerprint).length;
    if (this.warned.has(fingerprint) && repeatCount >= this.blockThreshold) return { fingerprint, repeatCount, action: 'block' };
    if (repeatCount >= this.warningThreshold && !this.warned.has(fingerprint)) {
      this.warned.add(fingerprint);
      return { fingerprint, repeatCount, action: 'warn' };
    }
    return { fingerprint, repeatCount, action: 'execute' };
  }

  summary(observation: ConvergenceObservation, status: ConvergenceSummary['status'], result?: ToolResult): ConvergenceSummary {
    return {
      status,
      fingerprint: observation.fingerprint,
      repeatCount: observation.repeatCount,
      warningThreshold: this.warningThreshold,
      blockThreshold: this.blockThreshold,
      ...(result?.error ? { lastError: { code: result.error.code, message: result.error.message } } : {}),
    };
  }
}

export function fingerprintToolCall(call: ToolCall, workspaceRoot: string): string {
  const parsed = parseArguments(call.argumentsJson);
  const normalized = normalizeValue(parsed, path.resolve(workspaceRoot), undefined);
  return createHash('sha256').update(JSON.stringify({ tool: call.name, arguments: normalized })).digest('hex');
}

export function convergenceBlockedResult(call: ToolCall, observation: ConvergenceObservation, summary: ConvergenceSummary): ToolResult {
  const message = `Repeated tool call blocked after ${observation.repeatCount} occurrences. Change strategy before trying again.`;
  return {
    toolCallId: call.id,
    toolName: call.name,
    ok: false,
    content: `Tool ${call.name} failed (convergence_warning): ${message}`,
    error: { code: 'convergence_warning', message, recoverable: true, details: summary },
    details: summary,
    preview: `failed: convergence_warning (${observation.repeatCount} repeats)`,
    elapsedMs: 0,
  };
}

export function convergenceStoppedResult(call: ToolCall, summary: ConvergenceSummary): ToolResult {
  const message = 'Tool calls are disabled because the run could not change its repeated strategy.';
  return {
    toolCallId: call.id,
    toolName: call.name,
    ok: false,
    content: `Tool ${call.name} failed (convergence_stopped): ${message}`,
    error: { code: 'convergence_stopped', message, recoverable: false, details: summary },
    details: summary,
    preview: 'failed: convergence_stopped',
    elapsedMs: 0,
  };
}

function parseArguments(raw: string): unknown {
  try { return JSON.parse(raw || '{}'); } catch { return raw; }
}

function normalizeValue(value: unknown, workspaceRoot: string, key: string | undefined): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry, workspaceRoot, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().filter((name) => !['preview', 'timestamp'].includes(name)).map((name) => [name, normalizeValue((value as Record<string, unknown>)[name], workspaceRoot, name)]));
  }
  if (typeof value !== 'string') return value;
  const normalizedKey = key?.toLowerCase();
  if (/(api.?key|token|secret|password|authorization|credential|content)/i.test(normalizedKey ?? '')) return `<sensitive:${hash(value)}>`;
  if (/(^|_|-)(path|cwd|file|directory|dir|manifest)(_|-|$)/.test(normalizedKey ?? '')) return normalizePath(value, workspaceRoot);
  return value;
}

function normalizePath(value: string, workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot, value);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return `workspace:${relative.replaceAll(path.sep, '/').toLowerCase()}`;
  return `outside:${hash(resolved.toLowerCase())}`;
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 16); }
