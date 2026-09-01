import fs from 'node:fs/promises';
import path from 'node:path';

export interface ResolvedWorkspacePath {
  absolutePath: string;
  relativePath: string;
}

export async function resolveWorkspacePath(workspaceRoot: string, inputPath = '.'): Promise<ResolvedWorkspacePath> {
  if (typeof inputPath !== 'string' || inputPath.length === 0 || inputPath.includes('\u0000')) {
    throw Object.assign(new Error('Workspace paths must be non-empty strings without NUL characters'), { code: 'invalid_path' });
  }
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

export function assertSafeReadPath(relativePath: string): void {
  if (relativePath.includes('\u0000')) throw Object.assign(new Error('Reading a path containing a NUL character is not allowed'), { code: 'invalid_path' });
  if (path.isAbsolute(relativePath)) throw Object.assign(new Error('Read paths must be workspace-relative'), { code: 'invalid_path' });
  if (isSensitiveRelativePath(relativePath)) {
    throw Object.assign(new Error('Reading a protected path is not allowed'), { code: 'sensitive_path' });
  }
}

export function assertSafeWritePath(relativePath: string): void {
  if (relativePath.includes('\u0000')) throw Object.assign(new Error('Writing a path containing a NUL character is not allowed'), { code: 'invalid_path' });
  if (path.isAbsolute(relativePath)) throw Object.assign(new Error('Write paths must be workspace-relative'), { code: 'invalid_path' });
  if (hasWindowsAlternateDataStream(relativePath)) {
    throw Object.assign(new Error('Windows alternate data streams are not supported'), { code: 'invalid_path' });
  }
  if (isSensitiveRelativePath(relativePath)) {
    throw Object.assign(new Error('Writing a protected path is not allowed'), { code: 'sensitive_path' });
  }
}

export function isSensitiveRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelative(relativePath).replace(/^\.\//, '').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  const canonicalSegments = segments.map((segment) => segment.replace(/[ .]+$/g, ''));
  if (canonicalSegments.includes('.git') || canonicalSegments.includes('.nju-agent') || canonicalSegments.includes('node_modules')) return true;
  return canonicalSegments.some((segment) => {
    if (segment === '.env.example') return false;
    if (segment === '.env' || segment.startsWith('.env.')) return true;
    if (segment.endsWith('.pem') || segment.endsWith('.key') || segment.endsWith('.p12') || segment.endsWith('.pfx') || segment.endsWith('.crt') || segment.endsWith('.cer')) return true;
    return ['.ssh', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'authorized_keys', 'credentials', 'credential', 'token', 'tokens', 'secret', 'secrets'].includes(segment)
      || segment.includes('credential') || segment.includes('token') || segment.includes('secret');
  });
}

export function normalizeRelative(relativePath: string): string {
  return relativePath.replace(/\\/g, '/') || '.';
}

function hasWindowsAlternateDataStream(relativePath: string): boolean {
  return relativePath.replace(/\\/g, '/').split('/').some((segment, index) => segment.includes(':') && !(index === 0 && /^[a-z]:$/i.test(segment)));
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