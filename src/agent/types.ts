import type { ToolResult } from '../tools/types.js';
import type { ThinkingConfig } from '../model/model-client.js';
import type { ModelStreamEvent } from '../model/streaming.js';
import type { CompactionResult } from '../context/compactor.js';

export type AgentStreamEvent =
  | ModelStreamEvent
  | { type: 'tool_call'; toolCall: ToolCall; preview?: string }
  | { type: 'tool_result'; result: ToolResult };

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AgentMessage {
  role: MessageRole;
  content: string;
  preview?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  sessionEntryId?: string;
}

export interface ToolCall { id: string; name: string; argumentsJson: string; preview?: string; }
export interface Usage { inputTokens?: number; outputTokens?: number; totalTokens?: number; }

export interface AssistantTurn {
  id: string;
  text: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  stopReason: 'end_turn' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  raw?: unknown;
}

export type StopReason = 'completed' | 'model_finished' | 'user_cancelled' | 'budget_exhausted' | 'context_overflow' | 'convergence_stopped' | 'fatal_error';

export interface AgentRunControl {
  queue(message: string): void;
  steer(message: string): void;
  drainQueue(): string[];
  drainSteers(): string[];
}

export interface AgentRunOptions {
  /** Optional wall-clock safety limit for one run. */
  maxDurationMs?: number;
  previewLines?: number;
  maxContextChars?: number;
  compactor?: (messages: AgentMessage[], maxChars: number, keepMessages?: number) => CompactionResult;
  initialMessages?: AgentMessage[];
  persistUserMessage?: boolean;
  userMessageEntryId?: string;
  thinking?: ThinkingConfig;
  onStreamEvent?: (event: AgentStreamEvent) => void | Promise<void>;
  onCompaction?: (compaction: { summary: string; omittedMessages: number; coveredEntryIds: string[]; firstKeptEntryId?: string; stats: { sourceChars: number; outputChars: number; omittedToolOutputChars: number } }) => void | Promise<void>;
  goalGate?: boolean;
  control?: AgentRunControl;
}

export type VerificationKind = 'test' | 'typecheck' | 'build' | 'lint' | 'static_check' | 'git_diff' | 'custom';
export type VerificationStatus = 'passed' | 'failed' | 'not_run' | 'stale';

export interface VerificationEvidence {
  id: string;
  kind: VerificationKind;
  command?: string;
  cwd?: string;
  status: VerificationStatus;
  exitCode?: number | null;
  startedAt: string;
  elapsedMs: number;
  sourceToolCallId: string;
  summary: string;
}

export interface VerificationRequirement {
  kind: VerificationKind;
  commandPattern?: string;
}

export interface VerificationPlan {
  requirements: VerificationRequirement[];
  invalidateOnMutation: boolean;
}

export type VerificationOverallStatus = 'verified' | 'failed' | 'unverified' | 'stale' | 'not_required';

export interface VerificationSummary {
  plan: VerificationPlan;
  evidence: VerificationEvidence[];
  status: VerificationOverallStatus;
}

export interface AgentRunResult {
  stopReason: StopReason;
  messages: AgentMessage[];
  turns: number;
  toolCalls: number;
  toolResults?: ToolResult[];
  verification?: VerificationSummary;
  convergence?: import('./convergence.js').ConvergenceSummary;
  compactions?: number;
  lastCompactionReason?: 'threshold' | 'overflow' | 'manual';
  warnings?: string[];
  errors?: string[];
}
