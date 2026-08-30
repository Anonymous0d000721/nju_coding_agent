import path from 'node:path';
import type { ToolDefinition, ToolRisk, OperationClass, PolicyAction, PolicyDecision, RiskLevel, PermissionMode } from './types.js';
import { isSensitiveRelativePath } from './path-guard.js';

export interface PolicyInput {
  tool: ToolDefinition;
  args: unknown;
  workspaceRoot: string;
  permissionMode: PermissionMode;
}

export function decidePolicy(input: PolicyInput): PolicyDecision {
  const operationClass = operationClassFor(input.tool.risk, input.tool.readonly);
  const args = isRecord(input.args) ? input.args : {};
  const pathValue = firstString(args.path, args.cwd);
  const normalizedPath = pathValue ? pathValue.replace(/\\/g, '/') : undefined;
  const command = typeof args.command === 'string' ? args.command : undefined;

  if (isHardDeniedTool(input.tool.name, command)) {
    return decision('deny', operationClass, 'blocked', 'Operation matches a host hard-deny rule.', 'hard-deny-operation');
  }
  if (normalizedPath && isSensitiveRelativePath(normalizedPath)) {
    return decision('deny', operationClass, 'blocked', operationClass === 'read' ? 'The requested path is protected from direct tool access.' : 'Mutation targets a protected path.', operationClass === 'read' ? 'protected-path-read' : 'protected-path-mutation');
  }
  if (input.tool.risk === 'external') {
    return decision('ask', 'external', 'high', 'External tools require explicit host approval.', 'external-tool');
  }
  if (isHighRiskCommand(command)) {
    return decision(input.permissionMode === 'yolo' ? 'allow' : 'ask', 'shell', 'high', 'Command may have high-impact side effects.', 'high-impact-command');
  }
  if (operationClass === 'read') {
    return decision('allow', operationClass, 'low', 'Read-only workspace operation.', 'read-only');
  }
  if (input.permissionMode === 'yolo') {
    return decision('allow', operationClass, 'medium', 'Mutation is allowed by yolo mode after host policy checks.', 'yolo-mutation');
  }
  return decision('ask', operationClass, 'medium', 'Mutation requires explicit approval in this permission mode.', 'mutation-approval');
}

export function applyPermissionMode(decision: PolicyDecision, mode: PermissionMode, hasApprovalCallback: boolean): PolicyDecision {
  if (decision.risk === 'blocked' || decision.action === 'deny') return { ...decision, action: 'deny' };
  if (mode === 'yolo') return { ...decision, action: 'allow' };
  if (decision.risk === 'low') return { ...decision, action: 'allow' };
  return { ...decision, action: hasApprovalCallback ? 'ask' : 'deny' };
}

export function summarizePolicyArgs(args: unknown, workspaceRoot: string): Record<string, unknown> {
  const source = isRecord(args) ? args : {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (/token|secret|password|credential|key|authorization|env/i.test(key)) result[key] = '[REDACTED]';
    else if ((key === 'path' || key === 'cwd') && typeof value === 'string') result[key] = summarizePath(value, workspaceRoot);
    else if (key === 'command' && typeof value === 'string') result[key] = value.slice(0, 240);
    else if (typeof value === 'string') result[key] = value.length > 120 ? `${value.slice(0, 120)}…` : value;
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) result[key] = value;
    else result[key] = '[omitted]';
  }
  return result;
}

function operationClassFor(risk: ToolRisk, readonly: boolean): OperationClass {
  if (risk === 'shell') return 'shell';
  if (risk === 'external') return 'external';
  if (readonly || risk === 'read') return 'read';
  return 'mutating';
}

function decision(action: PolicyAction, operationClass: OperationClass, risk: RiskLevel, reason: string, ruleId: string): PolicyDecision {
  return { action, operationClass, risk, reason, ruleId };
}

function isHardDeniedTool(toolName: string, command?: string): boolean {
  if (!command) return false;
  const lower = command.toLowerCase();
  return /(^|[\s;&|])(?:format|clear-disk|remove-partition)\b/.test(lower)
    || /(?:rm|rmdir|remove-item)\s+(?:-rf\s+\/|env:|\$env:)/.test(lower)
    || /(?:set-item|set-content|out-file)\s+.*(?:password|token|secret|api.?key)/.test(lower)
    || /(?:git\s+push|git\s+reset\s+--hard|git\s+clean\s+-fd)/.test(lower);
}

function isHighRiskCommand(command?: string): boolean {
  if (!command) return false;
  return /(?:npm|pnpm|yarn)\s+install\b|(?:^|[\s;&|])(?:invoke-webrequest|curl|wget|irm)\b|git\s+(?:push|reset|clean)\b/i.test(command);
}

function summarizePath(value: string, workspaceRoot: string): string {
  const absolute = path.resolve(workspaceRoot, value);
  const relative = path.relative(workspaceRoot, absolute).replace(/\\/g, '/') || '.';
  return relative.startsWith('..') || path.isAbsolute(relative) ? '[outside-workspace]' : relative;
}

function firstString(...values: unknown[]): string | undefined { return values.find((value): value is string => typeof value === 'string'); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
