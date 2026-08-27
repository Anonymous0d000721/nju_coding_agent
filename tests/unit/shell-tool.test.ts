import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolExecutor } from '../../src/tools/executor.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { createShellTool } from '../../src/tools/shell-tool.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-agent-shell-'));
  const registry = new ToolRegistry();
  registry.register(createShellTool());
  return new ToolExecutor(registry, { workspaceRoot: root });
}

describe('run_command', () => {
  it('runs PowerShell commands with exit code and bounded output', async () => {
    const executor = await fixture();

    const [result] = await executor.executeBatch([
      { id: 'cmd1', name: 'run_command', argumentsJson: '{"command":"Write-Output hello"}' },
    ]);

    expect(result.ok).toBe(true);
    expect(result.content).toContain('hello');
    expect(result.content).toContain('exitCode');
  });

  it('rejects environment dumping by safety baseline', async () => {
    const executor = await fixture();

    const [result] = await executor.executeBatch([
      { id: 'cmd1', name: 'run_command', argumentsJson: '{"command":"Get-ChildItem Env:"}' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.content).toContain('permission_denied');
  });
});
