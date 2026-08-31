import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runRpc } from '../../src/app/rpc.js';
import { createRunReport, writeRunReport } from '../../src/telemetry/report.js';
import type { AgentConfig } from '../../src/shared/config.js';
import type { AgentRunProgress, AgentStreamEvent } from '../../src/agent/types.js';
import { createIdleRunStatus, createProgressRunStatus } from '../../src/telemetry/report.js';

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
  it('reports current idle configuration instead of a historical report before the first prompt', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-rpc-status-'));
    await writeRunReport(rootDir, createRunReport('old-run', 'previous prompt', { stopReason: 'model_finished', turns: 14, toolCalls: 24, messages: [] }));
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = runRpc({
      config: config(rootDir), stdin: input, stdout: output,
      runPrompt: async () => ({ exitCode: 0 }),
      compactSession: async () => ({ compacted: false, omittedMessages: 0, outputChars: 0 }),
    });

    input.write('{"jsonrpc":"2.0","id":"s","method":"status"}\n');
    await tick();
    const statusMessage = lines(output)[0];
    const status = statusMessage.result as { state: string; workspace: string; model: string; effort: string; permissionMode: string; turns: number; toolCalls: number; stopReason?: string };
    expect(status).toMatchObject({ state: 'idle', workspace: rootDir, model: 'test-model', effort: 'medium', permissionMode: 'yolo', turns: 0, toolCalls: 0 });
    expect(status.stopReason).toBeUndefined();

    input.write('{"jsonrpc":"2.0","id":"q","method":"shutdown"}\n');
    await rpc;
  });

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

  it('publishes incremental active status and exposes the TUI command set through slash', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const progress: AgentRunProgress = {
      runId: 'run-progress', sessionId: 'session-progress', phase: 'tool_start', turn: 1, toolCalls: 0, toolResults: [],
      compactions: 0, warnings: [], errors: [], currentToolName: 'read_file',
    };
    const rpc = runRpc({
      config: config('D:/rpc-test-progress'), stdin: input, stdout: output,
      runPrompt: async (_config, _prompt, _sessionId, _mode, _thinking, _stream, _showThinking, _onAgentEvent, _signal, _approve, _reload, _control, onRunProgress) => {
        onRunProgress?.(createProgressRunStatus('run-progress', progress, { workspace: 'D:/rpc-test-progress', sessionId: 'session-progress', model: 'test-model', effort: 'medium', permissionMode: 'yolo' }));
        await finished;
        return { exitCode: 0, sessionId: 'session-progress' };
      },
      compactSession: async () => ({ compacted: false, omittedMessages: 0, outputChars: 0 }),
    });

    input.write('{"jsonrpc":"2.0","id":"p","method":"prompt","params":{"text":"inspect"}}\n');
    await tick();
    input.write('{"jsonrpc":"2.0","id":"s","method":"status"}\n');
    await tick();
    const statusMessages = lines(output);
    const status = statusMessages.find((message) => message.id === 's')?.result as { state: string; turns: number; currentToolName?: string };
    expect(status).toMatchObject({ state: 'running', turns: 1, currentToolName: 'read_file' });

    input.write('{"jsonrpc":"2.0","id":"h","method":"slash","params":{"command":"/help"}}\n');
    await tick();
    const help = lines(output).find((message) => message.id === 'h')?.result as { commands: string[] };
    expect(help.commands).toContain('/rename <session_name>');
    expect(help.commands).toContain('/reload');
    expect(help.commands).toContain('/status');

    finish();
    input.write('{"jsonrpc":"2.0","id":"q","method":"shutdown"}\n');
    await rpc;
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
