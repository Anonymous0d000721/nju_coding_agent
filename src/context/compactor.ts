import type { AgentMessage } from '../agent/types.js';
import type { HarnessPlugin } from './harness.js';

export interface CompactionResult {
  messages: AgentMessage[];
  compacted: boolean;
  omittedMessages: number;
  summary: string;
  coveredEntryIds: string[];
  firstKeptEntryId?: string;
  stats: { sourceChars: number; outputChars: number; omittedToolOutputChars: number };
}

/** Produces a local, deterministic session recap without invoking a model or network. */
export function compactMessages(messages: AgentMessage[], maxChars: number, keepMessages = 8, force = false): CompactionResult {
  const unchanged = (): CompactionResult => ({ messages: [...messages], compacted: false, omittedMessages: 0, summary: '', coveredEntryIds: [], stats: { sourceChars: estimate(messages), outputChars: 0, omittedToolOutputChars: 0 } });
  if (maxChars < 1 || (!force && estimate(messages) <= maxChars) || messages.length <= keepMessages) return unchanged();

  let boundary = Math.max(1, messages.length - keepMessages);
  boundary = moveBoundaryToPairedTurn(messages, boundary);
  if (boundary >= messages.length) return unchanged();
  const omitted = messages.slice(0, boundary);
  const recent = messages.slice(boundary);
  const summary = summarize(omitted);
  const summaryMessage: AgentMessage = { role: 'system', content: `[Deterministic context summary; original session entries remain append-only]\n${summary}` };
  const result = [summaryMessage, ...recent];
  while (result.length > 2 && estimate(result) > maxChars) result.splice(1, 1);
  const omittedToolOutputChars = omitted.filter((message) => message.role === 'tool').reduce((total, message) => total + message.content.length, 0);
  return {
    messages: result,
    compacted: true,
    omittedMessages: omitted.length,
    summary,
    coveredEntryIds: omitted.flatMap((message) => message.sessionEntryId ? [message.sessionEntryId] : []),
    firstKeptEntryId: recent.find((message) => message.sessionEntryId)?.sessionEntryId,
    stats: { sourceChars: estimate(omitted), outputChars: summary.length, omittedToolOutputChars },
  };
}

function moveBoundaryToPairedTurn(messages: AgentMessage[], boundary: number): number {
  let next = boundary;
  while (next > 0 && messages[next]?.role === 'tool') next -= 1;
  const candidate = messages[next];
  if (candidate?.role === 'assistant' && candidate.toolCalls?.length) return next;
  return boundary;
}

function summarize(messages: AgentMessage[]): string {
  const users = messages.filter((message) => message.role === 'user').map((message) => oneLine(message.content).slice(0, 240));
  const assistants = messages.filter((message) => message.role === 'assistant' && message.content.trim()).map((message) => oneLine(message.content).slice(0, 240));
  const tools = messages.filter((message) => message.role === 'tool').map((message) => oneLine(message.content).slice(0, 180));
  const failures = tools.filter((tool) => /failed|error|denied|timeout/i.test(tool));
  const sections = [
    section('Session Goal', users.length ? users : []),
    section('Files And Changes', tools.filter((tool) => /write_file|hashline_edit|edit|changed|modified/i.test(tool))),
    section('Commands And Checks', tools.filter((tool) => /run_command|exitCode|test|lint|build/i.test(tool))),
    section('Tool Failures / Blockers', failures),
    section('Decisions', assistants),
    section('Recall', [`Compacted ${messages.length} messages; ${tools.length} tool observations were retained as references only.`]),
  ].filter(Boolean);
  return sections.join('\n\n');
}

function section(title: string, lines: string[]): string {
  return lines.length ? `[${title}]\n${lines.map((line) => `- ${line}`).join('\n')}` : '';
}
export function estimateContextChars(messages: AgentMessage[]): number { return messages.reduce((total, message) => total + message.content.length + JSON.stringify(message.toolCalls ?? []).length, 0); }
function estimate(messages: AgentMessage[]): number { return estimateContextChars(messages); }

/** Harness plugin facade for the deterministic local compaction algorithm. */
export class DeterministicCompactPlugin implements HarnessPlugin {
  readonly id = 'deterministic-compact';
  readonly version = '1';

  compact(messages: AgentMessage[], maxChars: number, keepMessages = 8, force = false): CompactionResult {
    return compactMessages(messages, maxChars, keepMessages, force);
  }
}
function oneLine(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
