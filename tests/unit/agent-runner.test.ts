import { describe, expect, it } from 'vitest';
import { toAnthropicMessages } from '../../src/model/anthropic.js';
import { AgentRunner, trimContext } from '../../src/agent/runner.js';
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

function assistant(turn: Partial<AssistantTurn>): AssistantTurn {
  return {
    id: turn.id ?? 'a1',
    text: turn.text ?? '',
    toolCalls: turn.toolCalls ?? [],
    stopReason: turn.stopReason ?? 'end_turn',
  };
}

function createRunner(model: ModelClient): AgentRunner {
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

  return new AgentRunner({
    model,
    tools: new ToolExecutor(registry, { workspaceRoot: process.cwd() }),
    systemPrompt: 'You are nju-agent.',
    toolDefinitions: registry.definitionsForModel(),
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
