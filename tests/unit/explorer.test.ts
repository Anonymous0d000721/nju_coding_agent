import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPLORER_MAX_FILE_CHARS, EXPLORER_MAX_FILES_CHARS, EXPLORER_MAX_SUMMARY_CHARS, EXPLORER_MAX_TRACE_CHARS, EXPLORER_MAX_TRACE_EVENTS, ReadOnlyExplorer } from '../../src/agent/explorer.js';
import type { AssistantTurn } from '../../src/agent/types.js';
import type { ModelClient, ModelRequest } from '../../src/model/model-client.js';

function assistant(turn: Partial<AssistantTurn>): AssistantTurn {
  return { id: turn.id ?? 'turn', text: turn.text ?? '', toolCalls: turn.toolCalls ?? [], stopReason: turn.stopReason ?? 'end_turn' };
}

class ScriptedModel implements ModelClient {
  private index = 0;
  constructor(private readonly turns: AssistantTurn[]) {}
  async complete(_request: ModelRequest): Promise<AssistantTurn> {
    const turn = this.turns[this.index++];
    if (!turn) throw new Error('unexpected model call');
    return turn;
  }
}

describe('ReadOnlyExplorer', () => {
  it('returns structured findings from an independent read-only context', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-explorer-'));
    await fs.writeFile(path.join(root, 'note.txt'), 'hello explorer\n', 'utf8');
    const explorer = new ReadOnlyExplorer(new ScriptedModel([
      assistant({ toolCalls: [{ id: 'read-1', name: 'read_file', argumentsJson: '{"path":"note.txt"}' }] }),
      assistant({ text: 'note.txt contains the expected greeting.' }),
    ]), root);

    const result = await explorer.explore('Inspect the note.', { maxDurationMs: 1_000 });

    expect(result).toMatchObject({ status: 'completed', toolCalls: 1, files: ['note.txt'] });
    expect(result.summary).toContain('expected greeting');
    expect(result.trace.map((event) => event.type)).toContain('tool_result');
    expect(result.trace.every((event) => event.runId === result.runId)).toBe(true);
  });

  it('bounds returned summary and trace data from a noisy child run', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-explorer-'));
    const filePaths: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const file = `note-${index}-${'x'.repeat(90)}.txt`;
      filePaths.push(file);
      await fs.writeFile(path.join(root, file), 'hello explorer\n', 'utf8');
    }
    const turns = filePaths.map((file, index) => assistant({ id: `turn-${index}`, toolCalls: [{ id: `read-${index}`, name: 'read_file', argumentsJson: JSON.stringify({ path: file }) }], stopReason: 'tool_calls' }));
    turns.push(assistant({ text: 'x'.repeat(EXPLORER_MAX_SUMMARY_CHARS + 1) }));
    const result = await new ReadOnlyExplorer(new ScriptedModel(turns), root).explore('Inspect repeatedly.', { maxDurationMs: 5_000 });

    expect(result.summary.length).toBeLessThanOrEqual(EXPLORER_MAX_SUMMARY_CHARS);
    expect(result.summaryTruncated).toBe(true);
    expect(result.trace.length).toBeLessThanOrEqual(EXPLORER_MAX_TRACE_EVENTS);
    expect(JSON.stringify(result.trace).length).toBeLessThanOrEqual(EXPLORER_MAX_TRACE_CHARS);
    expect(result.traceTruncated).toBe(true);
    expect(result.files.every((file) => file.length <= EXPLORER_MAX_FILE_CHARS)).toBe(true);
    expect(result.files.join('').length).toBeLessThanOrEqual(EXPLORER_MAX_FILES_CHARS);
    expect(result.filesTruncated).toBe(true);
  });

  it('cannot use write or command tools and reports a permission outcome', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-explorer-'));
    const explorer = new ReadOnlyExplorer(new ScriptedModel([
      assistant({ toolCalls: [{ id: 'write-1', name: 'write_file', argumentsJson: '{"path":"blocked.txt","content":"nope"}' }] }),
      assistant({ text: 'The requested write was unavailable.' }),
    ]), root);

    const result = await explorer.explore('Try to modify the workspace.', { maxDurationMs: 1_000 });

    expect(result.status).toBe('permission_denied');
    expect(result.errors.some((error) => error.includes('unknown_tool'))).toBe(true);
    await expect(fs.access(path.join(root, 'blocked.txt'))).rejects.toThrow();
  });

  it('tracks model failure without leaking a child transcript', async () => {
    const model: ModelClient = { complete: async () => { throw new Error('deterministic model failure'); } };
    const result = await new ReadOnlyExplorer(model, process.cwd()).explore('Inspect the repository.');

    expect(result).toMatchObject({ status: 'failed', summary: '', findings: [], toolCalls: 0, stopReason: 'fatal_error' });
    expect(result.errors).toEqual(['deterministic model failure']);
  });

  it('returns cancelled when the parent signal aborts the child run', async () => {
    const controller = new AbortController();
    const model: ModelClient = {
      complete: (_request, signal) => new Promise<AssistantTurn>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('model stopped')), { once: true });
        controller.signal.addEventListener('abort', () => signal?.aborted || undefined, { once: true });
      }),
    };
    const pending = new ReadOnlyExplorer(model, process.cwd()).explore('Wait for cancellation.', { signal: controller.signal, maxDurationMs: 1_000 });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: 'cancelled', stopReason: 'user_cancelled' });
  });

  it('returns timed_out when the child deadline is reached', async () => {
    const model: ModelClient = {
      complete: (_request, signal) => new Promise<AssistantTurn>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('model stopped')), { once: true });
      }),
    };
    const result = await new ReadOnlyExplorer(model, process.cwd()).explore('Wait for timeout.', { maxDurationMs: 10 });

    expect(result).toMatchObject({ status: 'timed_out', stopReason: 'budget_exhausted' });
    expect(result.elapsedMs).toBeLessThan(500);
  });
});
