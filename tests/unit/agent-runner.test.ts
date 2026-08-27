import { describe, expect, it } from 'vitest';
import { toAnthropicMessages } from '../../src/model/anthropic.js';
import { AgentRunner, trimContext } from '../../src/agent/runner.js';
import { HookRegistry } from '../../src/agent/hooks.js';
import type { AssistantTurn } from '../../src/agent/types.js';
import type { ModelClient, ModelRequest } from '../../src/model/model-client.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { ToolRegistry } from '../../src/tools/registry.js';

class FakeModel implements ModelClient {
  private index = 0;

  constructor(private readonly turns: AssistantTurn[]) {}

  async complete(_request: ModelRequest): Promise<AssistantTurn> {
    const turn = this.turns[this.index];
    this.index += 1;
    if (!turn) throw new Error('unexpected model call');
    return turn;
  }
}

class StreamingFakeModel implements ModelClient {
  complete(): Promise<AssistantTurn> { throw new Error('complete should not be called'); }

  async stream(_request: ModelRequest, handler?: (event: import('../../src/model/streaming.js').ModelStreamEvent) => void | Promise<void>): Promise<AssistantTurn> {
    await handler?.({ type: 'text_delta', delta: 'Hel' });
    await handler?.({ type: 'text_delta', delta: 'lo' });
    const turn = assistant({ id: 'stream-1', text: 'Hello' });
    await handler?.({ type: 'done', turn });
    return turn;
  }
}

function assistant(turn: Partial<AssistantTurn>): AssistantTurn {
  return {
    id: turn.id ?? 'a1',
    text: turn.text ?? '',
    toolCalls: turn.toolCalls ?? [],
    stopReason: turn.stopReason ?? 'end_turn',
  };
}

function createRunner(model: ModelClient, hooks?: HookRegistry): AgentRunner {
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo',
    description: 'Echo a JSON value.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    risk: 'read',
    readonly: true,
    handler: (args) => args,
  });

  registry.register({
    name: 'run_command',
    description: 'Test-only command evidence.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
    readonly: true,
    handler: () => ({ exitCode: 0 }),
  });

  return new AgentRunner({
    model,
    tools: new ToolExecutor(registry, { workspaceRoot: process.cwd() }),
    systemPrompt: 'You are nju-agent.',
    toolDefinitions: registry.definitionsForModel(),
    hooks,
  });
}

describe('AgentRunner', () => {
  it('denies write and shell tools in strict mode without approval', async () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'write_test', description: 'test', parameters: { type: 'object' }, risk: 'write', readonly: false, handler: () => 'should not run' });
    const executor = new ToolExecutor(registry, { workspaceRoot: process.cwd(), permissionMode: 'strict' });
    const [result] = await executor.executeBatch([{ id: 'p1', name: 'write_test', argumentsJson: '{}' }]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('permission_denied');
  });

  it('bounds oversized tool observations', async () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'large_result', description: 'test', parameters: { type: 'object' }, risk: 'read', readonly: true, handler: () => 'x'.repeat(20_000) });
    const executor = new ToolExecutor(registry, { workspaceRoot: process.cwd() });
    const [result] = await executor.executeBatch([{ id: 'b1', name: 'large_result', argumentsJson: '{}' }]);
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThan(12_100);
  });

  it('stops after a plain assistant answer', async () => {
    const runner = createRunner(new FakeModel([assistant({ text: 'done' })]));

    const result = await runner.run('hello', { maxTurns: 3, maxToolCalls: 5 });

    expect(result.stopReason).toBe('model_finished');
    expect(result.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('requires command verification before ending a fix request when GoalGate is enabled', async () => {
    const runner = createRunner(new FakeModel([
      assistant({ text: 'done too early' }),
      assistant({ toolCalls: [{ id: 'verify-1', name: 'run_command', argumentsJson: '{}' }] }),
      assistant({ text: 'verified' }),
    ]));
    const result = await runner.run('fix the bug and run tests', { maxTurns: 3, maxToolCalls: 2, goalGate: true });
    expect(result.stopReason).toBe('model_finished');
    expect(result.messages.some((message) => message.content.includes('Host verification requirement'))).toBe(true);
    expect(result.messages.some((message) => message.role === 'tool' && message.toolCallId === 'verify-1')).toBe(true);
  });


  it('reports context compaction through the run callback', async () => {
    const compactions: number[] = [];
    const runner = createRunner(new FakeModel([assistant({ text: 'done' })]));
    await runner.run('current', {
      maxTurns: 1,
      maxToolCalls: 1,
      maxContextChars: 40,
      initialMessages: Array.from({ length: 9 }, (_, index) => ({ role: 'user' as const, content: `${index}:${'a'.repeat(100)}` })),
      onCompaction: (_summary, omittedMessages) => { compactions.push(omittedMessages); },
    });
    expect(compactions[0]).toBeGreaterThan(0);
  });

  it('runs onStop for normal completion', async () => {
    const stops: string[] = [];
    const hooks = new HookRegistry();
    hooks.register({ onStop: ({ result }) => { stops.push(result.stopReason); } });
    await createRunner(new FakeModel([assistant({ text: 'done' })]), hooks).run('hello', { maxTurns: 3, maxToolCalls: 5 });
    expect(stops).toEqual(['model_finished']);
  });

  it('forwards stream events and persists the complete assistant turn', async () => {
    const events: string[] = [];
    const runner = createRunner(new StreamingFakeModel());
    const result = await runner.run('hello', {
      maxTurns: 3,
      maxToolCalls: 5,
      onStreamEvent: (event) => { if (event.type === 'text_delta') events.push(event.delta); },
    });

    expect(events).toEqual(['Hel', 'lo']);
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Hello' });
  });

  it('emits complete tool lifecycle events around execution', async () => {
    const runner = createRunner(new FakeModel([
      assistant({ toolCalls: [{ id: 'tc1', name: 'echo', argumentsJson: '{"value":"ok"}' }] }),
      assistant({ text: 'finished' }),
    ]));
    const events: string[] = [];

    await runner.run('use a tool', {
      maxTurns: 3,
      maxToolCalls: 5,
      onStreamEvent: (event) => { if (event.type === 'tool_call') events.push(`call:${event.toolCall.name}`); if (event.type === 'tool_result') events.push(`result:${event.result.toolName}:${event.result.ok}`); },
    });

    expect(events).toEqual(['call:echo', 'result:echo:true']);
  });

  it('executes tool calls and sends results into the message history', async () => {
    const runner = createRunner(new FakeModel([
      assistant({
        id: 'a1',
        toolCalls: [{ id: 'tc1', name: 'echo', argumentsJson: '{"value":"ok"}' }],
        stopReason: 'tool_calls',
      }),
      assistant({ id: 'a2', text: 'finished' }),
    ]));

    const result = await runner.run('use a tool', { maxTurns: 3, maxToolCalls: 5 });

    expect(result.stopReason).toBe('model_finished');
    expect(result.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(result.messages[2]).toMatchObject({ role: 'tool', toolCallId: 'tc1' });
    expect(result.toolCalls).toBe(1);
  });

  it('produces Anthropic-adjacent tool result blocks from the runner history', async () => {
    const runner = createRunner(new FakeModel([
      assistant({ toolCalls: [{ id: 'call_01', name: 'echo', argumentsJson: '{"value":"ok"}' }] }),
      assistant({ text: 'finished' }),
    ]));

    const result = await runner.run('use a tool', { maxTurns: 3, maxToolCalls: 5 });
    const messages = toAnthropicMessages({ systemPrompt: 'system', tools: [], messages: result.messages.slice(0, 3) });

    expect(messages[1]).toMatchObject({ role: 'assistant', content: [{ type: 'tool_use', id: 'call_01' }] });
    expect(messages[2]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_01' }] });
  });

  it('converts unknown tools into paired tool result messages', async () => {
    const runner = createRunner(new FakeModel([
      assistant({ toolCalls: [{ id: 'tc1', name: 'missing_tool', argumentsJson: '{}' }] }),
      assistant({ text: 'recovered' }),
    ]));

    const result = await runner.run('call missing tool', { maxTurns: 3, maxToolCalls: 5 });

    expect(result.stopReason).toBe('model_finished');
    expect(result.messages[2]).toMatchObject({ role: 'tool', toolCallId: 'tc1' });
    expect(result.messages[2]?.content).toContain('unknown_tool');
  });

  it('trims old messages without leaving orphan tool results', () => {
    const messages = trimContext([
      { role: 'user', content: 'old' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'echo', argumentsJson: '{}' }] },
      { role: 'tool', toolCallId: 'tc1', content: 'old result' },
      { role: 'user', content: 'current request' },
    ], 20);

    expect(messages[0]?.role).not.toBe('tool');
    expect(messages.at(-1)?.content).toBe('current request');
  });

  it('stops before exceeding the total tool call budget', async () => {
    const runner = createRunner(new FakeModel([
      assistant({ toolCalls: [
        { id: 'tc1', name: 'echo', argumentsJson: '{"value":"1"}' },
        { id: 'tc2', name: 'echo', argumentsJson: '{"value":"2"}' },
      ] }),
    ]));

    const result = await runner.run('too many tools', { maxTurns: 3, maxToolCalls: 1 });

    expect(result.stopReason).toBe('max_tool_calls');
    expect(result.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });
});
