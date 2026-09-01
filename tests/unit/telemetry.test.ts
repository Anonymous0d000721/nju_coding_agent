import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TelemetryStore } from '../../src/telemetry/store.js';

describe('TelemetryStore', () => {
  it('appends redacted JSONL events', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-telemetry-'));
    const file = path.join(root, 'logs', 'events.jsonl');
    await new TelemetryStore(file, 'normal', ['sk-test-secret']).append({ type: 'tool_result', data: { output: 'sk-test-secret' } });
    const content = await fs.readFile(file, 'utf8');
    expect(content).not.toContain('sk-test-secret');
    expect(JSON.parse(content).type).toBe('tool_result');
  });

  it('does not create a file when telemetry is off', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-telemetry-'));
    const file = path.join(root, 'events.jsonl');
    await new TelemetryStore(file, 'off').append({ type: 'run_start' });
    await expect(fs.access(file)).rejects.toThrow();
  });

  it('writes a versioned correlated envelope and supports field queries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-telemetry-'));
    const file = path.join(root, 'events.jsonl');
    const store = new TelemetryStore(file, 'normal', [], { maxBytes: 4_000 });
    await Promise.all([
      store.append({ type: 'tool_result', sessionId: 'session-1', runId: 'run-1', data: { toolCallId: 'call-1', output: 'ok' } }),
      store.append({ type: 'approval_result', sessionId: 'session-1', runId: 'run-1', data: { requestId: 'approval-1', toolCallId: 'call-1' } }),
      store.append({ type: 'file_mutation', sessionId: 'session-1', runId: 'run-1', data: { id: 'mutation-1', toolCallId: 'call-1' } }),
    ]);

    const events = await store.readEvents();
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.schemaVersion === 1 && event.eventId && event.timestamp)).toBe(true);
    expect(events.find((event) => event.approvalId === 'approval-1')).toMatchObject({ toolCallId: 'call-1', runId: 'run-1' });
    await expect(store.query({ runId: 'run-1', toolCallId: 'call-1', limit: 2 })).resolves.toHaveLength(2);
    await expect(store.query({ mutationId: 'mutation-1' })).resolves.toMatchObject([{ type: 'file_mutation' }]);
  });

  it('bounds event payloads and rotates logs without losing valid JSONL', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-telemetry-'));
    const file = path.join(root, 'events.jsonl');
    const store = new TelemetryStore(file, 'normal', [], { maxBytes: 1_024, maxFiles: 2 });
    for (let index = 0; index < 8; index += 1) await store.append({ type: 'large_output', runId: `run-${index}`, data: { output: 'x'.repeat(3_000), index } });

    const files = await fs.readdir(root);
    expect(files.filter((name) => name.startsWith('events.jsonl')).length).toBeLessThanOrEqual(3);
    const events = await store.readEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.schemaVersion === 1)).toBe(true);
    expect(events.some((event) => event.data?.truncated === true)).toBe(true);
    for (const name of files.filter((item) => item.startsWith('events.jsonl'))) {
      const content = await fs.readFile(path.join(root, name), 'utf8');
      for (const line of content.trim().split(/\r?\n/).filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
