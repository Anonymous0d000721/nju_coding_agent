export interface Todo { title: string; completed: boolean; }

export function activeTodos(items: Todo[]): Todo[] {
  return items.filter((item) => !item.completed);
}
