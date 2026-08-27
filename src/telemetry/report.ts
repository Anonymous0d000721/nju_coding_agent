import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentRunResult } from '../agent/types.js';
import { redact } from '../shared/redact.js';

export interface RunReport {
  runId: string;
  createdAt: string;
  goal: string;
  stopReason: AgentRunResult['stopReason'];
  turns: number;
  toolCalls: number;
  tools: Array<{ name: string; ok: boolean }>;
}

export function createRunReport(runId: string, prompt: string, result: AgentRunResult): RunReport {
  const toolNames = new Map<string, string>();
  for (const message of result.messages) if (message.role === 'assistant') for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.name);
  const tools = result.messages.filter((message) => message.role === 'tool').map((message) => ({ name: toolNames.get(message.toolCallId ?? '') ?? 'unknown', ok: !/failed|error|denied|unknown_tool/i.test(message.content) }));
  return { runId, createdAt: new Date().toISOString(), goal: redact(prompt.replace(/\s+/g, ' ').trim().slice(0, 500)), stopReason: result.stopReason, turns: result.turns, toolCalls: result.toolCalls, tools };
}

export async function writeRunReport(rootDir: string, report: RunReport): Promise<string> {
  const filePath = path.join(rootDir, 'runs', `${report.runId}.json`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return filePath;
}
