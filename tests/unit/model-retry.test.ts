import { describe, expect, it } from 'vitest';
import { ModelTransportError, modelError, withModelRetry, withRetryingModelClient } from '../../src/model/retry.js';
import type { ModelClient, ModelRequest } from '../../src/model/model-client.js';
import { AgentRunner } from '../../src/agent/runner.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { ToolRegistry } from '../../src/tools/registry.js';

const request: ModelRequest = { systemPrompt: 'system', messages: [{ role: 'user', content: 'hello' }], tools: [] };

describe('model retry recovery', () => {
  it('retries transient HTTP failures with bounded exponential delay and reports each retry', async () => {
    let attempts = 0;
    const retries: number[] = [];
    const result = await withModelRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw modelError(new Response('', { status: 503, statusText: 'Unavailable' }));
      return 'ok';
    }, undefined, { baseDelayMs: 0, random: () => 0, onRetry: (event) => { retries.push(event.delayMs); } });

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(retries).toEqual([0, 0]);
  });

  it('honors Retry-After and does not retry non-transient responses', async () => {
    let attempts = 0;
    const started = Date.now();
    await expect(withModelRetry(async () => {
      attempts += 1;
      throw modelError(new Response('', { status: 429, headers: { 'retry-after': '0.01' } }));
    }, undefined, { maxAttempts: 2, maxElapsedMs: 1_000 })).rejects.toMatchObject({ status: 429, retryable: true });
    expect(attempts).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(8);

    attempts = 0;
    await expect(withModelRetry(async () => {
      attempts += 1;
      throw modelError(new Response('', { status: 400 }));
    })).rejects.toMatchObject({ status: 400, retryable: false });
    expect(attempts).toBe(1);
  });

  it('stops waiting when cancelled and preserves the cancellation', async () => {
    const controller = new AbortController();
    const pending = withModelRetry(async () => {
      throw new ModelTransportError('temporary', { code: 'temporary', retryable: true });
    }, controller.signal, { baseDelayMs: 100, maxAttempts: 3 });
    setTimeout(() => controller.abort(), 5);

    await expect(pending).rejects.toThrow('Model request cancelled');
  });

  it('does not retry invalid model responses', async () => {
    let attempts = 0;
    await expect(withModelRetry(async () => {
      attempts += 1;
      throw new Error('invalid model response');
    })).rejects.toMatchObject({ code: 'model_response_error', retryable: false });
    expect(attempts).toBe(1);
  });

  it('preserves the final stop reason when a FakeModel recovers after a transient failure', async () => {
    let attempts = 0;
    const model: ModelClient = {
      complete: async () => {
        attempts += 1;
        if (attempts === 1) throw new ModelTransportError('temporary', { code: 'temporary', retryable: true });
        return { id: 'id', text: 'done', toolCalls: [], stopReason: 'end_turn' };
      },
    };
    const runner = new AgentRunner({ model: withRetryingModelClient(model, { baseDelayMs: 0 }), tools: new ToolExecutor(new ToolRegistry(), { workspaceRoot: process.cwd() }), systemPrompt: 'system', toolDefinitions: [] });
    const result = await runner.run('finish', { goalGate: false });

    expect(result.stopReason).toBe('model_finished');
    expect(attempts).toBe(2);
  });

  it('does not replay streamed output after a partial response', async () => {
    let attempts = 0;
    const client: ModelClient = {
      complete: async () => ({ id: 'id', text: 'ok', toolCalls: [], stopReason: 'end_turn' }),
      stream: async (_request, handler) => {
        attempts += 1;
        await handler?.({ type: 'text_delta', delta: 'partial' });
        throw modelError(new Response('', { status: 503 }));
      },
    };
    await expect(withRetryingModelClient(client, { baseDelayMs: 0 }).stream!(request, undefined)).rejects.toMatchObject({ status: 503 });
    expect(attempts).toBe(1);
  });
});
