import { randomUUID } from 'node:crypto';

export type ApprovalOutcome = 'allow' | 'deny' | 'allow_once' | 'allow_session' | 'cancel' | 'timeout';

export interface ApprovalRequest {
  requestId: string;
  clientId?: string;
  runId?: string;
  toolCallId: string;
  toolName: string;
  risk: string;
  args: Record<string, unknown>;
  workspacePath?: string;
  reason: string;
  timeoutMs: number;
  grantKey: string;
}

export interface ApprovalResolution {
  outcome: ApprovalOutcome;
  reason?: string;
  requestId?: string;
}

export interface ApprovalRecord {
  requestId: string;
  outcome: ApprovalOutcome;
  reason?: string;
  scope?: 'once' | 'session';
  elapsedMs: number;
}

export interface ApprovalBrokerOptions {
  clientId?: string;
  timeoutMs?: number;
  onRequest?: (request: ApprovalRequest) => void | Promise<void>;
  onResult?: (request: ApprovalRequest, record: ApprovalRecord) => void | Promise<void>;
}

type Pending = { request: ApprovalRequest; resolve: (resolution: ApprovalResolution) => void; timer: ReturnType<typeof setTimeout>; startedAt: number; cleanup: () => void };

/** Coordinates auditable approval requests without blocking unrelated RPC messages. */
export class ApprovalBroker {
  readonly clientId: string;
  private readonly timeoutMs: number;
  private readonly onRequest?: ApprovalBrokerOptions['onRequest'];
  private readonly onResult?: ApprovalBrokerOptions['onResult'];
  private readonly pending = new Map<string, Pending>();
  private readonly sessionGrants = new Set<string>();

  constructor(options: ApprovalBrokerOptions = {}) {
    this.clientId = options.clientId ?? randomUUID();
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.onRequest = options.onRequest;
    this.onResult = options.onResult;
  }

  async request(input: Omit<ApprovalRequest, 'requestId' | 'timeoutMs'> & { timeoutMs?: number }, signal?: AbortSignal): Promise<ApprovalResolution> {
    const request: ApprovalRequest = { ...input, clientId: this.clientId, requestId: randomUUID(), timeoutMs: Math.max(1, input.timeoutMs ?? this.timeoutMs) };
    if (this.sessionGrants.has(input.grantKey)) {
      const resolution = { outcome: 'allow_session' as const, reason: 'Previously approved for this session.', requestId: request.requestId };
      void Promise.resolve(this.onResult?.(request, { requestId: request.requestId, outcome: resolution.outcome, reason: resolution.reason, scope: 'session', elapsedMs: 0 })).catch(() => undefined);
      return resolution;
    }
    return new Promise<ApprovalResolution>((resolve) => {
      const startedAt = Date.now();
      const onAbort = () => this.finish(request.requestId, { outcome: 'cancel', reason: 'Run was cancelled while waiting for approval.' });
      const timer = setTimeout(() => this.finish(request.requestId, { outcome: 'timeout', reason: 'Approval request timed out.' }), request.timeoutMs);
      this.pending.set(request.requestId, { request, resolve, timer, startedAt, cleanup: () => signal?.removeEventListener('abort', onAbort) });
      if (signal) {
        if (signal.aborted) this.finish(request.requestId, { outcome: 'cancel', reason: 'Run was cancelled while waiting for approval.' });
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      if (this.pending.has(request.requestId)) void Promise.resolve(this.onRequest?.(request)).catch(() => undefined);
    });
  }

  resolve(requestId: string, resolution: ApprovalResolution, identity?: { clientId?: string; runId?: string; toolCallId?: string }): { ok: boolean; code?: string } {
    if (identity?.clientId !== undefined && identity.clientId !== this.clientId) return { ok: false, code: 'approval_client_mismatch' };
    const pending = this.pending.get(requestId);
    if (!pending) return { ok: false, code: 'approval_not_pending' };
    if (identity?.runId !== undefined && identity.runId !== pending.request.runId) return { ok: false, code: 'approval_run_mismatch' };
    if (identity?.toolCallId !== undefined && identity.toolCallId !== pending.request.toolCallId) return { ok: false, code: 'approval_tool_call_mismatch' };
    if (!isOutcome(resolution.outcome)) return { ok: false, code: 'approval_outcome_invalid' };
    this.finish(requestId, resolution);
    return { ok: true };
  }

  cancelAll(reason = 'Approval request cancelled.'): void {
    for (const requestId of [...this.pending.keys()]) this.finish(requestId, { outcome: 'cancel', reason });
  }

  pendingRequests(): ApprovalRequest[] { return [...this.pending.values()].map((item) => ({ ...item.request })); }

  private finish(requestId: string, resolution: ApprovalResolution): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.cleanup();
    if (resolution.outcome === 'allow_session') this.sessionGrants.add(pending.request.grantKey);
    const record: ApprovalRecord = {
      requestId,
      outcome: resolution.outcome,
      ...(resolution.reason ? { reason: resolution.reason } : {}),
      ...(resolution.outcome === 'allow_once' || resolution.outcome === 'allow' ? { scope: 'once' as const } : resolution.outcome === 'allow_session' ? { scope: 'session' as const } : {}),
      elapsedMs: Date.now() - pending.startedAt,
    };
    pending.resolve({ ...resolution, requestId });
    void Promise.resolve(this.onResult?.(pending.request, record)).catch(() => undefined);
  }
}

function isOutcome(value: unknown): value is ApprovalOutcome {
  return value === 'allow' || value === 'deny' || value === 'allow_once' || value === 'allow_session' || value === 'cancel' || value === 'timeout';
}
