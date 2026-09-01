import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ToolContext, WorkspaceCapabilities } from '../tools/types.js';
import { assertSafeWritePath, resolveWorkspacePath } from '../tools/path-guard.js';

const MAX_PLUGIN_READ_BYTES = 1_000_000;

export function createPluginWorkspace(context: ToolContext): WorkspaceCapabilities {
  return {
    readText: async (relativePath) => {
      const resolved = await resolveWorkspacePath(context.workspaceRoot, relativePath);
      const buffer = await fs.readFile(resolved.absolutePath);
      if (buffer.includes(0)) throw Object.assign(new Error('Binary files cannot be read as text'), { code: 'invalid_arguments' });
      if (buffer.byteLength > MAX_PLUGIN_READ_BYTES) throw Object.assign(new Error('Plugin text reads are limited to 1000000 bytes'), { code: 'output_too_large' });
      return buffer.toString('utf8');
    },
    writeText: async (relativePath, content, options = {}) => {
      assertSafeWritePath(relativePath);
      const resolved = await resolveWorkspacePath(context.workspaceRoot, relativePath);
      assertSafeWritePath(resolved.relativePath);
      if (options.createDirectories) await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
      let beforeText: string | undefined;
      try {
        const before = await fs.readFile(resolved.absolutePath);
        if (before.includes(0)) throw Object.assign(new Error('Binary files cannot be overwritten by plugin workspace API'), { code: 'invalid_arguments' });
        beforeText = before.toString('utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await atomicWrite(resolved.absolutePath, content);
      await context.onFileMutation?.({
        toolCallId: context.toolCallId ?? 'unknown',
        operation: beforeText === undefined ? 'create' : 'modify',
        relativePath: resolved.relativePath,
        beforeText,
        afterText: content,
        beforeHash: beforeText === undefined ? undefined : hash(beforeText),
        afterHash: hash(content),
        preview: beforeText === undefined ? `+ ${content}` : `- ${beforeText}\n+ ${content}`,
      });
      return { relativePath: resolved.relativePath, bytes: Buffer.byteLength(content, 'utf8'), ...(beforeText === undefined ? {} : { beforeHash: hash(beforeText) }), afterHash: hash(content) };
    },
  };
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, 'utf8');
    await fs.rename(temporary, target).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      await fs.rm(target, { force: true });
      await fs.rename(temporary, target);
    });
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12); }
