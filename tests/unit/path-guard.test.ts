import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkspacePath, assertSafeWritePath, isSensitiveRelativePath } from '../../src/tools/path-guard.js';

async function fixture() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nju-path-guard-'));
}

describe('workspace path guard', () => {
  it('rejects NUL, absolute, drive-switch, UNC, and relative escape paths', async () => {
    const root = await fixture();
    await expect(resolveWorkspacePath(root, 'bad\u0000name')).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(resolveWorkspacePath(root, path.resolve(root, '..', 'outside.txt'))).rejects.toMatchObject({ code: 'path_outside_workspace' });
    await expect(resolveWorkspacePath(root, 'D:\\outside.txt')).rejects.toMatchObject({ code: 'path_outside_workspace' });
    await expect(resolveWorkspacePath(root, '\\\\server\\share\\outside.txt')).rejects.toMatchObject({ code: 'path_outside_workspace' });
    expect(() => assertSafeWritePath('C:\\outside.txt')).toThrowError(/workspace-relative/);
    expect(() => assertSafeWritePath('bad\u0000name')).toThrowError(/NUL/);
  });

  it('rejects symlinked files and directories that resolve outside the workspace', async () => {
    const root = await fixture();
    const outside = await fixture();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
    try {
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
      await fs.symlink(outside, path.join(root, 'linked-dir'), 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    await expect(resolveWorkspacePath(root, 'link.txt')).rejects.toMatchObject({ code: 'path_outside_workspace' });
    await expect(resolveWorkspacePath(root, 'linked-dir')).rejects.toMatchObject({ code: 'path_outside_workspace' });
  });

  it('matches protected credential and runtime paths case-insensitively', () => {
    for (const value of ['.GIT/config', '.NJU-AGENT/logs', 'NODE_MODULES/pkg', '.env.local', '.ssh/id_rsa', 'cert.CRT', 'user.credentials']) {
      expect(isSensitiveRelativePath(value)).toBe(true);
    }
    expect(isSensitiveRelativePath('.env.example')).toBe(false);
  });
});
