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
  if (isSensitiveRelativePath(relativePath)) {
    throw Object.assign(new Error('Writing a protected path is not allowed'), { code: 'sensitive_path' });
  }
}

export function isSensitiveRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelative(relativePath).replace(/^\.\//, '').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  if (segments.includes('.git') || segments.includes('.nju-agent') || segments.includes('node_modules')) return true;
  return segments.some((segment) => {
    if (segment === '.env.example') return false;
    if (segment === '.env' || segment.startsWith('.env.')) return true;
    if (segment.endsWith('.pem') || segment.endsWith('.key') || segment.endsWith('.p12') || segment.endsWith('.pfx')) return true;
    return ['id_rsa', 'id_ed25519', 'id_ecdsa', 'credentials', 'credential', 'token', 'tokens', 'secret', 'secrets'].includes(segment);
  });
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