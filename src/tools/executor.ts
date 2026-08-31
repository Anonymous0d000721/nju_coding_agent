import path from 'node:path';
import type { ToolCall } from '../agent/types.js';
import type { ToolApprovalInput, ToolContext, ToolDefinition, ToolResult } from './types.js';
import { validateJsonSchema } from './schema.js';
import { ToolRegistry } from './registry.js';
import { formatToolCallPreview, formatToolResultPreview } from './preview.js';
import { applyPermissionMode, decidePolicy, summarizePolicyArgs } from './policy.js';
import type { ApprovalRecord, ApprovalResolution } from './approval.js';

const MAX_RESULT_CHARS = 12_000;

export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry, private readonly ctx: ToolContext) {}

  get workspaceRoot(): string { return this.ctx.workspaceRoot; }

  async executeBatch(toolCalls: ToolCall[], signal?: AbortSignal, maxConcurrency?: number): Promise<ToolResult[]> {
    const results: ToolResult[] = new Array(toolCalls.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = nextIndex++;
        const call = toolCalls[index];
        if (!call) return;
        if (signal?.aborted || this.ctx.signal?.aborted) {
          results[index] = cancelledFailure(call, this.ctx.previewLines);
          continue;
        }
        try {
          results[index] = await this.execute(call, signal);
        } catch (error) {
          results[index] = failure(call.id, call.name, codeOf(error), messageOf(error), 0, detailsOf(error), call, this.ctx.previewLines);
        }
      }
    };
    const requestedConcurrency = maxConcurrency ?? this.ctx.maxConcurrency ?? 4;
    const concurrency = Number.isFinite(requestedConcurrency) ? Math.max(1, Math.min(Math.floor(requestedConcurrency), 8)) : 4;
    await Promise.all(Array.from({ length: Math.min(concurrency, toolCalls.length) }, () => worker()));
    return results;
  }

  private async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const started = Date.now();
    if (signal?.aborted || this.ctx.signal?.aborted) return cancelledFailure(call, this.ctx.previewLines);
    const tool = this.registry.get(call.name);
    if (!tool) return failure(call.id, call.name, 'unknown_tool', `Unknown tool: ${call.name}`, Date.now() - started, undefined, call, this.ctx.previewLines);

    let args: unknown;
    let policyDecision = applyPermissionMode(decidePolicy({ tool, args: {}, workspaceRoot: this.ctx.workspaceRoot, permissionMode: this.ctx.permissionMode ?? 'yolo' }), this.ctx.permissionMode ?? 'yolo', Boolean(this.ctx.approve));
    let approval: ApprovalRecord | undefined;
    try {
      args = call.argumentsJson ? JSON.parse(call.argumentsJson) : {};
    } catch (error) {
      return failure(call.id, call.name, 'invalid_arguments', `Invalid JSON arguments: ${messageOf(error)}`, Date.now() - started, undefined, call, this.ctx.previewLines);
    }
    const validation = validateJsonSchema(args, tool.parameters);
    if (!validation.ok) return failure(call.id, call.name, 'invalid_arguments', validation.message ?? 'Invalid arguments', Date.now() - started, undefined, call, this.ctx.previewLines, policyDecision);

    policyDecision = applyPermissionMode(decidePolicy({ tool, args, workspaceRoot: this.ctx.workspaceRoot, permissionMode: this.ctx.permissionMode ?? 'yolo' }), this.ctx.permissionMode ?? 'yolo', Boolean(this.ctx.approve));
    const policyStarted = Date.now();
    await this.ctx.onPolicyDecision?.({ ...policyDecision, toolName: tool.name, args: summarizePolicyArgs(args, this.ctx.workspaceRoot), elapsedMs: Date.now() - policyStarted });
    if (policyDecision.action === 'deny') {
      const code = policyDecision.risk === 'blocked' || !this.ctx.approve ? 'permission_denied' : 'approval_required';
      return failure(call.id, call.name, code, policyDecision.reason, Date.now() - started, { policy: policyDecision }, call, this.ctx.previewLines, policyDecision);
    }
    if (policyDecision.action === 'ask') {
      if (!this.ctx.approve) return failure(call.id, call.name, 'permission_denied', policyDecision.reason, Date.now() - started, { policy: policyDecision }, call, this.ctx.previewLines, policyDecision);
      const approvalInput = {
        runId: this.ctx.runId,
        toolCallId: call.id,
        toolName: tool.name,
        risk: policyDecision.risk,
        args: summarizePolicyArgs(args, this.ctx.workspaceRoot),
        workspacePath: workspacePath(args, this.ctx.workspaceRoot),
        reason: policyDecision.reason,
        grantKey: `${tool.name}:${policyDecision.ruleId}`,
        timeoutMs: this.ctx.approvalTimeoutMs,
      } satisfies ToolApprovalInput;
      const approvalSignal = signal ?? this.ctx.signal;
      const approvalResponse = await this.ctx.approve(tool, policyDecision, args, approvalInput, { runId: this.ctx.runId, toolCallId: call.id, workspaceRoot: this.ctx.workspaceRoot, signal: approvalSignal });
      const resolution = normalizeApprovalResponse(approvalResponse);
      approval = {
        requestId: resolution.requestId ?? 'callback',
        outcome: resolution.outcome,
        ...(resolution.reason ? { reason: resolution.reason } : {}),
        ...(resolution.outcome === 'allow_once' || resolution.outcome === 'allow' ? { scope: 'once' as const } : resolution.outcome === 'allow_session' ? { scope: 'session' as const } : {}),
        elapsedMs: Date.now() - policyStarted,
      };
      await this.ctx.onApproval?.({ ...approvalInput, requestId: approval.requestId, timeoutMs: resolution.outcome === 'allow_session' ? 0 : approvalInput.timeoutMs ?? 0 }, approval);
      policyDecision = { ...policyDecision, action: isApprovalAllowed(resolution.outcome) ? 'allow' : 'deny', ...(approval.scope ? { approvalScope: approval.scope } : {}) };
      await this.ctx.onPolicyDecision?.({ ...policyDecision, toolName: tool.name, args: summarizePolicyArgs(args, this.ctx.workspaceRoot), elapsedMs: Date.now() - policyStarted });
      if (!isApprovalAllowed(resolution.outcome)) return failure(call.id, call.name, approval.outcome === 'timeout' ? 'approval_timeout' : approval.outcome === 'cancel' ? 'run_cancelled' : 'permission_denied', approval.reason ?? 'Operation was denied by approval callback.', Date.now() - started, { policy: policyDecision, approval }, call, this.ctx.previewLines, policyDecision, approval);
    }

    try {
      const value = await runToolHandler(tool, args, { ...this.ctx, toolCallId: call.id, signal: signal ?? this.ctx.signal }, signal ?? this.ctx.signal);
      const observation = boundedObservation(value);
      return { toolCallId: call.id, toolName: call.name, ok: true, content: observation.content, details: value, preview: formatToolResultPreview(call, value, { ok: true }, this.ctx.previewLines), truncated: observation.truncated, elapsedMs: Date.now() - started, policyDecision, ...(approval ? { approval } : {}) };
    } catch (error) {
      return failure(call.id, call.name, codeOf(error), messageOf(error), Date.now() - started, detailsOf(error), call, this.ctx.previewLines, policyDecision, approval);
    }
  }

}

async function runToolHandler(tool: ToolDefinition, args: unknown, context: ToolContext, signal?: AbortSignal): Promise<unknown> {
  if (!tool.timeoutMs && !signal) return tool.handler(args, context);
  if (signal?.aborted) throw Object.assign(new Error('Tool execution was cancelled.'), { code: 'user_cancelled' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeout = false;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });
  let cancel: (() => void) | undefined;
  const cancellationPromise = signal ? new Promise<never>((_, reject) => {
    cancel = () => reject(Object.assign(new Error('Tool execution was cancelled.'), { code: 'user_cancelled' }));
    signal.addEventListener('abort', cancel, { once: true });
  }) : undefined;
  const timeoutPromise = tool.timeoutMs ? new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timeout = true;
      const error = Object.assign(new Error(`Tool ${tool.name} timed out.`), { code: 'tool_timeout', details: { toolName: tool.name, timeoutMs: tool.timeoutMs } });
      controller.abort(error);
      reject(error);
    }, Math.max(1, tool.timeoutMs!));
  }) : undefined;
  try {
    const operation = Promise.resolve(tool.handler(args, { ...context, signal: controller.signal }));
    const races: Array<Promise<unknown>> = [operation];
    if (cancellationPromise) races.push(cancellationPromise);
    if (timeoutPromise) races.push(timeoutPromise);
    return await Promise.race(races);
  } catch (error) {
    if (timeout) throw error;
    if (signal?.aborted) throw Object.assign(new Error('Tool execution was cancelled.'), { code: 'user_cancelled' });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
    if (signal && cancel) signal.removeEventListener('abort', cancel);
  }
}

function cancelledFailure(call: ToolCall, previewLines?: number): ToolResult {
  return failure(call.id, call.name, 'user_cancelled', 'Tool execution was cancelled before it started.', 0, undefined, call, previewLines);
}

function failure(toolCallId: string, toolName: string, code: string, message: string, elapsedMs: number, details?: unknown, call?: ToolCall, previewLines?: number, policyDecision?: ToolResult['policyDecision'], approval?: ApprovalRecord): ToolResult {
  const detailRecord = isRecord(details) ? details : undefined;
  const hint = typeof detailRecord?.hint === 'string' ? detailRecord.hint : undefined;
  const content = `Tool ${toolName} failed (${code}): ${message}${hint ? `\nHint: ${hint}` : ''}`;
  return { toolCallId, toolName, ok: false, content, details, preview: call ? formatToolCallPreview(call, previewLines) + `\nfailed: ${code}` : `failed: ${code}`, error: { code, message, recoverable: true, details }, elapsedMs, policyDecision, ...(approval ? { approval } : {}) };
}

function boundedObservation(value: unknown): { content: string; truncated: boolean } {
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (content.length <= MAX_RESULT_CHARS) return { content, truncated: false };
  return { content: `${content.slice(0, MAX_RESULT_CHARS)}\n[output truncated at ${MAX_RESULT_CHARS} characters]`, truncated: true };
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return 'internal_error';
}
function detailsOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'details' in error ? (error as { details?: unknown }).details : undefined;
}
function normalizeApprovalResponse(value: ApprovalResolution | boolean): ApprovalResolution {
  if (typeof value === 'boolean') return { outcome: value ? 'allow_once' : 'deny', reason: value ? undefined : 'Operation was denied by approval callback.' };
  return value;
}
function isApprovalAllowed(outcome: ApprovalResolution['outcome']): boolean { return outcome === 'allow' || outcome === 'allow_once' || outcome === 'allow_session'; }
function workspacePath(args: unknown, workspaceRoot: string): string | undefined {
  if (!isRecord(args)) return undefined;
  const value = typeof args.path === 'string' ? args.path : typeof args.cwd === 'string' ? args.cwd : undefined;
  if (!value) return undefined;
  const absolute = path.resolve(workspaceRoot, value);
  const relative = path.relative(workspaceRoot, absolute).replace(/\\/g, '/') || '.';
  return relative.startsWith('..') || path.isAbsolute(relative) ? '[outside-workspace]' : relative;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
