import { randomUUID } from 'node:crypto';
import type { AgentMessage, AgentRunResult } from '../agent/types.js';
import type { MessageEntry, RunEndEntry, RunStartEntry, SummaryEntry, ThinkingLevelChangeEntry } from './session-types.js';

export function createMessageEntry(sessionId: string, message: AgentMessage): MessageEntry {
  return { type: 'message', id: randomUUID(), sessionId, timestamp: new Date().toISOString(), schemaVersion: 1, message };
}

export function createRunStartEntry(sessionId: string, userMessageId: string, config: { model: string; permissionMode: string }): RunStartEntry {
  return { type: 'run_start', id: randomUUID(), sessionId, timestamp: new Date().toISOString(), schemaVersion: 1, userMessageId, config };
}

export function createThinkingLevelChangeEntry(sessionId: string, thinkingLevel: string): ThinkingLevelChangeEntry {
  return { type: 'thinking_level_change', id: randomUUID(), sessionId, timestamp: new Date().toISOString(), schemaVersion: 1, thinkingLevel };
}

export function createSummaryEntry(sessionId: string, summary: string, coveredEntryIds: string[] = [], reason: SummaryEntry['reason'] = 'threshold'): SummaryEntry {
  return { type: 'summary', id: randomUUID(), sessionId, timestamp: new Date().toISOString(), schemaVersion: 1, summary, coveredEntryIds, reason };
}

export function createRunEndEntry(sessionId: string, result: AgentRunResult): RunEndEntry {
  return { type: 'run_end', id: randomUUID(), sessionId, timestamp: new Date().toISOString(), schemaVersion: 1, stopReason: result.stopReason, turns: result.turns, toolCalls: result.toolCalls };
}
