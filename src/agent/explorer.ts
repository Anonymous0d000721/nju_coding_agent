import { randomUUID } from 'node:crypto';
import { AgentRunner } from './runner.js';
import type { AgentRunProgress, AgentRunResult } from './types.js';
import type { ModelClient } from '../model/model-client.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { createFileTools } from '../tools/file-tools.js';
import type { ToolDefinition, ToolResult } from '../tools/types.js';

const READ_ONLY_TOOLS = new Set(['list_files', 'read_file', 'glob_files', 'grep_files']);
const DEFAULT_MAX_DURATION_MS = 30_000;
export const EXPLORER_MAX_TRACE_EVENTS = 64;
export const EXPLORER_MAX_TRACE_CHARS = 16_000;
export const EXPLORER_MAX_SUMMARY_CHARS = 4_000;
export const EXPLORER_MAX_FINDINGS = 32;
export const EXPLORER_MAX_FINDING_CHARS = 500;
export const EXPLORER_MAX_FILES = 128;
export const EXPLORER_MAX_ERRORS = 32;
export const EXPLORER_MAX_ERROR_CHARS = 500;

export type ExplorerStatus = 'completed' | 'cancelled' | 'timed_out' | 'failed' | 'permission_denied';

export interface ExplorerTraceEvent {
  type: 'start' | 'progress' | 'tool_result' | 'stop' | 'error';
  timestamp: string;
  runId: string;
  phase?: AgentRunProgress['phase'];
  toolCallId?: string;
  toolName?: string;
  ok?: boolean;
  errorCode?: string;
  stopReason?: AgentRunResult['stopReason'];
}

export interface ExplorerConclusion {
  runId: string;
  status: ExplorerStatus;
  summary: string;
  findings: string[];
  files: string[];
  toolCalls: number;
  elapsedMs: number;
  stopReason?: AgentRunResult['stopReason'];
  errors: string[];
  trace: ExplorerTraceEvent[];
  traceTruncated?: boolean;
  summaryTruncated?: boolean;
}

export interface ExplorerOptions {
  runId?: string;
  maxDurationMs?: number;
  signal?: AbortSignal;
  onTrace?: (event: ExplorerTraceEvent) => void | Promise<void>;
}

/** Creates the host tool that exposes only the explorer's structured conclusion to a parent run. */
export function createReadOnlyExplorerTool(explorer: ReadOnlyExplorer, onTrace?: (event: ExplorerTraceEvent) => void | Promise<void>): ToolDefinition {
  return {
    name: 'explore_readonly',
    description: 'Run a bounded read-only repository exploration and return structured findings. It cannot edit files or run commands.',
    parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false },
    risk: 'read',
    readonly: true,
    timeoutMs: DEFAULT_MAX_DURATION_MS + 5_000,
    handler: async (args, context) => {
      const input = args as { prompt: string };
      return explorer.explore(input.prompt, { runId: `${context.runId ?? 'run'}:${context.toolCallId ?? 'explore'}`, signal: context.signal, onTrace });
    },
  };
}

/** Runs a bounded, read-only child loop and returns a structured conclusion without its transcript. */
export class ReadOnlyExplorer {
  constructor(private readonly model: ModelClient, private readonly workspaceRoot: string) {}

  async explore(prompt: string, options: ExplorerOptions = {}): Promise<ExplorerConclusion> {
    const runId = options.runId ?? `explorer-${randomUUID()}`;
    const started = Date.now();
    const trace: ExplorerTraceEvent[] = [];
    let traceTruncated = false;
    const emit = async (event: Omit<ExplorerTraceEvent, 'timestamp' | 'runId'>): Promise<void> => {
      const complete = { ...event, timestamp: new Date().toISOString(), runId } satisfies ExplorerTraceEvent;
      trace.push(complete);
      while (trace.length > EXPLORER_MAX_TRACE_EVENTS || JSON.stringify(trace).length > EXPLORER_MAX_TRACE_CHARS) {
        trace.shift();
        traceTruncated = true;
      }
      await options.onTrace?.(complete);
    };
    await emit({ type: 'start' });

    const registry = new ToolRegistry();
    for (const tool of createFileTools()) if (READ_ONLY_TOOLS.has(tool.name)) registry.register(tool);
    const runner = new AgentRunner({
      model: this.model,
      tools: new ToolExecutor(registry, {
        workspaceRoot: this.workspaceRoot,
        permissionMode: 'strict',
        runId,
        onPolicyDecision: async (decision) => {
          if (decision.action === 'deny') await emit({ type: 'error', toolName: decision.toolName, errorCode: 'permission_denied' });
        },
      }),
      systemPrompt: [
        'You are a read-only repository explorer.',
        'Use only the supplied file inspection tools. Never modify files, run commands, use MCP, or access external resources.',
        'Return a concise summary with concrete findings and relative file paths. Do not include a full transcript.',
      ].join('\n'),
      toolDefinitions: registry.definitionsForModel(),
    });

    try {
      const result = await runner.run(prompt, {
        runId,
        maxDurationMs: options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
        goalGate: false,
        onProgress: async (progress) => {
          await emit({ type: 'progress', phase: progress.phase });
        },
        onStreamEvent: async (event) => {
          if (event.type === 'tool_result') {
            await emit({ type: 'tool_result', toolCallId: event.result.toolCallId, toolName: event.result.toolName, ok: event.result.ok, errorCode: event.result.error?.code });
          }
        },
      }, options.signal);
      const toolResults = result.toolResults ?? [];
      const status = statusFor(result, toolResults);
      const errors = [...new Set([
        ...(result.errors ?? []),
        ...toolResults.filter((tool) => !tool.ok).map((tool) => `${tool.toolName}: ${tool.error?.code ?? 'error'}`),
      ])];
      const rawSummary = assistantSummary(result);
      await emit({ type: 'stop', stopReason: result.stopReason });
      return {
        runId,
        status,
        summary: boundedText(rawSummary, EXPLORER_MAX_SUMMARY_CHARS),
        findings: boundedFindings(result, toolResults),
        files: filesFrom(toolResults).slice(0, EXPLORER_MAX_FILES),
        toolCalls: result.toolCalls,
        elapsedMs: result.elapsedMs ?? Date.now() - started,
        stopReason: result.stopReason,
        errors: errors.slice(0, EXPLORER_MAX_ERRORS).map((error) => error.slice(0, EXPLORER_MAX_ERROR_CHARS)),
        trace,
        ...(traceTruncated ? { traceTruncated: true } : {}),
        ...(rawSummary.length > EXPLORER_MAX_SUMMARY_CHARS ? { summaryTruncated: true } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await emit({ type: 'error', errorCode: 'explorer_failed' });
      await emit({ type: 'stop', stopReason: 'fatal_error' });
      return {
        runId,
        status: 'failed',
        summary: '',
        findings: [],
        files: [],
        toolCalls: 0,
        elapsedMs: Date.now() - started,
        stopReason: 'fatal_error',
        errors: [message.slice(0, EXPLORER_MAX_ERROR_CHARS)],
        trace,
        ...(traceTruncated ? { traceTruncated: true } : {}),
      };
    }
  }
}

function statusFor(result: AgentRunResult, toolResults: ToolResult[]): ExplorerStatus {
  if (result.stopReason === 'budget_exhausted') return 'timed_out';
  if (result.stopReason === 'user_cancelled') return 'cancelled';
  if (toolResults.some((tool) => tool.error?.code === 'permission_denied' || tool.error?.code === 'unknown_tool')) return 'permission_denied';
  if (result.stopReason === 'fatal_error') return 'failed';
  return 'completed';
}

function assistantSummary(result: AgentRunResult): string {
  return result.messages
    .filter((message) => message.role === 'assistant' && message.content.trim())
    .at(-1)?.content.trim() ?? '';
}

function boundedSummary(result: AgentRunResult): string {
  return boundedText(assistantSummary(result), EXPLORER_MAX_SUMMARY_CHARS);
}

function boundedFindings(result: AgentRunResult, toolResults: ToolResult[]): string[] {
  return findingsFrom(result, toolResults).slice(0, EXPLORER_MAX_FINDINGS).map((finding) => boundedText(finding, EXPLORER_MAX_FINDING_CHARS));
}

function findingsFrom(result: AgentRunResult, toolResults: ToolResult[]): string[] {
  const summary = boundedSummary(result);
  const toolFindings = toolResults.filter((tool) => tool.ok && typeof tool.details === 'object' && tool.details !== null)
    .flatMap((tool) => {
      const details = tool.details as Record<string, unknown>;
      const path = typeof details.path === 'string' ? details.path : undefined;
      const matches = Array.isArray(details.matches) ? details.matches.length : undefined;
      return path ? [`${tool.toolName}: ${path}`] : matches !== undefined ? [`${tool.toolName}: ${matches} match(es)`] : [];
    });
  return [...new Set([...(summary ? [summary] : []), ...toolFindings])];
}

function filesFrom(toolResults: ToolResult[]): string[] {
  return [...new Set(toolResults.flatMap((tool) => {
    const details = typeof tool.details === 'object' && tool.details !== null ? tool.details as Record<string, unknown> : {};
    const values = [details.path, ...(Array.isArray(details.matches) ? details.matches.map((match) => typeof match === 'object' && match !== null ? (match as Record<string, unknown>).path : undefined) : [])];
    return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
  }))];
}

function boundedText(value: string, maxChars: number): string {
  const marker = '\n[explorer output truncated]';
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}
