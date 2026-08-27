import type { ToolDefinition } from '../tools/types.js';
import { TodoStore, type TodoItem } from './todo.js';

export function createTodoTools(filePath: string): ToolDefinition[] {
  const store = new TodoStore(filePath);
  return [
    {
      name: 'todo_list',
      description: 'List the current structured task plan.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      risk: 'read',
      readonly: true,
      handler: async () => store.read(),
    },
    {
      name: 'todo_write',
      description: 'Replace the structured task plan. Use pending, in_progress, completed, or blocked; only one item may be in progress.',
      parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] }, note: { type: 'string' } }, required: ['id', 'text', 'status'], additionalProperties: false } } }, required: ['items'], additionalProperties: false },
      risk: 'write',
      readonly: false,
      handler: async (args) => store.write((args as { items: TodoItem[] }).items),
    },
  ];
}
