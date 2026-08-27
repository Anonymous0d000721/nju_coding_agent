import fs from 'node:fs/promises';
import path from 'node:path';

export interface ResolvedWorkspacePath {
  absolutePath: string;
  relativePath: string;
}

export async function resolveWorkspacePath(workspaceRoot: string, inputPath = '.'): Promise<ResolvedWorkspacePath> {
  const root = path.resolve(workspaceRoot);
  const absolutePath = path.resolve(root, inputPath);
  if (!isInsidePath(root, absolutePath)) {
    throw Object.assign(new Error(`Path is outside workspace: ${inputPath}`), { code: 'path_outside_workspace' });
  }

  const existingPath = await nearestExistingPath(absolutePath);
  const realRoot = await fs.realpath(root);
  const realExisting = await fs.realpath(existingPath);
  if (!isInsidePath(realRoot, realExisting)) {
    throw Object.assign(new Error(`Path resolves outside workspace: ${inputPath}`), { code: 'path_outside_workspace' });
  }

  return {
    absolutePath,
    relativePath: normalizeRelative(path.relative(root, absolutePath)),
  };
}

export function assertSafeWritePath(relativePath: string): void {
  const normalized = normalizeRelative(relativePath);
  if (normalized === '.git' || normalized.startsWith('.git/')) {
    throw Object.assign(new Error('Writing inside .git is not allowed'), { code: 'sensitive_path' });
  }
  if (normalized === '.env' || normalized.startsWith('.env.') || normalized.includes('/.env')) {
    throw Object.assign(new Error('Writing secret-bearing env files is not allowed'), { code: 'sensitive_path' });
  }
  if (normalized === '.nju-agent' || normalized.startsWith('.nju-agent/')) {
    throw Object.assign(new Error('Writing agent runtime state through file tools is not allowed'), { code: 'sensitive_path' });
  }
}

export function normalizeRelative(relativePath: string): string {
  return relativePath.replace(/\\/g, '/') || '.';
}

export function isInsidePath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function nearestExistingPath(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      await fs.access(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) throw Object.assign(new Error(`No existing parent for ${target}`), { code: 'not_found' });
      current = parent;
    }
  }
}