import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ToolDefinition, ToolContext } from './types.js';
import { assertSafeWritePath, normalizeRelative, resolveWorkspacePath } from './path-guard.js';

const MAX_READ_LINES = 400;
const MAX_LIST_ENTRIES = 300;
const MAX_SEARCH_RESULTS = 100;

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
      const lines = splitLines(text);
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
      await fs.writeFile(resolved.absolutePath, asString(input.content), 'utf8');
      return { path: resolved.relativePath, bytes: Buffer.byteLength(asString(input.content), 'utf8'), fileHash: fileHash(asString(input.content)) };
    },
  };
}

function hashlineEditTool(): ToolDefinition {
  return {
    name: 'hashline_edit',
    description: 'Edit a text file using LINE#HASH anchors from read_file(format=hashline).',
    parameters: objectSchema({
      path: { type: 'string' },
      expectedFileHash: { type: 'string' },
      edits: { type: 'array', items: { type: 'object' } },
    }, ['path', 'edits']),
    risk: 'write',
    readonly: false,
    async handler(args: unknown, ctx: ToolContext) {
      const input = asRecord(args);
      const resolved = await resolveWorkspacePath(ctx.workspaceRoot, asString(input.path));
      assertSafeWritePath(resolved.relativePath);
      if (!Array.isArray(input.edits)) throw Object.assign(new Error('edits must be an array'), { code: 'invalid_arguments' });
      const original = await fs.readFile(resolved.absolutePath, 'utf8');
      if (typeof input.expectedFileHash === 'string' && input.expectedFileHash !== fileHash(original)) {
        throw Object.assign(new Error('File hash changed; re-read hashline anchors before editing'), { code: 'file_revision_mismatch' });
      }
      const lines = splitLines(original);
      const ranges = input.edits.map((edit) => normalizeEdit(asRecord(edit), lines));
      ensureNonOverlapping(ranges);
      const next = [...lines];
      for (const edit of ranges.sort((a, b) => b.start - a.start)) {
        if (edit.op === 'delete') next.splice(edit.start, edit.end - edit.start + 1);
        if (edit.op === 'replace') next.splice(edit.start, edit.end - edit.start + 1, ...splitLines(edit.content ?? ''));
        if (edit.op === 'insert_before') next.splice(edit.start, 0, ...splitLines(edit.content ?? ''));
        if (edit.op === 'insert_after') next.splice(edit.start + 1, 0, ...splitLines(edit.content ?? ''));
      }
      const nextText = next.join('\n');
      await fs.writeFile(resolved.absolutePath, nextText, 'utf8');
      return { path: resolved.relativePath, fileHash: fileHash(nextText), preview: diffPreview(lines, next) };
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
        splitLines(buffer.toString('utf8')).forEach((line, index) => {
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
  if (!['replace', 'delete', 'insert_before', 'insert_after'].includes(op)) throw Object.assign(new Error(`Invalid edit op: ${op}`), { code: 'invalid_arguments' });
  const startAnchor = op.startsWith('insert_') ? asString(edit.anchor) : asString(edit.start);
  const start = validateAnchor(startAnchor, lines);
  const end = edit.end ? validateAnchor(asString(edit.end), lines) : start;
  if (end < start) throw Object.assign(new Error('edit end is before start'), { code: 'invalid_anchor' });
  return { op, start, end, content: typeof edit.content === 'string' ? edit.content : undefined };
}

function validateAnchor(anchor: string, lines: string[]): number {
  const match = /^(\d+)#([a-f0-9]{6})$/i.exec(anchor);
  if (!match) throw Object.assign(new Error(`Invalid hashline anchor: ${anchor}`), { code: 'invalid_anchor' });
  const index = Number(match[1]) - 1;
  if (index < 0 || index >= lines.length) throw Object.assign(new Error(`Anchor not found: ${anchor}`), { code: 'anchor_not_found' });
  if (lineHash(lines[index]) !== match[2].toLowerCase()) throw Object.assign(new Error(`Stale hashline anchor: ${anchor}`), { code: 'stale_anchor' });
  return index;
}

function ensureNonOverlapping(edits: NormalizedEdit[]): void {
  const ranges = edits.map((edit) => [edit.start, edit.end] as const).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i += 1) {
    if (ranges[i][0] <= ranges[i - 1][1]) throw Object.assign(new Error('Overlapping edits are not allowed'), { code: 'overlapping_edits' });
  }
}

function diffPreview(before: string[], after: string[]): string {
  const beforeText = before.join('\n');
  const afterText = after.join('\n');
  return [`before ${before.length} lines hash=${fileHash(beforeText)}`, `after ${after.length} lines hash=${fileHash(afterText)}`].join('\n');
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties, required, additionalProperties: false };
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

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
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