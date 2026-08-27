import { describe, expect, it } from 'vitest';
import { createGitTools } from '../../src/tools/git-tools.js';

describe('git tools', () => {
  it('exposes read-only status, diff, and log tools', async () => {
    const tools = createGitTools();
    expect(tools.map((tool) => tool.name)).toEqual(['git_status', 'git_diff', 'git_log']);
    expect(tools.every((tool) => tool.risk === 'read' && tool.readonly)).toBe(true);
    const result = await tools[0]!.handler({}, { workspaceRoot: process.cwd() });
    expect(result).toMatchObject({ exitCode: 0, content: expect.any(String) });
  });

  it('rejects a non-repository workspace with a structured git error', async () => {
    const tools = createGitTools();
    await expect(tools[0]!.handler({}, { workspaceRoot: 'C:\\' })).rejects.toMatchObject({ code: 'git_failed' });
  });
});
