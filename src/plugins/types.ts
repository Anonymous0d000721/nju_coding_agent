import type { ToolDefinition } from '../tools/types.js';

export interface UserPlugin {
  id: string;
  version?: string;
  description?: string;
  tools: ToolDefinition[];
}

export interface UserPluginModule {
  default?: UserPlugin | (() => UserPlugin | Promise<UserPlugin>);
  plugin?: UserPlugin | (() => UserPlugin | Promise<UserPlugin>);
}
