import type { AgentMessage, AgentRunResult, ToolCall } from '../agent/types.js';
import type { ToolResult } from '../tools/types.js';

export interface HookContext {
  userPrompt: string;
  turn: number;
  message?: AgentMessage;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  signal?: AbortSignal;
}

export interface AgentHooks {
  beforeRun?: (context: HookContext) => void | Promise<void>;
  beforeModelRequest?: (context: HookContext) => void | Promise<void>;
  beforeTool?: (context: HookContext) => void | Promise<void>;
  afterTool?: (context: HookContext) => void | Promise<void>;
  afterTurn?: (context: HookContext) => void | Promise<void>;
  onStop?: (context: HookContext & { result: AgentRunResult }) => void | Promise<void>;
}

export class HookRegistry {
  private readonly handlers: { [K in keyof AgentHooks]: NonNullable<AgentHooks[K]>[] } = {
    beforeRun: [], beforeModelRequest: [], beforeTool: [], afterTool: [], afterTurn: [], onStop: [],
  };

  register(hooks: AgentHooks): void {
    for (const key of Object.keys(this.handlers) as (keyof AgentHooks)[]) {
      const handler = hooks[key];
      const bucket = this.handlers[key];
      if (handler && bucket) bucket.push(handler as never);
    }
  }

  async run<K extends keyof AgentHooks>(name: K, context: HookContext & (K extends 'onStop' ? { result: AgentRunResult } : object)): Promise<void> {
    const handlers = this.handlers[name] ?? [];
    for (const handler of handlers) await (handler as (ctx: typeof context) => void | Promise<void>)(context);
  }
}
