import type { ToolCall } from '../agent/types.js';
import type { ToolContext, ToolDefinition, ToolResult } from './types.js';
import { validateJsonSchema } from './schema.js';
import { ToolRegistry } from './registry.js';
import { formatToolCallPreview, formatToolResultPreview } from './preview.js';
import { applyPermissionMode, decidePolicy, summarizePolicyArgs } from './policy.js';

const MAX_RESULT_CHARS = 12_000;

export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry, private readonly ctx: ToolContext) {}

  get workspaceRoot(): string { return this.ctx.workspaceRoot; }

  async executeBatch(toolCalls: ToolCall[], signal?: AbortSignal): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of toolCalls) results.push(await this.execute(call, signal));
    return results;
  }

  private async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const started = Date.now();
    const tool = this.registry.get(call.name);
    if (!tool) return failure(call.id, call.name, 'unknown_tool', `Unknown tool: ${call.name}`, Date.now() - started, undefined, call, this.ctx.previewLines);

    let args: unknown;
    let policyDecision = applyPermissionMode(decidePolicy({ tool, args: {}, workspaceRoot: this.ctx.workspaceRoot, permissionMode: this.ctx.permissionMode ?? 'yolo' }), this.ctx.permissionMode ?? 'yolo', Boolean(this.ctx.approve));
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
      const approved = await this.ctx.approve(tool, policyDecision, args);
      policyDecision = { ...policyDecision, action: approved ? 'allow' : 'deny', approvalScope: 'once' };
      await this.ctx.onPolicyDecision?.({ ...policyDecision, toolName: tool.name, args: summarizePolicyArgs(args, this.ctx.workspaceRoot), elapsedMs: Date.now() - policyStarted });
      if (!approved) return failure(call.id, call.name, 'permission_denied', 'Operation was denied by approval callback.', Date.now() - started, { policy: policyDecision }, call, this.ctx.previewLines, policyDecision);
    }

    try {
      const value = await tool.handler(args, { ...this.ctx, toolCallId: call.id, signal: signal ?? this.ctx.signal });
      const observation = boundedObservation(value);
      return { toolCallId: call.id, toolName: call.name, ok: true, content: observation.content, details: value, preview: formatToolResultPreview(call, value, { ok: true }, this.ctx.previewLines), truncated: observation.truncated, elapsedMs: Date.now() - started, policyDecision };
    } catch (error) {
      return failure(call.id, call.name, codeOf(error), messageOf(error), Date.now() - started, detailsOf(error), call, this.ctx.previewLines, policyDecision);
    }
  }

}

function failure(toolCallId: string, toolName: string, code: string, message: string, elapsedMs: number, details?: unknown, call?: ToolCall, previewLines?: number, policyDecision?: ToolResult['policyDecision']): ToolResult {
  const detailRecord = isRecord(details) ? details : undefined;
  const hint = typeof detailRecord?.hint === 'string' ? detailRecord.hint : undefined;
  const content = `Tool ${toolName} failed (${code}): ${message}${hint ? `\nHint: ${hint}` : ''}`;
  return { toolCallId, toolName, ok: false, content, details, preview: call ? formatToolCallPreview(call, previewLines) + `\nfailed: ${code}` : `failed: ${code}`, error: { code, message, recoverable: true, details }, elapsedMs, policyDecision };
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
