import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ToolDefinition, ToolContext } from './types.js';
import { assertSafeWritePath, normalizeRelative, resolveWorkspacePath } from './path-guard.js';

const MAX_READ_LINES = 400;
const MAX_LIST_ENTRIES = 300;
const MAX_SEARCH_RESULTS = 100;
const fileLocks = new Map<string, Promise<void>>();

export function createFileTools(): ToolDefinition[] {
  return [listFilesTool(), readFileTool(), writeFileTool(), hashlineEditTool(), globFilesTool(), grepFilesTool()];
}

function listFilesTool(): ToolDefinition {
  return {
    name: 'list_files',
    description: 'List files and directories under a workspace path with bounded depth and output.',
    parameters: objectSchema({
      path: { type: 'string' },
      depth: { type: 'integer' },
      includeHidden: { type: 'boolean' },
    }),
    risk: 'read',
    readonly: true,
    async handler(args: unknown, ctx: ToolContext) {
      const input = asRecord(args);
      const resolved = await resolveWorkspacePath(ctx.workspaceRoot, asString(input.path, '.'));
      const depth = Math.max(0, Math.min(asNumber(input.depth, 2), 8));
      const includeHidden = Boolean(input.includeHidden);
      const entries: string[] = [];
      await walk(resolved.absolutePath, depth, includeHidden, async (absolute, dirent) => {
        if (entries.length >= MAX_LIST_ENTRIES) return;
        const rel = normalizeRelative(path.relative(ctx.workspaceRoot, absolute));
        entries.push(`${dirent.isDirectory() ? 'dir ' : 'file'} ${rel}`);
      });
      return { path: resolved.relativePath, entries, truncated: entries.length >= MAX_LIST_ENTRIES };
    },
  };
}

function readFileTool(): ToolDefinition {
  return {
    name: 'read_file',
    description: 'Read a text file from the workspace. Use format=hashline before hashline_edit.',
    parameters: objectSchema({
      path: { type: 'string' },
      offset: { type: 'integer' },
      limit: { type: 'integer' },
      format: { type: 'string', enum: ['plain', 'hashline'] },
    }, ['path']),
    risk: 'read',
    readonly: true,
    async handler(args: unknown, ctx: ToolContext) {
      const input = asRecord(args);
      const resolved = await resolveWorkspacePath(ctx.workspaceRoot, asString(input.path));
      const buffer = await fs.readFile(resolved.absolutePath);
      rejectBinary(buffer);
      const text = buffer.toString('utf8');
      const document = parseText(text);
      const lines = document.lines;
      const offset = Math.max(1, asNumber(input.offset, 1));
      const limit = Math.max(1, Math.min(asNumber(input.limit, MAX_READ_LINES), MAX_READ_LINES));
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      const format = asString(input.format, 'plain');
      const content = format === 'hashline'
        ? selected.map((line, index) => `${offset + index}#${lineHash(line)}: ${line}`).join('\n')
        : selected.join('\n');
      return {
        path: resolved.relativePath,
        offset,
        lines: selected.length,
        totalLines: lines.length,
        fileHash: fileHash(text),
        anchorFormat: 'LINE#HASH',
        lineHashLength: 6,
        newlineStyle: document.newlineStyle,
        format,
        content,
        truncated: offset - 1 + selected.length < lines.length,
      };
    },
  };
}

function writeFileTool(): ToolDefinition {
  return {
    name: 'write_file',
    description: 'Create or overwrite a workspace text file. Cannot write .git, .env, or .nju-agent internals.',
    parameters: objectSchema({
      path: { type: 'string' },
      content: { type: 'string' },
      createDirectories: { type: 'boolean' },
    }, ['path', 'content']),
    risk: 'write',
    readonly: false,
    async handler(args: unknown, ctx: ToolContext) {
      const input = asRecord(args);
      const resolved = await resolveWorkspacePath(ctx.workspaceRoot, asString(input.path));
      assertSafeWritePath(resolved.relativePath);
      if (input.createDirectories === true) await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
      const content = asString(input.content);
      await withFileLock(resolved.absolutePath, () => atomicWrite(resolved.absolutePath, content));
      return { path: resolved.relativePath, bytes: Buffer.byteLength(content, 'utf8'), fileHash: fileHash(content) };
    },
  };
}

function hashlineEditTool(): ToolDefinition {
  return {
    name: 'hashline_edit',
    description: 'Edit a text file using LINE#HASH anchors from read_file(format=hashline). Re-read after any stale-anchor error.',
    parameters: objectSchema({
      path: { type: 'string' },
      expectedFileHash: { type: 'string' },
      edits: { type: 'array', minItems: 1, items: { oneOf: [
        objectSchema({ op: { type: 'string', enum: ['replace'] }, start: { type: 'string', pattern: '^\\d+#[a-fA-F0-9]{6}:?$' }, end: { type: 'string', pattern: '^\\d+#[a-fA-F0-9]{6}:?$' }, content: { type: 'string' } }, ['op', 'start', 'content']),
        objectSchema({ op: { type: 'string', enum: ['delete'] }, start: { type: 'string', pattern: '^\\d+#[a-fA-F0-9]{6}:?$' }, end: { type: 'string', pattern: '^\\d+#[a-fA-F0-9]{6}:?$' } }, ['op', 'start']),
        objectSchema({ op: { type: 'string', enum: ['insert_before', 'insert_after'] }, anchor: { type: 'string', pattern: '^\\d+#[a-fA-F0-9]{6}:?$' }, content: { type: 'string' } }, ['op', 'anchor', 'content']),
      ] } },
    }, ['path', 'edits']),
    risk: 'write',
    readonly: false,
    async handler(args: unknown, ctx: ToolContext) {
      const input = asRecord(args);
      const resolved = await resolveWorkspacePath(ctx.workspaceRoot, asString(input.path));
      assertSafeWritePath(resolved.relativePath);
      if (!Array.isArray(input.edits)) throw Object.assign(new Error('edits must be an array'), { code: 'invalid_arguments' });
      return withFileLock(resolved.absolutePath, async () => {
        const buffer = await fs.readFile(resolved.absolutePath);
        rejectBinary(buffer);
        const original = buffer.toString('utf8');
        const document = parseText(original);
        if (typeof input.expectedFileHash === 'string' && input.expectedFileHash !== fileHash(original)) {
          throw editError('file_revision_mismatch', 'File hash changed since it was read', '请重新调用 read_file(format="hashline") 获取新的锚点。', { expectedFileHash: input.expectedFileHash, actualFileHash: fileHash(original) });
        }
        const edits = input.edits as unknown[];
        const ranges: NormalizedEdit[] = edits.map((edit: unknown) => normalizeEdit(asRecord(edit), document.lines));
        ensureNonOverlapping(ranges);
        const next = [...document.lines];
        for (const edit of ranges.sort((a, b) => b.start - a.start)) {
          if (edit.op === 'delete') next.splice(edit.start, edit.end - edit.start + 1);
          if (edit.op === 'replace') next.splice(edit.start, edit.end - edit.start + 1, ...contentLines(edit.content ?? ''));
          if (edit.op === 'insert_before') next.splice(edit.start, 0, ...contentLines(edit.content ?? ''));
          if (edit.op === 'insert_after') next.splice(edit.start + 1, 0, ...contentLines(edit.content ?? ''));
        }
        const nextText = serializeText(next, document.newlineStyle, document.trailingNewline);
        await atomicWrite(resolved.absolutePath, nextText);
        const changed = changedAnchors(next, ranges);
        return {
          path: resolved.relativePath,
          previousFileHash: fileHash(original),
          fileHash: fileHash(nextText),
          newlineStyle: document.newlineStyle,
          editsApplied: ranges.length,
          changedAnchors: changed,
          preview: diffPreview(document.lines, next),
        };
      });
    },
  };
}

function globFilesTool(): ToolDefinition {
  return {
    name: 'glob_files',
    description: 'Find workspace files matching a simple glob pattern (*, ?, **).',
    parameters: objectSchema({ pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern']),
    risk: 'read',
    readonly: true,
    async handler(args: unknown, ctx: ToolContext) {
      const input = asRecord(args);
      const base = await resolveWorkspacePath(ctx.workspaceRoot, asString(input.path, '.'));
      const regex = globToRegExp(asString(input.pattern));
      const matches: string[] = [];
      await walk(base.absolutePath, 32, false, async (absolute, dirent) => {
        if (matches.length >= MAX_SEARCH_RESULTS || !dirent.isFile()) return;
        const rel = normalizeRelative(path.relative(ctx.workspaceRoot, absolute));
        if (regex.test(rel)) matches.push(rel);
      });
      return { matches, truncated: matches.length >= MAX_SEARCH_RESULTS };
    },
  };
}

function grepFilesTool(): ToolDefinition {
  return {
    name: 'grep_files',
    description: 'Search text files in the workspace using a JavaScript regular expression pattern.',
    parameters: objectSchema({ pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, ['pattern']),
    risk: 'read',
    readonly: true,
    async handler(args: unknown, ctx: ToolContext) {
      const input = asRecord(args);
      const base = await resolveWorkspacePath(ctx.workspaceRoot, asString(input.path, '.'));
      const pattern = new RegExp(asString(input.pattern), 'i');
      const glob = input.glob ? globToRegExp(asString(input.glob)) : undefined;
      const matches: Array<{ path: string; line: number; text: string }> = [];
      await walk(base.absolutePath, 32, false, async (absolute, dirent) => {
        if (matches.length >= MAX_SEARCH_RESULTS || !dirent.isFile()) return;
        const rel = normalizeRelative(path.relative(ctx.workspaceRoot, absolute));
        if (glob && !glob.test(rel)) return;
        const buffer = await fs.readFile(absolute);
        if (isBinary(buffer)) return;
        parseText(buffer.toString('utf8')).lines.forEach((line, index) => {
          if (matches.length < MAX_SEARCH_RESULTS && pattern.test(line)) matches.push({ path: rel, line: index + 1, text: line.slice(0, 240) });
        });
      });
      return { matches, truncated: matches.length >= MAX_SEARCH_RESULTS };
    },
  };
}

async function walk(root: string, depth: number, includeHidden: boolean, visit: (absolute: string, dirent: import('node:fs').Dirent) => Promise<void>): Promise<void> {
  if (depth < 0) return;
  let dirents: import('node:fs').Dirent[];
  try { dirents = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const dirent of dirents) {
    if (!includeHidden && dirent.name.startsWith('.')) continue;
    if (dirent.name === 'node_modules' || dirent.name === 'refs') continue;
    const absolute = path.join(root, dirent.name);
    await visit(absolute, dirent);
    if (dirent.isDirectory()) await walk(absolute, depth - 1, includeHidden, visit);
  }
}

interface NormalizedEdit { op: string; start: number; end: number; content?: string }

function normalizeEdit(edit: Record<string, unknown>, lines: string[]): NormalizedEdit {
  const op = asString(edit.op);
  const startAnchor = op.startsWith('insert_') ? asString(edit.anchor) : asString(edit.start);
  const start = validateAnchor(startAnchor, lines);
  const end = edit.end === undefined ? start : validateAnchor(asString(edit.end), lines);
  if (end < start) throw editError('invalid_anchor', 'Edit end is before edit start', '请重新读取文件并确认 start/end 顺序。');
  return { op, start, end, content: typeof edit.content === 'string' ? edit.content : undefined };
}

function validateAnchor(anchor: string, lines: string[]): number {
  const normalized = anchor.trim().replace(/:$/, '');
  const match = /^(\d+)#([a-f0-9]{6})$/i.exec(normalized);
  if (!match) throw editError('invalid_anchor', `Invalid hashline anchor: ${anchor}`, '锚点应为 LINE#HASH；可直接复制 read_file 的锚点，但不要复制整行内容。');
  const index = Number(match[1]) - 1;
  if (index < 0 || index >= lines.length) throw editError('anchor_not_found', `Anchor not found: ${anchor}`, '请重新调用 read_file(format="hashline") 获取当前文件锚点。');
  if (lineHash(lines[index]) !== match[2].toLowerCase()) throw editError('stale_anchor', `Stale hashline anchor: ${anchor}`, '文件已变化，请重新调用 read_file(format="hashline")，不要复用旧锚点。');
  return index;
}

function ensureNonOverlapping(edits: NormalizedEdit[]): void {
  const ranges = edits.map((edit) => [edit.start, edit.end] as const).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i += 1) {
    if (ranges[i][0] <= ranges[i - 1][1]) throw Object.assign(new Error('Overlapping edits are not allowed'), { code: 'overlapping_edits' });
  }
}

function diffPreview(before: string[], after: string[]): string {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const beforeEnd = before.length - suffix;
  const afterEnd = after.length - suffix;
  const lines = [
    `@@ -${prefix + 1},${Math.max(0, beforeEnd - prefix)} +${prefix + 1},${Math.max(0, afterEnd - prefix)} @@`,
    ...before.slice(prefix, beforeEnd).map((line) => `- ${line}`),
    ...after.slice(prefix, afterEnd).map((line) => `+ ${line}`),
  ];
  return lines.join('\n');
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function editError(code: string, message: string, hint: string, details?: unknown): Error & { code: string; details: unknown } {
  return Object.assign(new Error(message), { code, details: { ...(typeof details === 'object' && details !== null ? details : {}), hint } });
}

function parseText(text: string): { lines: string[]; newlineStyle: 'LF' | 'CRLF'; trailingNewline: boolean } {
  const newlineStyle = text.includes('\r\n') ? 'CRLF' : 'LF';
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const trailingNewline = normalized.endsWith('\n');
  const body = trailingNewline ? normalized.slice(0, -1) : normalized;
  return { lines: body.length === 0 ? [''] : body.split('\n'), newlineStyle, trailingNewline };
}

function contentLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return body.length === 0 ? [''] : body.split('\n');
}

function serializeText(lines: string[], newlineStyle: 'LF' | 'CRLF', trailingNewline: boolean): string {
  const body = lines.join('\n');
  const normalized = trailingNewline ? `${body}\n` : body;
  return newlineStyle === 'CRLF' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

function changedAnchors(lines: string[], edits: NormalizedEdit[]): Array<{ line: number; anchor: string; content: string }> {
  const start = Math.max(0, Math.min(...edits.map((edit) => edit.start)) - 1);
  const end = Math.min(lines.length, Math.max(...edits.map((edit) => edit.end)) + 2);
  return lines.slice(start, end).map((content, index) => {
    const line = start + index + 1;
    return { line, anchor: `${line}#${lineHash(content)}`, content };
  });
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, 'utf8');
    try { await fs.rename(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      await fs.rm(target, { force: true });
      await fs.rename(temporary, target);
    }
  } finally { await fs.rm(temporary, { force: true }); }
}

async function withFileLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(file) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  fileLocks.set(file, queued);
  await previous;
  try { return await operation(); }
  finally { release(); if (fileLocks.get(file) === queued) fileLocks.delete(file); }
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

function lineHash(line: string): string {
  return createHash('sha256').update(line).digest('hex').slice(0, 6);
}

function fileHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function rejectBinary(buffer: Buffer): void {
  if (isBinary(buffer)) throw Object.assign(new Error('Binary files cannot be read as text'), { code: 'invalid_arguments' });
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 4096).includes(0);
}

function globToRegExp(glob: string): RegExp {
  const normalized = normalizeRelative(glob);
  let source = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];
    if (char === '*' && next === '*') { source += '.*'; i += 1; continue; }
    if (char === '*') { source += '[^/]*'; continue; }
    if (char === '?') { source += '[^/]'; continue; }
    source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}