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
});
