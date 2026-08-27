import type { ToolCall } from '../agent/types.js';
import type { ToolContext, ToolResult } from './types.js';
import { validateJsonSchema } from './schema.js';
import { ToolRegistry } from './registry.js';

export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry, private readonly ctx: ToolContext) {}

  async executeBatch(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of toolCalls) {
      results.push(await this.execute(call));
    }
    return results;
  }

  private async execute(call: ToolCall): Promise<ToolResult> {
    const started = Date.now();
    const tool = this.registry.get(call.name);
    if (!tool) {
      return failure(call.id, call.name, 'unknown_tool', `Unknown tool: ${call.name}`, Date.now() - started, true);
    }

    let args: unknown;
    try {
      args = call.argumentsJson ? JSON.parse(call.argumentsJson) : {};
    } catch (error) {
      return failure(call.id, call.name, 'invalid_arguments', `Invalid JSON arguments: ${messageOf(error)}`, Date.now() - started, true);
    }

    const validation = validateJsonSchema(args, tool.parameters);
    if (!validation.ok) {
      return failure(call.id, call.name, 'invalid_arguments', validation.message ?? 'Invalid arguments', Date.now() - started, true);
    }

    try {
      const value = await tool.handler(args, this.ctx);
      return {
        toolCallId: call.id,
        toolName: call.name,
        ok: true,
        content: stringifyObservation(value),
        details: value,
        elapsedMs: Date.now() - started,
      };
    } catch (error) {
      return failure(call.id, call.name, codeOf(error), messageOf(error), Date.now() - started, true);
    }
  }
}

function failure(toolCallId: string, toolName: string, code: string, message: string, elapsedMs: number, recoverable: boolean): ToolResult {
  return {
    toolCallId,
    toolName,
    ok: false,
    content: `Tool ${toolName} failed (${code}): ${message}`,
    error: { code, message, recoverable },
    elapsedMs,
  };
}

function stringifyObservation(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'internal_error';
}