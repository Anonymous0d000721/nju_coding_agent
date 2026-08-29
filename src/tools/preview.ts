import type { ToolCall } from '../agent/types.js';
import type { ToolResult } from './types.js';
import { redact } from '../shared/redact.js';

export const DEFAULT_TOOL_PREVIEW_LINES = 8;
const MAX_PREVIEW_LINE_CHARS = 240;

export function formatToolCallPreview(call: ToolCall, maxLines = DEFAULT_TOOL_PREVIEW_LINES): string {
  const args = parseArgs(call.argumentsJson);
  if (call.name === 'read_file') {
    const path = stringArg(args, 'path', '(unknown file)');
    const offset = numberArg(args, 'offset', 1);
    const limit = numberArg(args, 'limit', 400);
    return `read ${path} lines ${offset}–${offset + Math.max(0, limit - 1)}`;
  }
  if (call.name === 'write_file') {
    return lines(`write ${stringArg(args, 'path', '(unknown file)')}`, stringArg(args, 'content', ''), maxLines);
  }
  if (call.name === 'hashline_edit') return `edit ${stringArg(args, 'path', '(unknown file)')} (${Array.isArray(args?.edits) ? args.edits.length : 0} edit${Array.isArray(args?.edits) && args.edits.length === 1 ? '' : 's'})`;
  if (call.name === 'run_command') return `run ${redact(stringArg(args, 'command', ''))}`;
  return genericCall(call.name, args, maxLines);
}

export function formatToolResultPreview(call: ToolCall, value: unknown, result: Pick<ToolResult, 'ok' | 'error'>, maxLines = DEFAULT_TOOL_PREVIEW_LINES): string {
  if (!result.ok) return `failed: ${result.error?.code ?? 'error'}${result.error?.message ? ` — ${redact(result.error.message)}` : ''}`;
  const details = isRecord(value) ? value : undefined;
  if (call.name === 'read_file' && details) {
    const path = stringArg(details, 'path', stringArg(parseArgs(call.argumentsJson), 'path', '(unknown file)'));
    const offset = numberArg(details, 'offset', 1);
    const count = numberArg(details, 'lines', 0);
    return `read ${path} lines ${offset}–${Math.max(offset, offset + count - 1)}${details.truncated ? ' …' : ''}`;
  }
  if (call.name === 'hashline_edit' && details && typeof details.preview === 'string') return `edit ${stringArg(details, 'path', stringArg(parseArgs(call.argumentsJson), 'path', '(unknown file)'))}\n${head(details.preview, maxLines)}`;
  if (call.name === 'run_command' && details) {
    const command = redact(stringArg(details, 'command', stringArg(parseArgs(call.argumentsJson), 'command', '')));
    const output = [stringArg(details, 'stdout', ''), stringArg(details, 'stderr', '')].filter(Boolean).join('\n');
    return lines(`run ${command}`, output, maxLines);
  }
  if (call.name === 'write_file') return lines(`write ${stringArg(parseArgs(call.argumentsJson), 'path', '(unknown file)')}`, stringArg(parseArgs(call.argumentsJson), 'content', ''), maxLines);
  return genericResult(call.name, value, maxLines);
}

function genericCall(name: string, args: Record<string, unknown> | undefined, maxLines: number): string {
  if (!args) return name;
  const summary = Object.entries(args).filter(([key]) => !/(key|token|secret|password|authorization|content)/i.test(key)).map(([key, value]) => `${key}=${safeValue(value)}`).join(' ');
  return head(`${name}${summary ? ` ${summary}` : ''}`, maxLines);
}

function genericResult(name: string, value: unknown, maxLines: number): string {
  return lines(name, typeof value === 'string' ? value : safeJson(value), maxLines);
}

function lines(title: string, content: string, maxLines: number): string {
  const body = head(redact(content), maxLines);
  return body ? `${title}\n${body}` : title;
}

function head(value: string, maxLines: number): string {
  const rows = value.split(/\r?\n/).slice(0, Math.max(1, maxLines)).map((line) => line.length > MAX_PREVIEW_LINE_CHARS ? `${line.slice(0, MAX_PREVIEW_LINE_CHARS)}…` : line);
  const omitted = value.split(/\r?\n/).length > rows.length;
  return rows.join('\n') + (omitted ? '\n…' : '');
}

function parseArgs(raw: string): Record<string, unknown> | undefined { try { const value = JSON.parse(raw || '{}'); return isRecord(value) ? value : undefined; } catch { return undefined; } }
function stringArg(value: Record<string, unknown> | undefined, key: string, fallback: string): string { return typeof value?.[key] === 'string' ? value[key] : fallback; }
function numberArg(value: Record<string, unknown> | undefined, key: string, fallback: number): number { return typeof value?.[key] === 'number' && Number.isFinite(value[key]) ? value[key] : fallback; }
function safeValue(value: unknown): string { if (typeof value === 'string') return JSON.stringify(redact(value).slice(0, MAX_PREVIEW_LINE_CHARS)); return JSON.stringify(value); }
function safeJson(value: unknown): string { return JSON.stringify(scrub(value), null, 2) ?? ''; }
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (!isRecord(value)) return typeof value === 'string' ? redact(value) : value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/(api.?key|token|secret|password|authorization|credential)/i.test(key)).map(([key, entry]) => [key, scrub(entry)]));
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
