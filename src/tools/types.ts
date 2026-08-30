import type { AgentMessage } from '../agent/types.js';

export type JsonSchema = Record<string, unknown>;
export type ToolRisk = 'read' | 'write' | 'shell' | 'external';
export type OperationClass = 'read' | 'mutating' | 'shell' | 'external';
export type RiskLevel = 'low' | 'medium' | 'high' | 'blocked';
export type PolicyAction = 'allow' | 'ask' | 'deny';

export interface PolicyDecision {
  action: PolicyAction;
  operationClass: OperationClass;
  risk: RiskLevel;
  reason: string;
  ruleId: string;
  approvalScope?: 'once' | 'session';
}

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
  toolCallId?: string;
  approve?: (tool: ToolDefinition, decision?: PolicyDecision, args?: unknown) => Promise<boolean>;
  onPolicyDecision?: (decision: PolicyDecision & { toolName: string; elapsedMs: number; args?: Record<string, unknown> }) => Promise<void> | void;
  onFileMutation?: (mutation: { toolCallId: string; operation: 'create' | 'modify' | 'delete'; relativePath: string; beforeText?: string; afterText?: string; beforeHash?: string; afterHash?: string; preview?: string }) => Promise<void> | void;
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
  policyDecision?: PolicyDecision;
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