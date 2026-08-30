import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolExecutor } from '../../src/tools/executor.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { decidePolicy } from '../../src/tools/policy.js';

const tool = (risk: 'read' | 'write' | 'shell' | 'external', readonly = false) => ({
  name: 'demo', description: 'demo', parameters: { type: 'object' }, risk, readonly, handler: () => 'ok',
});

describe('unified tool policy', () => {
  it('classifies read, mutation, high-impact and blocked operations', () => {
    expect(decidePolicy({ tool: tool('read', true), args: {}, workspaceRoot: process.cwd(), permissionMode: 'yolo' })).toMatchObject({ operationClass: 'read', risk: 'low', action: 'allow' });
    expect(decidePolicy({ tool: tool('write'), args: {}, workspaceRoot: process.cwd(), permissionMode: 'strict' })).toMatchObject({ operationClass: 'mutating', risk: 'medium', action: 'ask' });
    expect(decidePolicy({ tool: tool('shell'), args: { command: 'npm install' }, workspaceRoot: process.cwd(), permissionMode: 'confirm' })).toMatchObject({ operationClass: 'shell', risk: 'high', action: 'ask' });
    expect(decidePolicy({ tool: tool('shell'), args: { command: 'git reset --hard HEAD' }, workspaceRoot: process.cwd(), permissionMode: 'yolo' })).toMatchObject({ risk: 'blocked', action: 'deny' });
  });

  it('blocks protected paths even in yolo mode', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-policy-'));
    await fs.writeFile(path.join(root, '.env'), 'TOKEN=secret', 'utf8');
    const registry = new ToolRegistry();
    registry.register({ name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, risk: 'read', readonly: true, handler: () => 'secret' });
    const [result] = await new ToolExecutor(registry, { workspaceRoot: root, permissionMode: 'yolo' }).executeBatch([{ id: 'p1', name: 'read_file', argumentsJson: '{"path":".env"}' }]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('permission_denied');
    expect(result.policyDecision).toMatchObject({ risk: 'blocked', ruleId: 'protected-path-read' });
  });

  it('records a redacted policy decision for an approved mutation', async () => {
    const decisions: unknown[] = [];
    const registry = new ToolRegistry();
    registry.register({ name: 'write_file', description: 'write', parameters: { type: 'object' }, risk: 'write', readonly: false, handler: () => 'ok' });
    const [result] = await new ToolExecutor(registry, { workspaceRoot: process.cwd(), permissionMode: 'confirm', approve: async () => true, onPolicyDecision: (decision) => { decisions.push(decision); } }).executeBatch([{ id: 'p2', name: 'write_file', argumentsJson: '{"path":"a.txt","token":"do-not-log"}' }]);
    expect(result.ok).toBe(true);
    expect(decisions).toHaveLength(2);
    expect(JSON.stringify(decisions)).not.toContain('do-not-log');
    expect(result.policyDecision).toMatchObject({ action: 'allow', approvalScope: 'once' });
  });
});
