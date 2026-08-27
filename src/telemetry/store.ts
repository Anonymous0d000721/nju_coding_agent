import fs from 'node:fs/promises';
import path from 'node:path';
import { redact } from '../shared/redact.js';

export type TelemetryMode = 'off' | 'normal' | 'debug';
export interface TelemetryEvent { type: string; timestamp?: string; sessionId?: string; runId?: string; data?: Record<string, unknown>; }

export class TelemetryStore {
  constructor(private readonly filePath: string, private readonly mode: TelemetryMode = 'normal', private readonly secrets: string[] = []) {}

  async append(event: TelemetryEvent): Promise<void> {
    if (this.mode === 'off') return;
    const safe = JSON.parse(redact(JSON.stringify({ ...event, timestamp: event.timestamp ?? new Date().toISOString() }), { extraSecrets: this.secrets }));
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(safe)}\n`, 'utf8');
  }
}
