import { describe, expect, it } from 'vitest';
import { activeTodos } from '../src/todo.js';

describe('activeTodos', () => {
  it('returns incomplete tasks only', () => {
    expect(activeTodos([{ title: 'write demo', completed: false }, { title: 'ship demo', completed: true }])).toEqual([{ title: 'write demo', completed: false }]);
  });
});
