import type { AgentMessage, AssistantTurn } from '../agent/types.js';
import type { ToolDefinitionForModel } from '../tools/types.js';
import type { ModelStreamHandler } from './streaming.js';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;
export type ThinkingFormat = 'reasoning_effort' | 'anthropic-adaptive' | 'anthropic-budget';

export interface ThinkingConfig {
  level: ThinkingLevel;
  map?: ThinkingLevelMap;
  format?: ThinkingFormat;
  budgets?: Partial<Record<Exclude<ThinkingLevel, 'off'>, number>>;
}

export interface ModelRequest {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ToolDefinitionForModel[];
  thinking?: ThinkingConfig;
}

export interface ModelClient {
  complete(request: ModelRequest, signal?: AbortSignal): Promise<AssistantTurn>;
  stream?(request: ModelRequest, handler?: ModelStreamHandler, signal?: AbortSignal): Promise<AssistantTurn>;
}
