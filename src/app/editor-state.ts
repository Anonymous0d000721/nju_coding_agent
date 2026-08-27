export const MAX_INLINE_PASTE_CHARS = 20_000;

export interface EditorState {
  text: string;
  /** Offset in UTF-16 code units, always at a grapheme boundary. */
  cursorOffset: number;
  preferredColumn?: number;
  history: string[];
  historyIndex?: number;
  draft?: { text: string; cursorOffset: number };
}

export function createEditorState(history: string[] = []): EditorState {
  return { text: '', cursorOffset: 0, history };
}

export function graphemeBoundaries(text: string): number[] {
  const Segmenter = Intl.Segmenter;
  if (Segmenter) return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((part) => part.index);
  return Array.from(text).reduce<number[]>((offsets, char) => {
    offsets.push(offsets.length === 0 ? 0 : offsets[offsets.length - 1]! + text.slice(offsets[offsets.length - 1]!).match(/^./su)![0].length);
    return offsets;
  }, []);
}

function clampBoundary(text: string, offset: number): number {
  const boundaries = graphemeBoundaries(text);
  const candidates = [...boundaries, text.length].filter((item) => item <= Math.max(0, Math.min(offset, text.length)));
  return candidates.at(-1) ?? 0;
}

function previousBoundary(text: string, offset: number): number {
  return clampBoundary(text, Math.max(0, offset - 1));
}

function nextBoundary(text: string, offset: number): number {
  const boundary = graphemeBoundaries(text).find((item) => item > offset);
  return boundary ?? text.length;
}

export function insertText(state: EditorState, value: string): EditorState {
  const text = `${state.text.slice(0, state.cursorOffset)}${value}${state.text.slice(state.cursorOffset)}`;
  return { ...state, text, cursorOffset: state.cursorOffset + value.length, preferredColumn: undefined, historyIndex: undefined };
}

export function insertPaste(state: EditorState, value: string): { state: EditorState; truncated: boolean } {
  const truncated = value.length > MAX_INLINE_PASTE_CHARS;
  const safeValue = truncated ? `${value.slice(0, MAX_INLINE_PASTE_CHARS)}\n[paste truncated]` : value;
  return { state: insertText(state, safeValue), truncated };
}

export function moveLeft(state: EditorState): EditorState {
  return { ...state, cursorOffset: previousBoundary(state.text, state.cursorOffset), preferredColumn: undefined };
}

export function moveRight(state: EditorState): EditorState {
  return { ...state, cursorOffset: nextBoundary(state.text, state.cursorOffset), preferredColumn: undefined };
}

export function backspace(state: EditorState): EditorState {
  if (state.cursorOffset === 0) return state;
  const start = previousBoundary(state.text, state.cursorOffset);
  return { ...state, text: `${state.text.slice(0, start)}${state.text.slice(state.cursorOffset)}`, cursorOffset: start, preferredColumn: undefined, historyIndex: undefined };
}

export function deleteForward(state: EditorState): EditorState {
  if (state.cursorOffset === state.text.length) return state;
  const end = nextBoundary(state.text, state.cursorOffset);
  return { ...state, text: `${state.text.slice(0, state.cursorOffset)}${state.text.slice(end)}`, preferredColumn: undefined, historyIndex: undefined };
}

function logicalLines(text: string): { start: number; end: number }[] {
  const lines: { start: number; end: number }[] = [];
  let start = 0;
  for (const line of text.split('\n')) { lines.push({ start, end: start + line.length }); start += line.length + 1; }
  return lines;
}

function cursorLine(lines: { start: number; end: number }[], offset: number): number {
  return lines.findIndex((line, index) => offset <= line.end || index === lines.length - 1);
}

export function moveUp(state: EditorState): EditorState {
  const lines = logicalLines(state.text);
  const index = cursorLine(lines, state.cursorOffset);
  if (lines.length > 1 && index > 0) {
    const column = state.preferredColumn ?? state.cursorOffset - lines[index]!.start;
    const target = lines[index - 1]!;
    return { ...state, cursorOffset: clampBoundary(state.text, Math.min(target.start + column, target.end)), preferredColumn: column };
  }
  if (lines.length === 1 && state.text && state.cursorOffset !== 0) return { ...state, cursorOffset: 0, preferredColumn: undefined };
  return moveHistory(state, -1);
}

export function moveDown(state: EditorState): EditorState {
  const lines = logicalLines(state.text);
  const index = cursorLine(lines, state.cursorOffset);
  if (lines.length > 1 && index < lines.length - 1) {
    const column = state.preferredColumn ?? state.cursorOffset - lines[index]!.start;
    const target = lines[index + 1]!;
    return { ...state, cursorOffset: clampBoundary(state.text, Math.min(target.start + column, target.end)), preferredColumn: column };
  }
  if (lines.length === 1 && state.text && state.cursorOffset !== state.text.length) return { ...state, cursorOffset: state.text.length, preferredColumn: undefined };
  return moveHistory(state, 1);
}

function moveHistory(state: EditorState, direction: -1 | 1): EditorState {
  if (state.history.length === 0) return state;
  if (direction === -1) {
    const index = state.historyIndex === undefined ? state.history.length - 1 : Math.max(0, state.historyIndex - 1);
    const draft = state.historyIndex === undefined ? { text: state.text, cursorOffset: state.cursorOffset } : state.draft;
    const text = state.history[index]!;
    return { ...state, text, cursorOffset: text.length, historyIndex: index, draft, preferredColumn: undefined };
  }
  if (state.historyIndex === undefined) return state;
  const index = state.historyIndex + 1;
  if (index >= state.history.length) return { ...state, text: state.draft?.text ?? '', cursorOffset: state.draft?.cursorOffset ?? 0, historyIndex: undefined, preferredColumn: undefined };
  const text = state.history[index]!;
  return { ...state, text, cursorOffset: text.length, historyIndex: index, preferredColumn: undefined };
}

export function submitEditor(state: EditorState): { state: EditorState; prompt?: string } {
  const prompt = state.text.trim();
  if (!prompt) return { state };
  const history = prompt.startsWith('/') ? state.history : [...state.history, state.text];
  return { state: createEditorState(history), prompt: state.text };
}

export function parseBracketedPaste(buffer: string): { paste?: string; rest: string } {
  const start = '\u001B[200~'; const end = '\u001B[201~';
  if (!buffer.startsWith(start)) return { rest: buffer };
  const endIndex = buffer.indexOf(end, start.length);
  if (endIndex < 0) return { rest: buffer };
  return { paste: buffer.slice(start.length, endIndex), rest: buffer.slice(endIndex + end.length) };
}

export function slashCompletions(text: string, commands: readonly { name: string; description: string }[]) {
  if (!text.startsWith('/') || /\s/.test(text)) return [];
  const query = text.toLowerCase();
  return commands.filter((command) => command.name.toLowerCase().startsWith(query));
}
