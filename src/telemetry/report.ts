import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentRunProgress, AgentRunResult, VerificationSummary } from '../agent/types.js';
import type { ConvergenceSummary } from '../agent/convergence.js';
import type { ToolResult } from '../tools/types.js';
import { redact } from '../shared/redact.js';
import { catalogHash, emptyMcpStatus, type McpStatus } from '../mcp/client.js';

export interface CommandStatus {
  command?: string;
  cwd?: string;
  executable?: string;
  exitCode?: number | null;
  elapsedMs?: number;
  timedOut?: boolean;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface RunStatus {
  runId: string;
  workspace: string;
  sessionId?: string;
  state: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'convergence_stopped';
  model: string;
  effort: string;
  permissionMode: string;
  turns: number;
  toolCalls: number;
  tools: Array<{ name: string; ok: boolean; elapsedMs?: number; errorCode?: string; policy?: unknown; approval?: unknown }>;
  policyDecisions: number;
  toolSuccesses: number;
  toolFailures: number;
  verification: VerificationSummary;
  commands: CommandStatus[];
  filesChanged: string[];
  compactions: number;
  lastCompactionReason?: AgentRunResult['lastCompactionReason'];
  stopReason?: AgentRunResult['stopReason'];
  warnings: string[];
  errors: string[];
  convergence?: ConvergenceSummary;
  currentToolName?: string;
  startedAt?: string;
  endedAt?: string;
  elapsedMs?: number;
  budget?: { maxDurationMs?: number; exhausted?: boolean };
  /** Present in newly-created statuses; omitted by legacy callers is normalized to an empty snapshot. */
  mcp?: McpStatus;
}

export interface RunReport extends RunStatus {
  createdAt: string;
  goal: string;
}

export interface RunStatusContext {
  workspace: string;
  sessionId?: string;
  model: string;
  effort: string;
  permissionMode: string;
  mcp?: McpStatus;
}

export function createIdleRunStatus(context: RunStatusContext, runId = ''): RunStatus {
  return {
    runId,
    workspace: context.workspace,
    sessionId: context.sessionId,
    state: 'idle',
    model: context.model,
    effort: context.effort,
    permissionMode: context.permissionMode,
    turns: 0,
    toolCalls: 0,
    tools: [],
    policyDecisions: 0,
    toolSuccesses: 0,
    toolFailures: 0,
    verification: { plan: { requirements: [], invalidateOnMutation: true }, evidence: [], status: 'not_required' },
    commands: [],
    filesChanged: [],
    compactions: 0,
    warnings: [],
    errors: [],
    mcp: context.mcp ?? emptyMcpStatus(),
  };
}

export function createRunningRunStatus(runId: string, context: RunStatusContext): RunStatus {
  return { ...createIdleRunStatus(context, runId), state: 'running' };
}

export function createProgressRunStatus(runId: string, progress: AgentRunProgress, context: RunStatusContext): RunStatus {
  const status = createRunStatus(runId, {
    stopReason: 'model_finished',
    messages: [],
    turns: progress.turn,
    toolCalls: progress.toolCalls,
    toolResults: progress.toolResults,
    verification: progress.verification,
    compactions: progress.compactions,
    lastCompactionReason: progress.lastCompactionReason,
    warnings: progress.warnings,
    errors: progress.errors,
    elapsedMs: progress.elapsedMs,
    budget: progress.budget,
  }, context);
  return {
    ...status,
    state: 'running',
    stopReason: undefined,
    ...(progress.currentToolName ? { currentToolName: progress.currentToolName } : {}),
  };
}

export function createRunStatus(runId: string, result: AgentRunResult, context: RunStatusContext): RunStatus {
  const results = result.toolResults ?? toolResultsFromMessages(result.messages);
  const tools = results.map((tool) => ({
    name: tool.toolName,
    ok: tool.ok,
    ...(tool.elapsedMs > 0 ? { elapsedMs: tool.elapsedMs } : {}),
    ...(tool.error?.code ? { errorCode: tool.error.code } : {}),
    ...(tool.policyDecision ? { policy: tool.policyDecision } : {}),
    ...(tool.approval ? { approval: tool.approval } : {}),
  }));
  const commands = results.flatMap((tool) => commandStatus(tool, context.workspace));
  const filesChanged = results.flatMap((tool) => {
    const details = asRecord(tool.details);
    const file = typeof details?.path === 'string' ? details.path : undefined;
    return tool.ok && file && ['write_file', 'hashline_edit'].includes(tool.toolName) ? [file] : [];
  });
  const warnings = result.warnings ?? [];
  const errors = result.errors ?? results.filter((tool) => !tool.ok).map((tool) => `${tool.toolName}: ${tool.error?.code ?? 'error'}`);
  return {
    runId,
    workspace: context.workspace,
    sessionId: context.sessionId,
    state: result.stopReason === 'user_cancelled' || result.stopReason === 'budget_exhausted' ? 'cancelled' : result.stopReason === 'fatal_error' ? 'failed' : result.stopReason === 'convergence_stopped' ? 'convergence_stopped' : 'completed',
    model: context.model,
    effort: context.effort,
    permissionMode: context.permissionMode,
    turns: result.turns,
    toolCalls: result.toolCalls,
    tools,
    policyDecisions: results.filter((tool) => tool.policyDecision).length,
    toolSuccesses: results.filter((tool) => tool.ok).length,
    toolFailures: results.filter((tool) => !tool.ok).length,
    verification: result.verification ?? { plan: { requirements: [], invalidateOnMutation: true }, evidence: [], status: 'not_required' },
    commands,
    filesChanged: [...new Set(filesChanged)],
    compactions: result.compactions ?? 0,
    ...(result.lastCompactionReason ? { lastCompactionReason: result.lastCompactionReason } : {}),
    stopReason: result.stopReason,
    warnings: [...new Set(warnings)],
    errors: [...new Set(errors)],
    ...(result.convergence ? { convergence: result.convergence } : {}),
    ...(result.startedAt ? { startedAt: result.startedAt } : {}),
    ...(result.endedAt ? { endedAt: result.endedAt } : {}),
    ...(result.elapsedMs !== undefined ? { elapsedMs: result.elapsedMs } : {}),
    ...(result.budget ? { budget: result.budget } : {}),
    mcp: context.mcp ?? emptyMcpStatus(),
  };
}

export function createRunReport(runId: string, prompt: string, result: AgentRunResult, context?: RunStatusContext): RunReport {
  const status = createRunStatus(runId, result, context ?? { workspace: '', model: '', effort: '', permissionMode: '' });
  return { ...status, createdAt: new Date().toISOString(), goal: redact(prompt.replace(/\s+/g, ' ').trim().slice(0, 500)) };
}

export async function readLatestRunReport(rootDir: string): Promise<RunReport | undefined> {
  const runsDir = path.join(rootDir, 'runs');
  let files;
  try { files = await fs.readdir(runsDir, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const candidates = await Promise.all(files.filter((file) => file.isFile() && file.name.endsWith('.json')).map(async (file) => {
    const filePath = path.join(runsDir, file.name);
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
      const report = normalizeRunReport(parsed, file.name.slice(0, -'.json'.length));
      return report ? { mtimeMs: (await fs.stat(filePath)).mtimeMs, report } : undefined;
    } catch { return undefined; }
  }));
  return candidates.filter((item): item is { mtimeMs: number; report: RunReport } => item !== undefined).sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.report;
}

function normalizeRunReport(value: unknown, fallbackRunId: string): RunReport | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const stopReason = isStopReason(source.stopReason) ? source.stopReason : undefined;
  const verification = normalizeVerification(source.verification);
  return {
    runId: typeof source.runId === 'string' ? source.runId : fallbackRunId,
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : new Date(0).toISOString(),
    goal: typeof source.goal === 'string' ? source.goal : '',
    workspace: typeof source.workspace === 'string' ? source.workspace : '',
    sessionId: typeof source.sessionId === 'string' ? source.sessionId : undefined,
    state: isRunState(source.state) ? source.state : stateFromStopReason(stopReason),
    model: typeof source.model === 'string' ? source.model : '',
    effort: typeof source.effort === 'string' ? source.effort : '',
    permissionMode: typeof source.permissionMode === 'string' ? source.permissionMode : '',
    turns: numberOrZero(source.turns),
    toolCalls: numberOrZero(source.toolCalls),
    tools: arrayOfRecords(source.tools).map((tool) => ({
      name: typeof tool.name === 'string' ? tool.name : 'unknown',
      ok: tool.ok === true,
      ...(typeof tool.elapsedMs === 'number' ? { elapsedMs: tool.elapsedMs } : {}),
      ...(typeof tool.errorCode === 'string' ? { errorCode: tool.errorCode } : {}),
      ...(tool.policy !== undefined ? { policy: tool.policy } : {}),
      ...(tool.approval !== undefined ? { approval: tool.approval } : {}),
    })),
    policyDecisions: numberOrZero(source.policyDecisions),
    toolSuccesses: numberOrZero(source.toolSuccesses),
    toolFailures: numberOrZero(source.toolFailures),
    verification,
    commands: arrayOfRecords(source.commands).map((command) => ({
      ...(typeof command.command === 'string' ? { command: command.command } : {}),
      ...(typeof command.cwd === 'string' ? { cwd: command.cwd } : {}),
      ...(typeof command.executable === 'string' ? { executable: command.executable } : {}),
      ...(typeof command.exitCode === 'number' || command.exitCode === null ? { exitCode: command.exitCode } : {}),
      ...(typeof command.elapsedMs === 'number' ? { elapsedMs: command.elapsedMs } : {}),
      ...(command.timedOut === true ? { timedOut: true } : {}),
      ...(typeof command.stdoutTail === 'string' ? { stdoutTail: command.stdoutTail } : {}),
      ...(typeof command.stderrTail === 'string' ? { stderrTail: command.stderrTail } : {}),
    })),
    filesChanged: arrayOfStrings(source.filesChanged),
    compactions: numberOrZero(source.compactions),
    ...(isCompactionReason(source.lastCompactionReason) ? { lastCompactionReason: source.lastCompactionReason } : {}),
    ...(stopReason ? { stopReason } : {}),
    warnings: arrayOfStrings(source.warnings),
    errors: arrayOfStrings(source.errors),
    ...(source.convergence !== undefined ? { convergence: source.convergence as ConvergenceSummary } : {}),
    ...(typeof source.currentToolName === 'string' ? { currentToolName: source.currentToolName } : {}),
    ...(typeof source.startedAt === 'string' ? { startedAt: source.startedAt } : {}),
    ...(typeof source.endedAt === 'string' ? { endedAt: source.endedAt } : {}),
    ...(typeof source.elapsedMs === 'number' ? { elapsedMs: source.elapsedMs } : {}),
    ...(asRecord(source.budget) ? { budget: { ...(typeof asRecord(source.budget)?.maxDurationMs === 'number' ? { maxDurationMs: asRecord(source.budget)?.maxDurationMs as number } : {}), ...(asRecord(source.budget)?.exhausted === true ? { exhausted: true } : {}) } } : {}),
    mcp: normalizeMcpStatus(source.mcp),
  };
}

function normalizeMcpStatus(value: unknown): McpStatus {
  const source = asRecord(value);
  const configured = arrayOfRecords(source?.configured).map((server) => ({
    name: typeof server.name === 'string' ? server.name : 'unknown',
    command: typeof server.command === 'string' ? redact(server.command) : '',
    ...(typeof server.cwd === 'string' ? { cwd: server.cwd } : {}),
    enabled: server.enabled === true,
    ...(typeof server.reason === 'string' ? { reason: server.reason } : {}),
  }));
  const servers = arrayOfRecords(source?.servers).map((server) => ({
    name: typeof server.name === 'string' ? server.name : 'unknown',
    state: (server.state === 'failed' || server.state === 'closed' ? server.state : 'connected') as McpStatus['servers'][number]['state'],
    toolCount: numberOrZero(server.toolCount),
    activeCalls: numberOrZero(server.activeCalls),
    connectedAt: typeof server.connectedAt === 'string' ? server.connectedAt : new Date(0).toISOString(),
    ...(typeof server.protocolVersion === 'string' ? { protocolVersion: server.protocolVersion } : {}),
    ...(typeof server.version === 'string' ? { version: server.version } : {}),
    ...(typeof server.restartCount === 'number' ? { restartCount: server.restartCount } : {}),
    ...(typeof server.error === 'string' ? { error: redact(server.error) } : {}),
    ...(typeof server.stderrTail === 'string' ? { stderrTail: tail(server.stderrTail, 2_000) } : {}),
    ...(typeof server.pid === 'number' ? { pid: server.pid } : {}),
  }));
  const toolCatalog = arrayOfRecords(source?.toolCatalog).map((tool) => ({
    qualifiedName: typeof tool.qualifiedName === 'string' ? tool.qualifiedName : 'unknown',
    server: typeof tool.server === 'string' ? tool.server : 'unknown',
    name: typeof tool.name === 'string' ? tool.name : 'unknown',
    description: typeof tool.description === 'string' ? tool.description.slice(0, 2_000) : '',
    risk: isMcpRisk(tool.risk) ? tool.risk : 'unknown',
    schema: asRecord(tool.schema) ?? { type: 'object' },
  }));
  const reloadSource = asRecord(source?.reload);
  const reload = {
    status: isMcpReloadStatus(reloadSource?.status) ? reloadSource.status : 'idle' as const,
    requested: reloadSource?.requested === true,
    changed: reloadSource?.changed === true,
    changes: arrayOfRecords(reloadSource?.changes).flatMap((change) => typeof change.qualifiedName === 'string' && isMcpChangeKind(change.kind) ? [{ qualifiedName: change.qualifiedName, kind: change.kind }] : []),
    ...(typeof reloadSource?.at === 'string' ? { at: reloadSource.at } : {}),
    ...(typeof reloadSource?.error === 'string' ? { error: redact(reloadSource.error) } : {}),
  };
  return { configured, servers, toolCatalog, catalogHash: typeof source?.catalogHash === 'string' ? source.catalogHash : catalogHash(toolCatalog), reload };
}

function isMcpRisk(value: unknown): value is McpStatus['toolCatalog'][number]['risk'] { return value === 'readonly' || value === 'workspace_mutation' || value === 'external_side_effect' || value === 'unknown'; }
function isMcpReloadStatus(value: unknown): value is McpStatus['reload']['status'] { return value === 'idle' || value === 'scheduled' || value === 'applied' || value === 'failed'; }
function isMcpChangeKind(value: unknown): value is McpStatus['reload']['changes'][number]['kind'] { return value === 'added' || value === 'removed' || value === 'risk_changed' || value === 'schema_changed' || value === 'description_changed'; }
function normalizeVerification(value: unknown): VerificationSummary {
  const source = asRecord(value);
  const plan = asRecord(source?.plan);
  const status = source?.status;
  return {
    plan: {
      requirements: arrayOfRecords(plan?.requirements).map((requirement) => ({
        kind: typeof requirement.kind === 'string' ? requirement.kind as VerificationSummary['plan']['requirements'][number]['kind'] : 'custom',
        ...(typeof requirement.commandPattern === 'string' ? { commandPattern: requirement.commandPattern } : {}),
      })),
      invalidateOnMutation: plan?.invalidateOnMutation !== false,
    },
    evidence: arrayOfRecords(source?.evidence).map((evidence) => ({
      id: typeof evidence.id === 'string' ? evidence.id : 'legacy-evidence',
      kind: typeof evidence.kind === 'string' ? evidence.kind as VerificationSummary['evidence'][number]['kind'] : 'custom',
      ...(typeof evidence.command === 'string' ? { command: evidence.command } : {}),
      ...(typeof evidence.cwd === 'string' ? { cwd: evidence.cwd } : {}),
      status: isVerificationEvidenceStatus(evidence.status) ? evidence.status : 'not_run',
      ...(typeof evidence.exitCode === 'number' || evidence.exitCode === null ? { exitCode: evidence.exitCode } : {}),
      ...(typeof evidence.targetPath === 'string' ? { targetPath: evidence.targetPath } : {}),
      ...(typeof evidence.endedAt === 'string' ? { endedAt: evidence.endedAt } : {}),
      ...(typeof evidence.stdoutTail === 'string' ? { stdoutTail: evidence.stdoutTail } : {}),
      ...(typeof evidence.stderrTail === 'string' ? { stderrTail: evidence.stderrTail } : {}),
      startedAt: typeof evidence.startedAt === 'string' ? evidence.startedAt : new Date(0).toISOString(),
      elapsedMs: numberOrZero(evidence.elapsedMs),
      sourceToolCallId: typeof evidence.sourceToolCallId === 'string' ? evidence.sourceToolCallId : 'legacy',
      summary: typeof evidence.summary === 'string' ? evidence.summary : '',
    })),
    status: isVerificationStatus(status) ? status : 'not_required',
  };
}

function stateFromStopReason(stopReason: AgentRunResult['stopReason'] | undefined): RunStatus['state'] {
  if (stopReason === 'user_cancelled' || stopReason === 'budget_exhausted') return 'cancelled';
  if (stopReason === 'fatal_error') return 'failed';
  if (stopReason === 'convergence_stopped') return 'convergence_stopped';
  return stopReason ? 'completed' : 'idle';
}
function numberOrZero(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
function arrayOfRecords(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => asRecord(item) !== undefined) : []; }
function arrayOfStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function isRunState(value: unknown): value is RunStatus['state'] { return value === 'idle' || value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'convergence_stopped'; }
function isStopReason(value: unknown): value is AgentRunResult['stopReason'] { return value === 'completed' || value === 'model_finished' || value === 'user_cancelled' || value === 'budget_exhausted' || value === 'context_overflow' || value === 'convergence_stopped' || value === 'fatal_error'; }
function isCompactionReason(value: unknown): value is NonNullable<RunStatus['lastCompactionReason']> { return value === 'threshold' || value === 'overflow' || value === 'manual'; }
function isVerificationStatus(value: unknown): value is VerificationSummary['status'] { return value === 'verified' || value === 'failed' || value === 'blocked' || value === 'unverified' || value === 'stale' || value === 'not_required'; }
function isVerificationEvidenceStatus(value: unknown): value is VerificationSummary['evidence'][number]['status'] { return value === 'passed' || value === 'failed' || value === 'not_run' || value === 'stale' || value === 'blocked'; }

function commandStatus(tool: ToolResult, workspace: string): CommandStatus[] {
  if (tool.toolName !== 'run_command' && tool.toolName !== 'background_command') return [];
  const details = asRecord(tool.details);
  return [{
    command: typeof details?.command === 'string' ? redact(details.command) : undefined,
    cwd: typeof details?.cwd === 'string' ? details.cwd : workspace,
    executable: typeof details?.executable === 'string' ? details.executable : undefined,
    exitCode: typeof details?.exitCode === 'number' || details?.exitCode === null ? details.exitCode : undefined,
    elapsedMs: typeof details?.elapsedMs === 'number' ? details.elapsedMs : tool.elapsedMs,
    timedOut: details?.timedOut === true,
    stdoutTail: typeof details?.stdout === 'string' ? tail(details.stdout) : undefined,
    stderrTail: typeof details?.stderr === 'string' ? tail(details.stderr) : undefined,
  }];
}

function tail(value: string, maxChars = 2_000): string {
  const safe = redact(value.trimEnd());
  return safe.length <= maxChars ? safe : `…${safe.slice(-maxChars)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }

function toolResultsFromMessages(messages: AgentRunResult['messages']): ToolResult[] {
  const names = new Map<string, string>();
  for (const message of messages) for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
  return messages.filter((message) => message.role === 'tool').map((message) => ({
    toolCallId: message.toolCallId ?? 'unknown', toolName: names.get(message.toolCallId ?? '') ?? 'unknown', ok: !/failed|error|denied|unknown_tool/i.test(message.content), content: message.content, elapsedMs: 0,
  }));
}

export async function writeRunReport(rootDir: string, report: RunReport): Promise<string> {
  const filePath = path.join(rootDir, 'runs', `${report.runId}.json`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return filePath;
}
