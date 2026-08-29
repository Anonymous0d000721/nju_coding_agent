import type { AgentMessage } from '../agent/types.js';

export type JsonSchema = Record<string, unknown>;
export type ToolRisk = 'read' | 'write' | 'shell' | 'external';

export interface ToolDefinitionForModel {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

export interface ToolDefinition<TArgs = unknown> {
  name: string;
  description: string;
  parameters: JsonSchema;
  risk: ToolRisk;
  readonly: boolean;
  timeoutMs?: number;
  handler: ToolHandler<TArgs>;
}

export type PermissionMode = 'yolo' | 'strict' | 'confirm';

export interface ToolContext {
  workspaceRoot: string;
  signal?: AbortSignal;
  permissionMode?: PermissionMode;
  previewLines?: number;
  approve?: (tool: ToolDefinition) => Promise<boolean>;
}

export type ToolHandler<TArgs = unknown> = (args: TArgs, ctx: ToolContext) => Promise<unknown> | unknown;

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  ok: boolean;
  content: string;
  details?: unknown;
  preview?: string;
  error?: ToolError;
  truncated?: boolean;
  artifactPath?: string;
  elapsedMs: number;
}

export interface ToolError {
  code: string;
  message: string;
  recoverable: boolean;
  details?: unknown;
}

export function toolResultToMessage(result: ToolResult): AgentMessage {
  return {
    role: 'tool',
    toolCallId: result.toolCallId,
    content: result.content,
    preview: result.preview,
  };
}