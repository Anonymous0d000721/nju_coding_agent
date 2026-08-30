import fs from 'node:fs/promises';
import path from 'node:path';
import { isSensitiveRelativePath, resolveWorkspacePath } from '../tools/path-guard.js';
import { redact } from '../shared/redact.js';

const MAX_ATTACHMENT_CHARS = 20_000;

export interface PromptAttachment { requestedPath: string; relativePath: string; content: string; truncated: boolean; }
export interface ExpandedPrompt { prompt: string; attachments: PromptAttachment[]; }

export async function expandPromptAttachments(prompt: string, workspaceRoot: string): Promise<ExpandedPrompt> {
  const references = [...prompt.matchAll(/(?:^|\s)@(?:\{([^}]+)\}|([^\s]+))/g)].map((match) => match[1] ?? match[2]).filter((value): value is string => Boolean(value));
  if (references.length === 0) return { prompt, attachments: [] };
  const attachments: PromptAttachment[] = [];
  for (const requestedPath of [...new Set(references)]) {
    const resolved = await resolveWorkspacePath(workspaceRoot, requestedPath);
    if (isSensitiveRelativePath(resolved.relativePath)) throw Object.assign(new Error(`Attachment path is protected: ${resolved.relativePath}`), { code: 'sensitive_path' });
    const buffer = await fs.readFile(resolved.absolutePath);
    if (buffer.includes(0)) throw Object.assign(new Error(`Attachment is binary: ${requestedPath}`), { code: 'binary_file' });
    const decoded = buffer.toString('utf8');
    const content = redact(decoded.slice(0, MAX_ATTACHMENT_CHARS));
    attachments.push({ requestedPath, relativePath: resolved.relativePath, content, truncated: decoded.length > MAX_ATTACHMENT_CHARS });
  }
  const blocks = attachments.map((attachment) => `[File data: ${attachment.relativePath}${attachment.truncated ? ' (truncated)' : ''}]\n${attachment.content}\n[End file data]`);
  return { prompt: `${prompt}\n\n${blocks.join('\n\n')}`, attachments };
}

export function attachmentPathFromPrompt(prompt: string): string[] {
  return [...prompt.matchAll(/(?:^|\s)@(?:\{([^}]+)\}|([^\s]+))/g)].map((match) => match[1] ?? match[2]).filter((value): value is string => Boolean(value));
}
