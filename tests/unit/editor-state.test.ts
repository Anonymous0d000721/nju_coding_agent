import { describe, expect, it } from 'vitest';
import { backspace, createEditorState, deleteForward, insertPaste, insertText, moveDown, moveLeft, moveRight, moveUp, parseBracketedPaste, slashCompletions, submitEditor } from '../../src/app/editor-state.js';

describe('editor state', () => {
  it('moves and deletes complete grapheme clusters', () => {
    const initial = { ...createEditorState(), text: 'a👩‍💻e\u0301', cursorOffset: 'a👩‍💻e\u0301'.length };
    expect(moveLeft(initial).cursorOffset).toBe('a👩‍💻'.length);
    expect(backspace(initial)).toMatchObject({ text: 'a👩‍💻', cursorOffset: 'a👩‍💻'.length });
    const beforeEmoji = { ...initial, cursorOffset: 1 };
    expect(deleteForward(beforeEmoji).text).toBe('ae\u0301');
  });

  it('uses multiline movement before prompt history and preserves draft', () => {
    const state = { ...createEditorState(['old', 'new']), text: 'abc\ndef', cursorOffset: 6 };
    expect(moveUp(state)).toMatchObject({ cursorOffset: 2 });
    expect(moveDown({ ...state, cursorOffset: 1 })).toMatchObject({ cursorOffset: 5 });
    const history = { ...createEditorState(['old']), text: 'draft', cursorOffset: 4 };
    const atStart = moveUp(history);
    expect(atStart).toMatchObject({ text: 'draft', cursorOffset: 0 });
    const previous = moveUp(atStart);
    expect(previous).toMatchObject({ text: 'old', historyIndex: 0 });
    expect(moveDown(previous)).toMatchObject({ text: 'draft', historyIndex: undefined });
  });

  it('moves a nonempty single line to boundary before history', () => {
    const state = { ...createEditorState(['old']), text: 'draft', cursorOffset: 2 };
    expect(moveUp(state)).toMatchObject({ text: 'draft', cursorOffset: 0 });
    expect(moveDown({ ...state, cursorOffset: 1 })).toMatchObject({ text: 'draft', cursorOffset: 5 });
  });

  it('handles bracketed paste atomically and bounds large pastes', () => {
    expect(parseBracketedPaste('\u001B[200~/model gpt\ntext\u001B[201~x')).toEqual({ paste: '/model gpt\ntext', rest: 'x' });
    expect(insertPaste(createEditorState(), 'x'.repeat(20_001))).toMatchObject({ truncated: true });
  });

  it('shares prefix slash completion and keeps slash commands out of history', () => {
    expect(slashCompletions('/re', [{ name: '/resume', description: '' }, { name: '/reasoning', description: '' }, { name: '/model', description: '' }]).map((item) => item.name)).toEqual(['/resume', '/reasoning']);
    const submitted = submitEditor(insertText(createEditorState(['prompt']), '/help'));
    expect(submitted.state.history).toEqual(['prompt']);
  });
});
