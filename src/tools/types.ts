import type { AgentMessage } from '../agent/types.js';
import type { ApprovalRecord, ApprovalRequest, ApprovalResolution } from './approval.js';

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

export interface ToolApprovalContext {
  runId?: string;
  toolCallId: string;
  workspaceRoot: string;
  signal?: AbortSignal;
}

export type ToolApprovalInput = Omit<ApprovalRequest, 'requestId' | 'clientId' | 'timeoutMs'> & { timeoutMs?: number };
export type ToolApprovalHandler = (tool: ToolDefinition, decision: PolicyDecision, args: unknown, request: ToolApprovalInput, context: ToolApprovalContext) => Promise<ApprovalResolution | boolean>;

export interface WorkspaceCapabilities {
  readText(relativePath: string): Promise<string>;
  writeText(relativePath: string, content: string, options?: { createDirectories?: boolean }): Promise<{ relativePath: string; bytes: number; beforeHash?: string; afterHash: string }>;
}

export interface ToolContext {
  workspaceRoot: string;
  workspace?: WorkspaceCapabilities;
  signal?: AbortSignal;
  runId?: string;
  permissionMode?: PermissionMode;
  previewLines?: number;
  approvalTimeoutMs?: number;
  maxConcurrency?: number;
  toolCallId?: string;
  approve?: ToolApprovalHandler;
  onApproval?: (request: ApprovalRequest, record: ApprovalRecord) => Promise<void> | void;
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
  approval?: ApprovalRecord;
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