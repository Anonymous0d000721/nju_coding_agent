import type { ToolResult } from '../tools/types.js';
import type { ThinkingConfig } from '../model/model-client.js';
import type { ModelStreamEvent } from '../model/streaming.js';

export type AgentStreamEvent =
  | ModelStreamEvent
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; result: ToolResult };

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AgentMessage {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolCall { id: string; name: string; argumentsJson: string; }
export interface Usage { inputTokens?: number; outputTokens?: number; totalTokens?: number; }

export interface AssistantTurn {
  id: string;
  text: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  stopReason: 'end_turn' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  raw?: unknown;
}

export type StopReason = 'completed' | 'model_finished' | 'user_cancelled' | 'max_turns' | 'max_tool_calls' | 'budget_exhausted' | 'context_overflow' | 'fatal_error';

export interface AgentRunOptions {
  maxTurns: number;
  maxToolCalls: number;
  maxContextChars?: number;
  initialMessages?: AgentMessage[];
  persistUserMessage?: boolean;
  thinking?: ThinkingConfig;
  onStreamEvent?: (event: AgentStreamEvent) => void | Promise<void>;
  onCompaction?: (summary: string, omittedMessages: number) => void | Promise<void>;
}

export interface AgentRunResult { stopReason: StopReason; messages: AgentMessage[]; turns: number; toolCalls: number; }
