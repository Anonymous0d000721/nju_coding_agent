import { randomUUID } from 'node:crypto';
import type { AgentMessage, AgentRunResult } from '../agent/types.js';
import type { FileMutationRecord } from '../telemetry/journal.js';
import type { ApprovalRecord } from '../tools/approval.js';
import type { FileMutationEntry, MessageEntry, RunEndEntry, RunStartEntry, ApprovalEntry, SessionNameEntry, SummaryEntry, ThinkingLevelChangeEntry } from './session-types.js';

export function createMessageEntry(sessionId: string, message: AgentMessage): MessageEntry {
  return { type: 'message', id: randomUUID(), sessionId, timestamp: new Date().toISOString(), schemaVersion: 1, message };
}

export function createRunStartEntry(sessionId: string, userMessageId: string, config: { model: string; permissionMode: string }): RunStartEntry {
  return { type: 'run_start', id: randomUUID(), sessionId, timestamp: new Date().toISOString(), schemaVersion: 1, userMessageId, config };
}

export function createThinkingLevelChangeEntry(sessionId: string, thinkingLevel: string): ThinkingLevelChangeEntry {
  return { type: 'thinking_level_change', id: randomUUID(), sessionId, timestamp: new Date().toISOString(), schemaVersion: 1, thinkingLevel };
}

export function createSessionNameEntry(sessionId: string, name: string): SessionNameEntry {
  return { type: 'session_name', id: randomUUID(), sessionId, timestamp: new Date().toISOString(), schemaVersion: 1, name };
}

export function createFileMutationEntry(sessionId: string, mutation: FileMutationRecord): FileMutationEntry {
  return { type: 'file_mutation', id: randomUUID(), sessionId, timestamp: new Date().toISOString(), schemaVersion: 1, mutation: { ...mutation } };
}

export function createSummaryEntry(sessionId: string, summary: string, coveredEntryIds: string[] = [], reason: SummaryEntry['reason'] = 'threshold', details: Pick<SummaryEntry, 'algorithm' | 'firstKeptEntryId' | 'stats' | 'supersedesEntryIds'> = {}): SummaryEntry {
  return { type: 'summary', id: randomUUID(), sessionId, timestamp: new Date().toISOString(), schemaVersion: 1, summary, coveredEntryIds, reason, ...details };
}

export function createApprovalEntry(sessionId: string, request: { runId?: string; toolCallId: string; toolName: string; risk: string; requestId: string }, record: ApprovalRecord): ApprovalEntry {
  return { type: 'approval', id: randomUUID(), sessionId, timestamp: new Date().toISOString(), schemaVersion: 1, requestId: request.requestId, runId: request.runId, toolCallId: request.toolCallId, toolName: request.toolName, risk: request.risk, outcome: record.outcome, ...(record.scope ? { scope: record.scope } : {}), ...(record.reason ? { reason: record.reason } : {}), elapsedMs: record.elapsedMs };
}

export function createRunEndEntry(sessionId: string, result: AgentRunResult): RunEndEntry {
  return { type: 'run_end', id: randomUUID(), sessionId, timestamp: new Date().toISOString(), schemaVersion: 1, stopReason: result.stopReason, turns: result.turns, toolCalls: result.toolCalls };
}
