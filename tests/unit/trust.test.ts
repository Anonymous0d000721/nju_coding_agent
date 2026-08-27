import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectTrustStore } from '../../src/shared/trust.js';

describe('ProjectTrustStore', () => {
  it('persists canonical workspace trust and supports revoke', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-trust-'));
    const file = path.join(root, 'trust.json');
    const workspace = path.join(root, 'workspace');
    const store = new ProjectTrustStore(file);
    expect(store.isTrusted(workspace)).toBe(false);
    store.trust(path.join(workspace, '.'));
    expect(new ProjectTrustStore(file).isTrusted(workspace)).toBe(true);
    store.revoke(workspace);
    expect(new ProjectTrustStore(file).isTrusted(workspace)).toBe(false);
  });

  it('rejects malformed trust records', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-trust-'));
    const file = path.join(root, 'trust.json');
    await fs.writeFile(file, '{"version":1,"workspaces":[1]}');
    expect(() => new ProjectTrustStore(file).isTrusted(root)).toThrow('invalid trust store');
  });
});
