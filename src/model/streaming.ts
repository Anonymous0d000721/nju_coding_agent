import type { AssistantTurn } from '../agent/types.js';
import type { ModelRequest } from './model-client.js';

export type ModelStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'done'; turn: AssistantTurn };

export type ModelStreamHandler = (event: ModelStreamEvent) => void | Promise<void>;

export async function readSse(response: Response, onEvent: (event: string, data: unknown) => void | Promise<void>): Promise<void> {
  if (!response.body) throw new Error('Streaming model response did not include a body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];

  const flush = async () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    dataLines = [];
    const name = eventName;
    eventName = 'message';
    if (data === '[DONE]') return;
    try { await onEvent(name, JSON.parse(data)); } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`Invalid SSE JSON payload: ${data.slice(0, 300)}`);
      throw error;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) { await flush(); continue; }
      if (line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      const valueText = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
      if (field === 'event') eventName = valueText;
      if (field === 'data') dataLines.push(valueText);
    }
    if (done) break;
  }
  if (buffer) {
    if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).replace(/^ /, ''));
  }
  await flush();
}

export async function emit(handler: ModelStreamHandler | undefined, event: ModelStreamEvent): Promise<void> {
  await handler?.(event);
}

export type StreamComplete = (request: ModelRequest, handler?: ModelStreamHandler, signal?: AbortSignal) => Promise<AssistantTurn>;
