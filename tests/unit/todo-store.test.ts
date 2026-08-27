import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TodoStore } from '../../src/plan/todo.js';
import { createTodoTools } from '../../src/plan/todo-tools.js';

describe('TodoStore', () => {
  it('initializes, persists, and restores a structured list', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-todo-'));
    const store = new TodoStore(path.join(root, '.nju-agent', 'todo.json'));
    expect((await store.read()).items).toEqual([]);
    await store.write([{ id: '1', text: 'Run tests', status: 'in_progress' }]);
    expect((await store.read()).items[0]?.status).toBe('in_progress');
  });

  it('exposes validated read and write tools', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-todo-'));
    const tools = createTodoTools(path.join(root, 'todo.json'));
    expect(tools.map((tool) => [tool.name, tool.risk])).toEqual([['todo_list', 'read'], ['todo_write', 'write']]);
    await tools[1]!.handler({ items: [{ id: '1', text: 'test', status: 'pending' }] }, { workspaceRoot: root });
    await expect(tools[0]!.handler({}, { workspaceRoot: root })).resolves.toMatchObject({ items: [{ id: '1' }] });
  });

  it('rejects duplicate ids and multiple active items', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-todo-'));
    const store = new TodoStore(path.join(root, 'todo.json'));
    await expect(store.write([{ id: '1', text: 'a', status: 'pending' }, { id: '1', text: 'b', status: 'completed' }])).rejects.toThrow('Invalid todo item');
    await expect(store.write([{ id: '1', text: 'a', status: 'in_progress' }, { id: '2', text: 'b', status: 'in_progress' }])).rejects.toThrow('only one in_progress');
  });
});
