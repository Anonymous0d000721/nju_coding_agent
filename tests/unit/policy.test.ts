import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolExecutor } from '../../src/tools/executor.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { applyPermissionMode, decidePolicy } from '../../src/tools/policy.js';
import { ApprovalBroker } from '../../src/tools/approval.js';

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

  it('routes structured approval through the executor and preserves a redacted request', async () => {
    const requests: Awaited<ReturnType<ApprovalBroker['pendingRequests']>> = [];
    const broker = new ApprovalBroker({ onRequest: (request) => { requests.push(request); } });
    const registry = new ToolRegistry();
    let executed = false;
    registry.register({ name: 'write_file', description: 'write', parameters: { type: 'object' }, risk: 'write', readonly: false, handler: () => { executed = true; return 'ok'; } });
    const execution = new ToolExecutor(registry, { workspaceRoot: process.cwd(), permissionMode: 'confirm', runId: 'run-approval', approve: (_tool, _decision, _args, request, context) => broker.request(request, context.signal) }).executeBatch([{ id: 'approval-1', name: 'write_file', argumentsJson: '{"path":"src/app.ts","token":"do-not-log"}' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests[0]).toMatchObject({ runId: 'run-approval', toolCallId: 'approval-1', workspacePath: 'src/app.ts' });
    expect(requests[0]?.args).toEqual({ path: 'src/app.ts', token: '[REDACTED]' });
    broker.resolve(requests[0]!.requestId, { outcome: 'allow_once', reason: 'approved' }, { clientId: requests[0]!.clientId, runId: 'run-approval', toolCallId: 'approval-1' });
    const [result] = await execution;
    expect(executed).toBe(true);
    expect(result).toMatchObject({ ok: true, approval: { outcome: 'allow_once', scope: 'once', reason: 'approved' }, policyDecision: { action: 'allow', approvalScope: 'once' } });
  });

  it('maps a timed-out approval to a deterministic tool failure', async () => {
    const broker = new ApprovalBroker({ timeoutMs: 5 });
    const registry = new ToolRegistry();
    registry.register({ name: 'write_file', description: 'write', parameters: { type: 'object' }, risk: 'write', readonly: false, handler: () => { throw new Error('must not execute'); } });
    const [result] = await new ToolExecutor(registry, { workspaceRoot: process.cwd(), permissionMode: 'confirm', approve: (_tool, _decision, _args, request, context) => broker.request(request, context.signal) }).executeBatch([{ id: 'approval-timeout', name: 'write_file', argumentsJson: '{}' }]);
    expect(result).toMatchObject({ ok: false, error: { code: 'approval_timeout' }, approval: { outcome: 'timeout' } });
  });

  it('never implicitly allows external-side-effect tools in yolo mode', () => {
    const external = { ...tool('external'), riskCategory: 'external_side_effect' as const };
    expect(decidePolicy({ tool: external, args: {}, workspaceRoot: process.cwd(), permissionMode: 'yolo' })).toMatchObject({ action: 'ask', operationClass: 'external' });
    expect(applyPermissionMode(decidePolicy({ tool: external, args: {}, workspaceRoot: process.cwd(), permissionMode: 'yolo' }), 'yolo', false)).toMatchObject({ action: 'deny' });
    expect(applyPermissionMode(decidePolicy({ tool: external, args: {}, workspaceRoot: process.cwd(), permissionMode: 'yolo' }), 'yolo', true)).toMatchObject({ action: 'ask' });
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
