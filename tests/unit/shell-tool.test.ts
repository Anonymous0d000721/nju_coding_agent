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

  it('reports non-zero exit codes as a successful command observation', async () => {
    const executor = await fixture();

    const [result] = await executor.executeBatch([
      { id: 'cmd2', name: 'run_command', argumentsJson: '{"command":"Write-Error failed; exit 7"}' },
    ]);

    expect(result.ok).toBe(true);
    expect(result.content).toContain('"exitCode": 7');
    expect(result.content).toContain('failed');
  });

  it('reports command timeouts', async () => {
    const executor = await fixture();

    const [result] = await executor.executeBatch([
      { id: 'cmd3', name: 'run_command', argumentsJson: '{"command":"Start-Sleep -Seconds 2", "timeoutMs": 50}' },
    ]);

    expect(result.ok).toBe(true);
    expect(result.content).toContain('"timedOut": true');
  });

  it('converts command cancellation into a recoverable result', async () => {
    const executor = await fixture();
    const controller = new AbortController();
    const pending = executor.executeBatch([
      { id: 'cmd4', name: 'run_command', argumentsJson: '{"command":"Start-Sleep -Seconds 2"}' },
    ], controller.signal);
    setTimeout(() => controller.abort(), 50);

    const [result] = await pending;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('user_cancelled');
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
