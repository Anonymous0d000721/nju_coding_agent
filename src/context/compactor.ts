import type { AgentMessage } from '../agent/types.js';

export interface CompactionResult {
  messages: AgentMessage[];
  compacted: boolean;
  omittedMessages: number;
  summary: string;
}

export function compactMessages(messages: AgentMessage[], maxChars: number, keepMessages = 8): CompactionResult {
  if (maxChars < 1 || estimate(messages) <= maxChars || messages.length <= keepMessages) return { messages: [...messages], compacted: false, omittedMessages: 0, summary: '' };
  const split = Math.max(1, messages.length - keepMessages);
  let boundary = split;
  while (boundary < messages.length && messages[boundary]?.role === 'tool') boundary += 1;
  const omitted = messages.slice(0, boundary);
  const recent = messages.slice(boundary);
  const summary = summarize(omitted);
  const summaryMessage: AgentMessage = { role: 'system', content: `[Context summary; original messages remain in session history]\n${summary}` };
  const result = [summaryMessage, ...recent];
  while (result.length > 2 && estimate(result) > maxChars) result.splice(1, 1);
  return { messages: result, compacted: true, omittedMessages: omitted.length, summary };
}

function summarize(messages: AgentMessage[]): string {
  const users = messages.filter((message) => message.role === 'user').map((message) => oneLine(message.content).slice(0, 240));
  const assistants = messages.filter((message) => message.role === 'assistant').map((message) => oneLine(message.content).slice(0, 240));
  const tools = messages.filter((message) => message.role === 'tool').map((message) => oneLine(message.content).slice(0, 180));
  return [
    `Omitted messages: ${messages.length}.`,
    users.length ? `Earlier user requests: ${users.join(' | ')}` : '',
    assistants.length ? `Earlier assistant work: ${assistants.join(' | ')}` : '',
    tools.length ? `Earlier tool observations: ${tools.join(' | ')}` : '',
  ].filter(Boolean).join('\n');
}

function estimate(messages: AgentMessage[]): number { return messages.reduce((total, message) => total + message.content.length + JSON.stringify(message.toolCalls ?? []).length, 0); }
function oneLine(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
