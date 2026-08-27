import { McpManager } from './client.js';
import type { ToolRegistry } from '../tools/registry.js';

export function registerMcpTools(manager: McpManager, registry: ToolRegistry): number {
  const definitions = manager.definitions();
  for (const definition of definitions) registry.register(definition);
  return definitions.length;
}
