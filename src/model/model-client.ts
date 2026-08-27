import type { AgentMessage, AssistantTurn } from '../agent/types.js';
import type { ToolDefinitionForModel } from '../tools/types.js';

export interface ModelRequest {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ToolDefinitionForModel[];
}

export interface ModelClient {
  complete(request: ModelRequest, signal?: AbortSignal): Promise<AssistantTurn>;
}