import fs from 'node:fs/promises';
import path from 'node:path';

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';
export interface TodoItem { id: string; text: string; status: TodoStatus; note?: string; }
export interface TodoList { version: 1; updatedAt: string; items: TodoItem[]; }

export class TodoStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<TodoList> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as TodoList;
      validateTodoList(parsed);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, updatedAt: new Date().toISOString(), items: [] };
      throw error;
    }
  }

  async write(items: TodoItem[]): Promise<TodoList> {
    validateItems(items);
    const value: TodoList = { version: 1, updatedAt: new Date().toISOString(), items: items.map((item) => ({ ...item })) };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return value;
  }
}

function validateTodoList(value: TodoList): void {
  if (!value || value.version !== 1 || !Array.isArray(value.items)) throw new Error('Invalid todo list');
  validateItems(value.items);
}
function validateItems(items: TodoItem[]): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.text !== 'string' || !item.text.trim() || !['pending', 'in_progress', 'completed', 'blocked'].includes(item.status)) throw new Error('Invalid todo item');
    ids.add(item.id);
  }
  const active = items.filter((item) => item.status === 'in_progress');
  if (active.length > 1) throw new Error('Todo list may have only one in_progress item');
}
