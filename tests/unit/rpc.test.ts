import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runRpc } from '../../src/app/rpc.js';
import type { AgentConfig } from '../../src/shared/config.js';
import type { AgentStreamEvent } from '../../src/agent/types.js';

function config(rootDir: string): AgentConfig {
  return {
    workspaceRoot: rootDir,
    permissionMode: 'yolo',
    telemetry: 'off',
    projectTrusted: false,
    model: { apiKey: 'test-key', baseUrl: 'https://example.test/v1', model: 'test-model', apiFormat: 'openai-chat', thinking: { level: 'medium' } },
    session: { enabled: true },
    memory: { enabled: false },
    mcpServers: [],
  };
}

function lines(output: PassThrough): Record<string, unknown>[] {
  return output.read().toString().trim().split(/\r?\n/).filter(Boolean).map((line: string) => JSON.parse(line) as Record<string, unknown>);
}

async function tick(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 100)); }

describe('JSON-RPC mode', () => {
  it('handles initialize, session creation, state, and shutdown over JSONL', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = runRpc({
      config: config('D:/rpc-test'), stdin: input, stdout: output,
      runPrompt: async () => ({ exitCode: 0 }),
      compactSession: async () => ({ compacted: false, omittedMessages: 0, outputChars: 0 }),
    });

    input.write('{"jsonrpc":"2.0","id":"i","method":"initialize"}\n');
    input.write('{"jsonrpc":"2.0","id":"n","method":"session/new"}\n');
    await tick();
    const first = lines(output);
    expect(first[0]).toMatchObject({ jsonrpc: '2.0', id: 'i', result: { protocolVersion: '1.0' } });
    expect(first[1]).toMatchObject({ jsonrpc: '2.0', id: 'n', result: { sessionId: expect.any(String) } });

    input.write('{"jsonrpc":"2.0","id":"s","method":"session/state"}\n');
    input.write('{"jsonrpc":"2.0","id":"q","method":"shutdown"}\n');
    const result = await rpc;
    await tick();
    const rest = lines(output);
    expect(rest[0]).toMatchObject({ jsonrpc: '2.0', id: 's', result: { running: false } });
    expect(rest[1]).toMatchObject({ jsonrpc: '2.0', id: 'q', result: { shuttingDown: true } });
    expect(result.exitCode).toBe(0);
  });

  it('accepts a prompt and forwards streaming lifecycle events without writing protocol data to the model stream', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let seenPrompt = '';
    const events: AgentStreamEvent[] = [{ type: 'text_delta', delta: 'done' }];
    const rpc = runRpc({
      config: config('D:/rpc-test-prompt'), stdin: input, stdout: output,
      runPrompt: async (_config, prompt, _sessionId, _mode, _thinking, _stream, _showThinking, onAgentEvent) => {
        seenPrompt = prompt;
        for (const event of events) await onAgentEvent?.(event);
        return { exitCode: 0, sessionId: 'session-1', stdout: 'assistant: done\n' };
      },
      compactSession: async () => ({ compacted: false, omittedMessages: 0, outputChars: 0 }),
    });

    input.write('{"jsonrpc":"2.0","id":"p","method":"prompt","params":{"text":"fix it"}}\n');
    await tick();
    const accepted = lines(output);
    expect(accepted.some((message) => message.jsonrpc === '2.0' && message.id === 'p' && message.result && (message.result as { accepted?: boolean }).accepted === true)).toBe(true);
    await tick();
    input.write('{"jsonrpc":"2.0","id":"q","method":"shutdown"}\n');
    await rpc;
    await tick();
    const messages = [...accepted, ...lines(output)];
    expect(seenPrompt).toBe('fix it');
    expect(messages.some((message) => message.params && (message.params as { type?: string }).type === 'message_delta')).toBe(true);
    expect(messages.some((message) => message.params && (message.params as { type?: string }).type === 'run_end')).toBe(true);
  });

  it('returns JSON-RPC errors for malformed JSON, unknown methods, and invalid parameters', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = runRpc({
      config: config('D:/rpc-test-errors'), stdin: input, stdout: output,
      runPrompt: async () => ({ exitCode: 0 }),
      compactSession: async () => ({ compacted: false, omittedMessages: 0, outputChars: 0 }),
    });
    input.write('not json\n');
    input.write('{"jsonrpc":"2.0","id":1,"method":"unknown"}\n');
    input.write('{"jsonrpc":"2.0","id":2,"method":"prompt","params":{}}\n');
    await tick();
    const messages = lines(output);
    expect(messages[0]).toMatchObject({ error: { code: -32700 } });
    expect(messages[1]).toMatchObject({ id: 1, error: { code: -32601 } });
    expect(messages[2]).toMatchObject({ id: 2, error: { code: -32602 } });
    input.write('{"jsonrpc":"2.0","id":3,"method":"shutdown"}\n');
    await rpc;
  });
});
