import type { ToolCall } from '../agent/types.js';
import type { ToolContext, ToolDefinition, ToolResult } from './types.js';
import { validateJsonSchema } from './schema.js';
import { ToolRegistry } from './registry.js';

const MAX_RESULT_CHARS = 12_000;

export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry, private readonly ctx: ToolContext) {}

  async executeBatch(toolCalls: ToolCall[], signal?: AbortSignal): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of toolCalls) results.push(await this.execute(call, signal));
    return results;
  }

  private async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const started = Date.now();
    const tool = this.registry.get(call.name);
    if (!tool) return failure(call.id, call.name, 'unknown_tool', `Unknown tool: ${call.name}`, Date.now() - started);
    if (!(await this.isAllowed(tool))) return failure(call.id, call.name, 'permission_denied', `Permission denied for ${tool.risk} tool in ${this.ctx.permissionMode ?? 'yolo'} mode`, Date.now() - started);

    let args: unknown;
    try {
      args = call.argumentsJson ? JSON.parse(call.argumentsJson) : {};
    } catch (error) {
      return failure(call.id, call.name, 'invalid_arguments', `Invalid JSON arguments: ${messageOf(error)}`, Date.now() - started);
    }
    const validation = validateJsonSchema(args, tool.parameters);
    if (!validation.ok) return failure(call.id, call.name, 'invalid_arguments', validation.message ?? 'Invalid arguments', Date.now() - started);

    try {
      const value = await tool.handler(args, { ...this.ctx, signal: signal ?? this.ctx.signal });
      const observation = boundedObservation(value);
      return { toolCallId: call.id, toolName: call.name, ok: true, content: observation.content, details: value, truncated: observation.truncated, elapsedMs: Date.now() - started };
    } catch (error) {
      return failure(call.id, call.name, codeOf(error), messageOf(error), Date.now() - started, detailsOf(error));
    }
  }

  private async isAllowed(tool: ToolDefinition): Promise<boolean> {
    if (tool.risk === 'read' || (this.ctx.permissionMode ?? 'yolo') === 'yolo') return true;
    if (this.ctx.approve) return this.ctx.approve(tool);
    return false;
  }
}

function failure(toolCallId: string, toolName: string, code: string, message: string, elapsedMs: number, details?: unknown): ToolResult {
  const detailRecord = isRecord(details) ? details : undefined;
  const hint = typeof detailRecord?.hint === 'string' ? detailRecord.hint : undefined;
  const content = `Tool ${toolName} failed (${code}): ${message}${hint ? `\nHint: ${hint}` : ''}`;
  return { toolCallId, toolName, ok: false, content, details, error: { code, message, recoverable: true, details }, elapsedMs };
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
