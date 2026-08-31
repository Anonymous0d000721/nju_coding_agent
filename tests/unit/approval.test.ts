import { describe, expect, it } from 'vitest';
import { ApprovalBroker } from '../../src/tools/approval.js';

describe('ApprovalBroker', () => {
  const request = (overrides: Partial<Parameters<ApprovalBroker['request']>[0]> = {}) => ({
    runId: 'run-1', toolCallId: 'call-1', toolName: 'write_file', risk: 'medium', args: { path: 'src/app.ts' },
    workspacePath: 'src/app.ts', reason: 'Mutation requires approval.', grantKey: 'write_file:mutation-approval', ...overrides,
  });

  it('emits a request and resolves an allow-once decision with identity checks', async () => {
    let emitted!: Awaited<ReturnType<ApprovalBroker['pendingRequests']>>[number];
    const broker = new ApprovalBroker({ clientId: 'client-1', onRequest: (value) => { emitted = value; } });
    const pending = broker.request(request());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emitted).toMatchObject({ clientId: 'client-1', runId: 'run-1', toolCallId: 'call-1', toolName: 'write_file', workspacePath: 'src/app.ts' });
    expect(emitted.args).toEqual({ path: 'src/app.ts' });
    expect(broker.resolve(emitted.requestId, { outcome: 'allow_once', reason: 'Approved for this call.' }, { clientId: 'wrong' })).toEqual({ ok: false, code: 'approval_client_mismatch' });
    expect(broker.resolve(emitted.requestId, { outcome: 'allow_once', reason: 'Approved for this call.' }, { clientId: 'client-1', runId: 'wrong' })).toEqual({ ok: false, code: 'approval_run_mismatch' });
    expect(broker.resolve(emitted.requestId, { outcome: 'allow_once', reason: 'Approved for this call.' }, { clientId: 'client-1', runId: 'run-1', toolCallId: 'call-1' })).toEqual({ ok: true });
    await expect(pending).resolves.toMatchObject({ outcome: 'allow_once', requestId: emitted.requestId });
  });

  it('reuses an allow-session grant for the same tool policy', async () => {
    const requests: string[] = [];
    const broker = new ApprovalBroker({ onRequest: (value) => { requests.push(value.requestId); } });
    const first = broker.request(request());
    await new Promise((resolve) => setTimeout(resolve, 0));
    broker.resolve(requests[0]!, { outcome: 'allow_session' });
    await expect(first).resolves.toMatchObject({ outcome: 'allow_session' });
    await expect(broker.request(request())).resolves.toMatchObject({ outcome: 'allow_session' });
    expect(requests).toHaveLength(1);
  });

  it('supports concurrent requests without resolving the wrong tool call', async () => {
    const requests: Awaited<ReturnType<ApprovalBroker['pendingRequests']>> = [];
    const broker = new ApprovalBroker({ onRequest: (value) => { requests.push(value); } });
    const first = broker.request(request({ toolCallId: 'call-a', grantKey: 'grant-a' }));
    const second = broker.request(request({ toolCallId: 'call-b', grantKey: 'grant-b' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(2);
    expect(broker.resolve(requests[0]!.requestId, { outcome: 'allow_once' }, { clientId: requests[0]!.clientId, runId: 'wrong-run', toolCallId: 'call-a' })).toEqual({ ok: false, code: 'approval_run_mismatch' });
    expect(broker.resolve(requests[1]!.requestId, { outcome: 'deny', reason: 'not now' }, { clientId: requests[1]!.clientId, runId: 'run-1', toolCallId: 'call-b' })).toEqual({ ok: true });
    expect(broker.resolve(requests[0]!.requestId, { outcome: 'allow_once' }, { clientId: requests[0]!.clientId, runId: 'run-1', toolCallId: 'call-a' })).toEqual({ ok: true });
    await expect(first).resolves.toMatchObject({ outcome: 'allow_once' });
    await expect(second).resolves.toMatchObject({ outcome: 'deny' });
    expect(broker.pendingRequests()).toEqual([]);
  });

  it('returns timeout and cancellation outcomes and clears pending requests', async () => {
    const timeoutBroker = new ApprovalBroker({ timeoutMs: 5 });
    await expect(timeoutBroker.request(request())).resolves.toMatchObject({ outcome: 'timeout' });
    expect(timeoutBroker.pendingRequests()).toEqual([]);

    const controller = new AbortController();
    const cancelBroker = new ApprovalBroker();
    const pending = cancelBroker.request(request({ toolCallId: 'call-2' }), controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ outcome: 'cancel' });
    expect(cancelBroker.pendingRequests()).toEqual([]);
  });

  it('rejects stale or invalid resolutions without changing pending state', async () => {
    const broker = new ApprovalBroker({ timeoutMs: 100 });
    const pending = broker.request(request());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(broker.resolve('missing', { outcome: 'allow' })).toEqual({ ok: false, code: 'approval_not_pending' });
    expect(broker.resolve(broker.pendingRequests()[0]!.requestId, { outcome: 'not-valid' as never })).toEqual({ ok: false, code: 'approval_outcome_invalid' });
    broker.cancelAll();
    await expect(pending).resolves.toMatchObject({ outcome: 'cancel' });
  });
});
