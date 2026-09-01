import type { ToolDefinition, ToolDefinitionForModel } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    const name = normalizeToolName(tool.name);
    if (name !== tool.name) throw new Error(`Invalid tool name: ${tool.name}`);
    if (this.tools.has(name)) throw new Error(`Duplicate tool name: ${name}`);
    this.tools.set(name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  definitionsForModel(): ToolDefinitionForModel[] {
    return [...this.tools.values()].map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
}

export function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}