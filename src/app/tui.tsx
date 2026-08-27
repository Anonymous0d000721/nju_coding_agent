import React, { useState } from 'react';
import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process';
import { Box, Text, render, useApp, useInput } from 'ink';
import type { AgentStreamEvent } from '../agent/types.js';
import type { ThinkingLevel } from '../model/model-client.js';
import { clampThinkingLevel } from '../model/thinking.js';
import { createThinkingLevelChangeEntry } from '../session/entries.js';
import { JsonlSessionStore } from '../session/jsonl-store.js';
import type { AgentConfig } from '../shared/config.js';
import { renderHelp } from './renderer.js';
import type { AppResult, AppServices, runPrompt } from './app.js';

export type RunPrompt = typeof runPrompt;

export interface TuiOptions {
  config: AgentConfig;
  services: AppServices;
  runPrompt: RunPrompt;
}

type TuiStatus = 'idle' | 'running' | 'error';
type PickerKind = 'resume' | 'model' | 'effort' | 'reasoning-display';
type PickerOption = { label: string; value: string; description?: string; disabled?: boolean };
type PickerState = { kind: PickerKind; title: string; options: PickerOption[]; index: number };
export type TuiMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string }
  | { role: 'thinking'; text: string }
  | { role: 'tool'; text: string; ok?: boolean }
  | { role: 'system'; text: string }
  | { role: 'error'; text: string };

export async function runTui(options: TuiOptions): Promise<AppResult> {
  const instance = render(<TuiApp {...options} />, {
    stdin: (options.services.stdin ?? defaultStdin) as NodeJS.ReadStream,
    stdout: (options.services.stdout ?? defaultStdout) as NodeJS.WriteStream,
    exitOnCtrlC: true,
    incrementalRendering: true,
  });
  await instance.waitUntilExit();
  return { exitCode: 0 };
}

function TuiApp({ config, runPrompt }: TuiOptions) {
  const app = useApp();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<TuiMessage[]>([
    { role: 'system', text: `nju-agent ${config.model.model} · type /help for commands` },
  ]);
  const [status, setStatus] = useState<TuiStatus>('idle');
  const [sessionId, setSessionId] = useState<string | undefined>(config.session.id);
  const [showReasoning, setShowReasoning] = useState(false);
  const [picker, setPicker] = useState<PickerState | undefined>();

  const append = (message: TuiMessage) => setMessages((items) => [...items, message]);
  const appendSystem = (text: string) => append({ role: 'system', text });
  const appendError = (text: string) => {
    setStatus('error');
    append({ role: 'error', text });
  };

  const persistEffort = async (level: ThinkingLevel, targetSessionId = sessionId) => {
    config.model.thinking = { ...config.model.thinking, level };
    if (targetSessionId && config.session.enabled) {
      await new JsonlSessionStore(`${config.workspaceRoot}/.nju-agent`).append(targetSessionId, createThinkingLevelChangeEntry(targetSessionId, level));
    }
  };

  const setModel = (model: string) => {
    config.model.model = model;
    config.model.thinking = { ...config.model.thinking, level: clampThinkingLevel(config.model.thinking.level, config.model.thinking.map) };
    appendSystem(`model: ${config.model.model}\neffort: ${config.model.thinking.level}`);
  };

  const applyPicker = async (state: PickerState, option: PickerOption) => {
    if (option.disabled) return;
    setPicker(undefined);
    if (state.kind === 'resume') {
      const next = option.value === '__new__' ? undefined : option.value;
      setSessionId(next);
      appendSystem(`session: ${next ?? '(new)'}`);
      return;
    }
    if (state.kind === 'model') {
      setModel(option.value);
      return;
    }
    if (state.kind === 'effort') {
      const level = clampThinkingLevel(option.value as ThinkingLevel, config.model.thinking.map);
      await persistEffort(level);
      appendSystem(`effort: ${level}`);
      return;
    }
    if (state.kind === 'reasoning-display') {
      const enabled = option.value === 'on';
      setShowReasoning(enabled);
      appendSystem(`reasoning display: ${enabled ? 'on' : 'off'}`);
    }
  };

  const openPicker = async (kind: PickerKind) => {
    try {
      setPicker(await createPicker(kind, config, sessionId, showReasoning));
    } catch (error) {
      appendError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSubmit = async (raw: string) => {
    const line = raw.trim();
    if (!line || status === 'running') return;
    setInput('');
    if (line.startsWith('/')) {
      await handleCommand(line, { app, config, sessionId, setSessionId, showReasoning, setShowReasoning, openPicker, appendSystem, appendError, persistEffort, setModel });
      return;
    }

    append({ role: 'user', text: line });
    setStatus('running');
    try {
      const result = await runPrompt(config, line, sessionId, 'text', config.model.thinking, undefined, showReasoning, (event) => {
        setMessages((items) => applyAgentEvent(items, event, showReasoning));
      });
      if (result.sessionId) setSessionId(result.sessionId);
      if (result.stderr) appendError(result.stderr.trim());
      if (result.stdout?.trim()) appendSystem(result.stdout.trim());
      setStatus(result.exitCode === 0 ? 'idle' : 'error');
    } catch (error) {
      appendError(error instanceof Error ? error.message : String(error));
    }
  };

  useInput((value, key) => {
    if (status === 'running') return;
    if (picker) {
      if (key.escape) { setPicker(undefined); return; }
      if (key.upArrow) { setPicker({ ...picker, index: previousEnabledIndex(picker) }); return; }
      if (key.downArrow) { setPicker({ ...picker, index: nextEnabledIndex(picker) }); return; }
      if (key.return) { const option = picker.options[picker.index]; if (option && !option.disabled) void applyPicker(picker, option); return; }
      return;
    }
    if (key.return) { void handleSubmit(input); return; }
    if (key.backspace || key.delete) { setInput((text) => text.slice(0, -1)); return; }
    if (key.ctrl && value === 'c') { app.exit(); return; }
    if (value && !key.ctrl && !key.meta) setInput((text) => `${text}${value}`);
  });

  return <Box flexDirection="column">
    <Box borderStyle="round" paddingX={1}>
      <Text>workspace: {config.workspaceRoot} · api: {config.model.apiFormat} · model: {config.model.model} · effort: {config.model.thinking.level} · session: {sessionId ?? '(new)'} · permission: {config.permissionMode} · reasoning display: {showReasoning ? 'on' : 'off'} · {status}</Text>
    </Box>
    <Box flexDirection="column" marginTop={1}>
      {messages.slice(-30).map((message, index) => <MessageLine key={`${message.role}-${index}`} message={message} />)}
    </Box>
    {picker ? <PickerView picker={picker} /> : <Box marginTop={1}>
      <Text color={status === 'running' ? 'yellow' : 'green'}>{status === 'running' ? 'running…' : '>'} </Text><Text>{input}</Text>
    </Box>}
  </Box>;
}

function PickerView({ picker }: { picker: PickerState }) {
  return <Box flexDirection="column" marginTop={1} borderStyle="single" paddingX={1}>
    <Text color="cyan">{picker.title} (↑/↓ choose · Enter select · Esc cancel)</Text>
    {picker.options.map((option, index) => <Box key={`${option.value}-${index}`}>
      <Text color={option.disabled ? 'gray' : index === picker.index ? 'green' : 'white'}>{index === picker.index ? '› ' : '  '}{option.label}</Text>
      {option.description ? <Text color="gray"> — {option.description}</Text> : null}
    </Box>)}
  </Box>;
}

function MessageLine({ message }: { message: TuiMessage }) {
  const label = message.role === 'assistant' ? 'assistant' : message.role;
  const color = message.role === 'error' ? 'red' : message.role === 'tool' ? 'cyan' : message.role === 'thinking' ? 'gray' : message.role === 'user' ? 'green' : 'white';
  return <Box><Text color={color}>{label}: </Text><Text color={color}>{message.text}</Text></Box>;
}

export function applyAgentEvent(messages: TuiMessage[], event: AgentStreamEvent, showReasoning: boolean): TuiMessage[] {
  if (event.type === 'text_delta') return appendToLast(messages, 'assistant', event.delta);
  if (event.type === 'thinking_delta') return showReasoning && event.delta ? appendToLast(messages, 'thinking', event.delta) : messages;
  if (event.type === 'tool_call') return [...messages, { role: 'tool', text: `[tool] ${event.toolCall.name}` }];
  if (event.type === 'tool_result') {
    const status = event.result.ok ? 'completed' : `failed:${event.result.error?.code ?? 'error'}`;
    return [...messages, { role: 'tool', text: `[tool result] ${event.result.toolName} ${status}`, ok: event.result.ok }];
  }
  return messages;
}

function appendToLast(messages: TuiMessage[], role: 'assistant' | 'thinking', delta: string): TuiMessage[] {
  const last = messages.at(-1);
  if (last?.role === role) return [...messages.slice(0, -1), { role, text: `${last.text}${delta}` }];
  return [...messages, { role, text: delta }];
}

interface CommandContext {
  app: ReturnType<typeof useApp>;
  config: AgentConfig;
  sessionId?: string;
  setSessionId: (value: string | undefined) => void;
  showReasoning: boolean;
  setShowReasoning: (value: boolean) => void;
  openPicker: (kind: PickerKind) => Promise<void>;
  appendSystem: (text: string) => void;
  appendError: (text: string) => void;
  persistEffort: (level: ThinkingLevel, targetSessionId?: string) => Promise<void>;
  setModel: (model: string) => void;
}

async function handleCommand(line: string, ctx: CommandContext): Promise<void> {
  if (line === '/quit' || line === '/exit') { ctx.app.exit(); return; }
  if (line === '/help') { ctx.appendSystem(renderHelp().trim()); return; }
  if (line === '/new') { ctx.setSessionId(undefined); ctx.appendSystem('Started a new session.'); return; }
  if (line === '/session') { ctx.appendSystem(`session: ${ctx.sessionId ?? '(new)'}\nmodel: ${ctx.config.model.model}\neffort: ${ctx.config.model.thinking.level}\nreasoning display: ${ctx.showReasoning ? 'on' : 'off'}\npermission: ${ctx.config.permissionMode}`); return; }

  if (line === '/reasoning' || line === '/thinking') { await ctx.openPicker('reasoning-display'); return; }
  if (line.startsWith('/reasoning ') || line.startsWith('/thinking ')) {
    const command = line.startsWith('/reasoning ') ? '/reasoning' : '/thinking';
    const requested = line.slice(command.length).trim();
    if (requested !== 'on' && requested !== 'off') { ctx.appendError('Usage: /reasoning [on|off]'); return; }
    ctx.setShowReasoning(requested === 'on');
    ctx.appendSystem(`reasoning display: ${requested}`);
    return;
  }

  if (line === '/effort') { await ctx.openPicker('effort'); return; }
  if (line.startsWith('/effort ')) {
    const requested = line.slice('/effort'.length).trim();
    if (!isThinkingLevel(requested)) { ctx.appendError(`Invalid effort: ${requested}. Expected: ${supportedEffortText(ctx.config)}`); return; }
    const level = clampThinkingLevel(requested, ctx.config.model.thinking.map);
    await ctx.persistEffort(level);
    ctx.appendSystem(`effort: ${level}`);
    return;
  }

  if (line === '/model') { await ctx.openPicker('model'); return; }
  if (line.startsWith('/model ')) {
    const requested = line.slice('/model'.length).trim();
    if (requested) ctx.setModel(requested);
    return;
  }

  if (line === '/compact') { ctx.appendSystem('Context compaction is not implemented.'); return; }
  if (line === '/sessions') {
    if (!ctx.config.session.enabled) { ctx.appendSystem('Sessions are disabled.'); return; }
    const sessions = await new JsonlSessionStore(`${ctx.config.workspaceRoot}/.nju-agent`).list();
    ctx.appendSystem(sessions.length ? sessions.map((item) => item.id).join('\n') : 'No sessions.');
    return;
  }
  if (line === '/resume') { await ctx.openPicker('resume'); return; }
  if (line.startsWith('/resume ')) {
    const requested = line.slice('/resume'.length).trim();
    ctx.setSessionId(requested || undefined);
    ctx.appendSystem(`session: ${requested || '(new)'}`);
    return;
  }
  ctx.appendError(`Unknown command: ${line}`);
}

async function createPicker(kind: PickerKind, config: AgentConfig, sessionId: string | undefined, showReasoning: boolean): Promise<PickerState> {
  if (kind === 'reasoning-display') return {
    kind,
    title: 'Reasoning display',
    index: showReasoning ? 0 : 1,
    options: [
      { label: 'on', value: 'on', description: 'show streamed thinking/reasoning deltas' },
      { label: 'off', value: 'off', description: 'hide reasoning deltas' },
    ],
  };
  if (kind === 'effort') {
    const options = supportedThinkingLevels(config).map((level) => ({ label: level, value: level, description: level === config.model.thinking.level ? 'current' : undefined }));
    return { kind, title: 'Thinking effort', options, index: selectedIndex(options, config.model.thinking.level) };
  }
  if (kind === 'model') {
    const options = unique([config.model.model, ...modelSuggestions(config)]).map((model) => ({ label: model, value: model, description: model === config.model.model ? 'current' : undefined }));
    return { kind, title: 'Model', options, index: 0 };
  }
  if (!config.session.enabled) {
    return { kind, title: 'Resume session', options: [{ label: 'Sessions are disabled', value: '__disabled__', disabled: true }], index: 0 };
  }
  const sessions = await new JsonlSessionStore(`${config.workspaceRoot}/.nju-agent`).list();
  const options: PickerOption[] = [{ label: '(new session)', value: '__new__', description: sessionId ? undefined : 'current' }, ...sessions.map((item) => ({ label: item.id, value: item.id, description: item.id === sessionId ? 'current' : new Date(item.mtimeMs).toLocaleString() }))];
  return { kind, title: 'Resume session', options, index: selectedIndex(options, sessionId ?? '__new__') };
}

function selectedIndex(options: PickerOption[], value: string): number {
  const index = options.findIndex((option) => option.value === value && !option.disabled);
  if (index >= 0) return index;
  return Math.max(0, options.findIndex((option) => !option.disabled));
}

function previousEnabledIndex(picker: PickerState): number {
  for (let index = picker.index - 1; index >= 0; index -= 1) if (!picker.options[index]?.disabled) return index;
  return picker.index;
}

function nextEnabledIndex(picker: PickerState): number {
  for (let index = picker.index + 1; index < picker.options.length; index += 1) if (!picker.options[index]?.disabled) return index;
  return picker.index;
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value);
}

function supportedThinkingLevels(config: AgentConfig): ThinkingLevel[] {
  return (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as ThinkingLevel[]).filter((level) => config.model.thinking.map?.[level] !== null);
}

function supportedEffortText(config: AgentConfig): string {
  return supportedThinkingLevels(config).join(', ');
}

function modelSuggestions(config: AgentConfig): string[] {
  if (config.model.apiFormat === 'anthropic') return ['claude-sonnet-4-5', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'];
  if (config.model.apiFormat === 'openai-responses') return ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini'];
  return ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini'];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
