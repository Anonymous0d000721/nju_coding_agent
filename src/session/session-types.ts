import type { AgentMessage, StopReason, Usage } from '../agent/types.js';

export interface BaseSessionEntry {
  type: string;
  id: string;
  sessionId: string;
  parentId?: string;
  timestamp: string;
  schemaVersion: 1;
}

export interface SessionStartEntry extends BaseSessionEntry {
  type: 'session_start';
  cwd: string;
  model: string;
  appVersion: string;
  parentSessionId?: string;
  name?: string;
}

export interface MessageEntry extends BaseSessionEntry {
  type: 'message';
  message: AgentMessage;
  usage?: Usage;
}

export interface RunStartEntry extends BaseSessionEntry {
  type: 'run_start';
  userMessageId: string;
  config: { model: string; permissionMode: string };
}

export interface RunEndEntry extends BaseSessionEntry {
  type: 'run_end';
  stopReason: StopReason;
  turns: number;
  toolCalls: number;
  errorSummary?: string;
}

export interface ThinkingLevelChangeEntry extends BaseSessionEntry {
  type: 'thinking_level_change';
  thinkingLevel: string;
}

export interface SessionNameEntry extends BaseSessionEntry {
  type: 'session_name';
  name: string;
}

export interface SummaryEntry extends BaseSessionEntry {
  type: 'summary';
  summary: string;
  coveredEntryIds: string[];
  reason: 'manual' | 'threshold' | 'overflow';
}

export type SessionEntry = SessionStartEntry | MessageEntry | RunStartEntry | RunEndEntry | ThinkingLevelChangeEntry | SessionNameEntry | SummaryEntry;

export interface AgentSession { id: string; path: string; entries: SessionEntry[]; }
export interface SessionDisplayPage {
  entries: SessionEntry[];
  name?: string;
  hasMore: boolean;
  nextBeforeEntryId?: string;
}
export interface CreateSessionOptions { cwd: string; model: string; appVersion: string; parentSessionId?: string; name?: string; }
