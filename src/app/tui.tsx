import React, { useEffect, useRef, useState } from 'react';
import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process';
import { Box, Text, render, useApp, useInput } from 'ink';
import type { AgentStreamEvent } from '../agent/types.js';
import type { ThinkingLevel } from '../model/model-client.js';
import { clampThinkingLevel } from '../model/thinking.js';
import { createSessionNameEntry, createThinkingLevelChangeEntry } from '../session/entries.js';
import { JsonlSessionStore } from '../session/jsonl-store.js';
import type { AgentConfig } from '../shared/config.js';
import { ProjectTrustStore } from '../shared/trust.js';
import { renderHelp } from './renderer.js';
import { backspace, createEditorState, deleteForward, graphemeBoundaries, insertPaste, insertText, moveDown, moveLeft, moveRight, moveUp, parseBracketedPaste, slashCompletions, submitEditor, type EditorState } from './editor-state.js';
import type { SessionEntry } from '../session/session-types.js';
import type { AppResult, AppServices, runPrompt } from './app.js';

export type RunPrompt = typeof runPrompt;
export interface TuiOptions { config: AgentConfig; services: AppServices; runPrompt: RunPrompt; }
type TuiStatus = 'idle' | 'hydrating' | 'running' | 'cancelling' | 'error';
type PickerKind = 'resume' | 'model' | 'effort' | 'reasoning-display';
type PickerOption = { label: string; value: string; description?: string; disabled?: boolean };
type PickerState = { kind: PickerKind; title: string; options: PickerOption[]; index: number };
export type TuiMessage =
  | { role: 'user' | 'assistant' | 'thinking' | 'system' | 'error' | 'cancelled'; text: string }
  | { role: 'tool'; text: string; ok?: boolean; toolCallId?: string };

export const TUI_COMMANDS = [
  { name: '/help', description: 'show help' }, { name: '/session', description: 'show current session' },
  { name: '/new', description: 'start a new session' }, { name: '/fork', description: 'fork current session' }, { name: '/trust', description: 'trust this workspace' }, { name: '/name', description: 'name current session' }, { name: '/sessions', description: 'list sessions' },
  { name: '/resume', description: 'select a session' }, { name: '/model', description: 'select a model' },
  { name: '/effort', description: 'select reasoning effort' }, { name: '/reasoning', description: 'toggle reasoning display' },
  { name: '/thinking', description: 'alias for /reasoning' }, { name: '/compact', description: 'compaction status' },
  { name: '/quit', description: 'exit TUI' }, { name: '/exit', description: 'exit TUI' },
] as const;

export async function runTui(options: TuiOptions): Promise<AppResult> {
  const instance = render(<TuiApp {...options} />, { stdin: (options.services.stdin ?? defaultStdin) as NodeJS.ReadStream, stdout: (options.services.stdout ?? defaultStdout) as NodeJS.WriteStream, exitOnCtrlC: false, incrementalRendering: true });
  await instance.waitUntilExit();
  return { exitCode: 0 };
}

function TuiApp({ config, runPrompt }: TuiOptions) {
  const app = useApp();
  const [editor, setEditor] = useState<EditorState>(() => createEditorState());
  const [messages, setMessages] = useState<TuiMessage[]>(() => config.session.id ? [{ role: 'system', text: 'Loading session history…' }] : [{ role: 'system', text: `nju-agent ${config.model.model} · type /help for commands` }]);
  const [status, setStatus] = useState<TuiStatus>(config.session.id ? 'hydrating' : 'idle');
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [showReasoning, setShowReasoning] = useState(false);
  const [picker, setPicker] = useState<PickerState>();
  const [pasteBuffer, setPasteBuffer] = useState('');
  const [completionIndex, setCompletionIndex] = useState(0);
  const [completionDismissed, setCompletionDismissed] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string>();
  const controller = useRef<AbortController | undefined>(undefined);
  const hydrationController = useRef<AbortController | undefined>(undefined);
  const initialSessionId = useRef(config.session.id);
  const initialHydrationStarted = useRef(false);
  const append = (message: TuiMessage) => setMessages((items) => [...items, message]);
  const appendSystem = (text: string) => append({ role: 'system', text });
  const appendError = (text: string) => { setStatus('error'); append({ role: 'error', text }); };
  const completion = !picker && !completionDismissed ? slashCompletions(editor.text, TUI_COMMANDS) : [];
  const updateEditor = (transition: (state: EditorState) => EditorState) => { setCompletionDismissed(false); setCompletionIndex(0); setEditor(transition); };

  const persistEffort = async (level: ThinkingLevel, targetSessionId = sessionId) => {
    config.model.thinking = { ...config.model.thinking, level };
    if (targetSessionId && config.session.enabled) await new JsonlSessionStore(`${config.workspaceRoot}/.nju-agent`).append(targetSessionId, createThinkingLevelChangeEntry(targetSessionId, level));
  };
  const setModel = (model: string) => { config.model.model = model; config.model.thinking = { ...config.model.thinking, level: clampThinkingLevel(config.model.thinking.level, config.model.thinking.map) }; appendSystem(`model: ${model}\neffort: ${config.model.thinking.level}`); };
  const applyPicker = async (state: PickerState, option: PickerOption) => {
    if (option.disabled) return; setPicker(undefined);
    if (state.kind === 'resume') { await resumeSession(option.value === '__new__' ? undefined : option.value); return; }
    if (state.kind === 'model') { setModel(option.value); return; }
    if (state.kind === 'effort') { const level = clampThinkingLevel(option.value as ThinkingLevel, config.model.thinking.map); await persistEffort(level); appendSystem(`effort: ${level}`); return; }
    const enabled = option.value === 'on'; setShowReasoning(enabled); appendSystem(`reasoning display: ${enabled ? 'on' : 'off'}`);
  };
  const openPicker = async (kind: PickerKind) => { try { setPicker(await createPicker(kind, config, sessionId, showReasoning)); } catch (error) { appendError(asMessage(error)); } };
  const resumeSession = async (next?: string) => {
    const previous = { sessionId, messages, status, historyHasMore, historyCursor };
    hydrationController.current?.abort();
    if (!next) {
      config.session.id = undefined;
      setSessionId(undefined);
      setMessages([{ role: 'system', text: 'Started a new session.' }]);
      setHistoryHasMore(false);
      setHistoryCursor(undefined);
      setStatus('idle');
      return;
    }
    const signal = new AbortController();
    hydrationController.current = signal;
    setStatus('hydrating');
    setMessages([{ role: 'system', text: 'Loading session history…' }]);
    setHistoryHasMore(false);
    setHistoryCursor(undefined);
    try {
      const page = await new JsonlSessionStore(`${config.workspaceRoot}/.nju-agent`).readDisplayPage(next, { limit: 80 });
      if (signal.signal.aborted) {
        setSessionId(previous.sessionId);
        setMessages(previous.messages);
        setHistoryHasMore(previous.historyHasMore);
        setHistoryCursor(previous.historyCursor);
        setStatus(previous.status);
        return;
      }
      const restored = sessionEntriesToTuiMessages(page.entries, showReasoning);
      config.session.id = next;
      setSessionId(next);
      setMessages(restored.length ? restored : [{ role: 'system', text: 'This session has no displayable history.' }]);
      setHistoryHasMore(page.hasMore);
      setHistoryCursor(page.nextBeforeEntryId);
      setStatus('idle');
    } catch (error) {
      if (signal.signal.aborted) {
        setSessionId(previous.sessionId);
        setMessages(previous.messages);
        setHistoryHasMore(previous.historyHasMore);
        setHistoryCursor(previous.historyCursor);
        setStatus(previous.status);
      } else {
        setSessionId(previous.sessionId);
        setMessages([...previous.messages, { role: 'error', text: `Could not load session history: ${asMessage(error)}` }]);
        setHistoryHasMore(previous.historyHasMore);
        setHistoryCursor(previous.historyCursor);
        setStatus(previous.status === 'hydrating' ? 'idle' : previous.status);
      }
    } finally {
      if (hydrationController.current === signal) hydrationController.current = undefined;
    }
  };
  const loadEarlierHistory = async () => {
    if (!sessionId || !historyCursor || status !== 'idle') return;
    const signal = new AbortController();
    hydrationController.current = signal;
    setStatus('hydrating');
    try {
      const page = await new JsonlSessionStore(`${config.workspaceRoot}/.nju-agent`).readDisplayPage(sessionId, { beforeEntryId: historyCursor, limit: 80 });
      if (signal.signal.aborted) {
        setStatus('idle');
        return;
      }
      const older = sessionEntriesToTuiMessages(page.entries, showReasoning);
      setMessages((items) => [...older, ...items]);
      setHistoryHasMore(page.hasMore);
      setHistoryCursor(page.nextBeforeEntryId);
      setStatus('idle');
    } catch (error) {
      if (!signal.signal.aborted) {
        append({ role: 'error', text: `Could not load earlier history: ${asMessage(error)}` });
        setStatus('idle');
      }
    } finally {
      if (hydrationController.current === signal) hydrationController.current = undefined;
    }
  };
  const cancelRun = () => { if (status !== 'running') return; setStatus('cancelling'); controller.current?.abort(); };
  useEffect(() => {
    if (!initialSessionId.current || initialHydrationStarted.current) return;
    initialHydrationStarted.current = true;
    void resumeSession(initialSessionId.current);
  }, []);

  const handleSubmit = async () => {
    if (status === 'hydrating' || status === 'running' || status === 'cancelling') return;
    const submitted = submitEditor(editor); if (!submitted.prompt) return;
    setEditor(submitted.state); const raw = submitted.prompt; const line = raw.trim();
    if (line.startsWith('/')) { await handleCommand(line, { app, config, sessionId, setSessionId, showReasoning, setShowReasoning, openPicker, appendSystem, appendError, persistEffort, setModel, resumeSession }); return; }
    append({ role: 'user', text: raw }); setStatus('running'); const signal = new AbortController(); controller.current = signal;
    try {
      const result = await runPrompt(config, raw, sessionId, 'text', config.model.thinking, undefined, showReasoning, (event) => setMessages((items) => applyAgentEvent(items, event, showReasoning)), signal.signal);
      if (result.sessionId) setSessionId(result.sessionId);
      if (signal.signal.aborted) {
        append({ role: 'cancelled', text: 'Run interrupted.' });
        setStatus('idle');
      } else {
        if (result.stderr) appendError(result.stderr.trim());
        if (result.stdout?.trim()) appendSystem(result.stdout.trim());
        setStatus(result.exitCode === 0 ? 'idle' : 'error');
      }
    } catch (error) { if (signal.signal.aborted) { append({ role: 'cancelled', text: 'Run interrupted.' }); setStatus('idle'); } else appendError(asMessage(error)); }
    finally { controller.current = undefined; }
  };

  useInput((value, key) => {
    const paste = pasteBuffer ? parseBracketedPaste(`${pasteBuffer}${value}`) : parseBracketedPaste(value);
    if (pasteBuffer) { if (paste.paste === undefined) { setPasteBuffer(`${pasteBuffer}${value}`); return; } setPasteBuffer(''); updateEditor((state) => insertPaste(state, paste.paste!).state); value = paste.rest; }
    else if (value.startsWith('\u001B[200~') && paste.paste === undefined) { setPasteBuffer(value); return; }
    else if (paste.paste !== undefined) { updateEditor((state) => insertPaste(state, paste.paste!).state); value = paste.rest; }
    if (picker) {
      if (key.escape) { setPicker(undefined); return; } if (key.upArrow) { setPicker({ ...picker, index: previousEnabledIndex(picker) }); return; } if (key.downArrow) { setPicker({ ...picker, index: nextEnabledIndex(picker) }); return; }
      if (key.return) { const option = picker.options[picker.index]; if (option) void applyPicker(picker, option); return; } return;
    }
    if (status === 'hydrating') { if (key.escape) hydrationController.current?.abort(); return; }
    if (key.escape) { if (completion.length) { setCompletionDismissed(true); return; } cancelRun(); return; }
    if (key.ctrl && value === 'c') { if (editor.text) updateEditor((state) => ({ ...state, text: '', cursorOffset: 0 })); else app.exit(); return; }
    if (key.pageUp && historyHasMore) { void loadEarlierHistory(); return; }
    if (status === 'running' || status === 'cancelling') return;
    if ((key.shift && key.return) || (key.ctrl && value === 'j')) { updateEditor((state) => insertText(state, '\n')); return; }
    if (completion.length && (key.upArrow || key.downArrow)) { setCompletionIndex((index) => Math.max(0, Math.min(completion.length - 1, index + (key.upArrow ? -1 : 1)))); return; }
    if (completion.length && (key.tab || key.return)) { const selected = completion[completionIndex] ?? completion[0]; if (selected) updateEditor((state) => ({ ...state, text: selected.name, cursorOffset: selected.name.length })); return; }
    if (key.leftArrow) { updateEditor(moveLeft); return; } if (key.rightArrow) { updateEditor(moveRight); return; }
    if (key.upArrow) { updateEditor(moveUp); return; } if (key.downArrow) { updateEditor(moveDown); return; }
    if (key.backspace) { updateEditor(backspace); return; } if (key.delete) { updateEditor(deleteForward); return; }
    if (key.return) { void handleSubmit(); return; }
    if (value && !key.ctrl && !key.meta) updateEditor((state) => insertText(state, value));
  });

  return <Box flexDirection="column">
    <Box borderStyle="round" paddingX={1}><Text color="cyan">nju-agent · {config.workspaceRoot}</Text></Box>
    <Box flexDirection="column" marginTop={1}>{historyHasMore ? <Text color="gray">↑ Earlier history available · PageUp to load</Text> : null}{messages.map((message, index) => <MessageLine key={`${message.role}-${index}`} message={message} />)}</Box>
    {picker ? <PickerView picker={picker} /> : completion.length ? <CompletionView items={completion} selectedIndex={completionIndex} /> : null}
    <EditorView editor={editor} busy={status === 'hydrating' || status === 'running' || status === 'cancelling'} />
    <Box borderStyle="single" paddingX={1}><Text color={status === 'error' ? 'red' : status === 'hydrating' || status === 'running' || status === 'cancelling' ? 'yellow' : 'gray'}>api {config.model.apiFormat} · model {config.model.model} · effort {config.model.thinking.level} · session {sessionId ?? '(new)'} · permission {config.permissionMode} · reasoning {showReasoning ? 'on' : 'off'} · {status} · Ctrl+J newline · Esc cancel</Text></Box>
  </Box>;
}

function EditorView({ editor, busy }: { editor: EditorState; busy: boolean }) {
  const before = editor.text.slice(0, editor.cursorOffset); const boundary = graphemeBoundaries(editor.text).find((offset) => offset > editor.cursorOffset) ?? editor.text.length; const at = editor.text.slice(editor.cursorOffset, boundary); const after = editor.text.slice(boundary);
  return <Box marginTop={1} borderStyle="round" paddingX={1}><Text color={busy ? 'yellow' : 'green'}>{busy ? '… ' : '> '}</Text><Text>{before}</Text><Text inverse>{at || ' '}</Text><Text>{after}</Text></Box>;
}
function CompletionView({ items, selectedIndex }: { items: readonly { name: string; description: string }[]; selectedIndex: number }) { return <Box flexDirection="column" borderStyle="single" paddingX={1}><Text color="cyan">commands · ↑/↓ choose · Tab/Enter accept · Esc cancel</Text>{items.map((item, index) => <Text key={item.name} color={index === selectedIndex ? 'green' : 'gray'}>{index === selectedIndex ? '› ' : '  '}{item.name} — {item.description}</Text>)}</Box>; }
function PickerView({ picker }: { picker: PickerState }) { return <Box flexDirection="column" marginTop={1} borderStyle="single" paddingX={1}><Text color="cyan">{picker.title} (↑/↓ choose · Enter select · Esc cancel)</Text>{picker.options.map((option, index) => <Box key={`${option.value}-${index}`}><Text color={option.disabled ? 'gray' : index === picker.index ? 'green' : 'white'}>{index === picker.index ? '› ' : '  '}{option.label}</Text>{option.description ? <Text color="gray"> — {option.description}</Text> : null}</Box>)}</Box>; }
function MessageLine({ message }: { message: TuiMessage }) { const palette = { user: 'green', assistant: 'white', thinking: 'gray', tool: 'cyan', system: 'blue', error: 'red', cancelled: 'yellow' } as const; const backgrounds = { user: 'green', assistant: 'black', thinking: 'gray', tool: 'cyan', system: 'blue', error: 'red', cancelled: 'yellow' } as const; const textColor = message.role === 'user' || message.role === 'tool' || message.role === 'system' || message.role === 'error' || message.role === 'cancelled' ? 'black' : palette[message.role]; return <Box marginY={0} paddingX={1} borderStyle="single" borderColor={palette[message.role]}><MarkdownView text={message.text} color={textColor} backgroundColor={backgrounds[message.role]} /></Box>; }
function MarkdownView({ text, color, backgroundColor }: { text: string; color: 'black' | 'white' | 'gray'; backgroundColor: 'black' | 'green' | 'gray' | 'cyan' | 'blue' | 'red' | 'yellow' }) { let code = false; return <Box flexDirection="column">{sanitizeMarkdown(text).split('\n').map((line, index) => { if (line.startsWith('```')) { code = !code; return null; } const heading = /^(#{1,6})\s+(.*)$/.exec(line); const quote = /^>\s?(.*)$/.exec(line); const list = /^\s*[-*+]\s+(.*)$/.exec(line); const value = heading?.[2] ?? quote?.[1] ?? list?.[1] ?? line; return <Text key={index} color={color} backgroundColor={backgroundColor} bold={Boolean(heading)} dimColor={Boolean(quote) || code}>{list ? '• ' : quote ? '│ ' : ''}{inlineMarkdown(value)}</Text>; })}</Box>; }
function sanitizeMarkdown(text: string): string { return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/<[^>]*>/g, ''); }
function inlineMarkdown(text: string): React.ReactNode[] { const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]*\))/g); return parts.filter(Boolean).map((part, index) => { if (part.startsWith('**')) return <Text key={index} bold>{part.slice(2, -2)}</Text>; if (part.startsWith('`')) return <Text key={index} inverse>{part.slice(1, -1)}</Text>; const link = /^\[([^\]]+)\]\([^)]*\)$/.exec(part); return <Text key={index} underline={Boolean(link)}>{link?.[1] ?? part}</Text>; }); }

export function sessionEntriesToTuiMessages(entries: SessionEntry[], showReasoning = false): TuiMessage[] {
  const messages: TuiMessage[] = [];
  const toolNames = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type === 'message') {
      const message = entry.message;
      if (message.role === 'user') messages.push({ role: 'user', text: message.content });
      else if (message.role === 'assistant') {
        if (message.content) messages.push({ role: 'assistant', text: message.content });
        for (const call of message.toolCalls ?? []) { toolNames.set(call.id, call.name); messages.push({ role: 'tool', text: `${call.name} · completed`, ok: true, toolCallId: call.id }); }
      } else if (message.role === 'tool') {
        const name = toolNames.get(message.toolCallId ?? '') ?? 'tool';
        const failed = /failed|error|denied/i.test(message.content);
        const index = messages.findIndex((item) => item.role === 'tool' && item.toolCallId === message.toolCallId);
        const card: TuiMessage = { role: 'tool', text: `${name} · ${failed ? 'failed' : 'completed'}`, ok: !failed, toolCallId: message.toolCallId };
        if (index >= 0) messages[index] = card; else messages.push(card);
      }
    } else if (entry.type === 'run_end' && entry.stopReason === 'user_cancelled') messages.push({ role: 'cancelled', text: 'Run interrupted.' });
    else if (entry.type === 'thinking_level_change' && showReasoning) messages.push({ role: 'system', text: `effort: ${entry.thinkingLevel}` });
  }
  return messages;
}

export function applyAgentEvent(messages: TuiMessage[], event: AgentStreamEvent, showReasoning: boolean): TuiMessage[] {
  if (event.type === 'text_delta') return appendToLast(messages, 'assistant', event.delta);
  if (event.type === 'thinking_delta') return showReasoning && event.delta ? appendToLast(messages, 'thinking', event.delta) : messages;
  if (event.type === 'tool_call') return [...messages, { role: 'tool', text: `${event.toolCall.name} · running`, toolCallId: event.toolCall.id }];
  if (event.type === 'tool_result') { const status = event.result.ok ? 'completed' : `failed:${event.result.error?.code ?? 'error'}`; let index = -1; for (let i = messages.length - 1; i >= 0; i -= 1) { const item = messages[i]; if (item?.role === 'tool' && item.toolCallId === event.result.toolCallId) { index = i; break; } } if (index >= 0) return [...messages.slice(0, index), { role: 'tool', text: `${event.result.toolName} · ${status}`, ok: event.result.ok, toolCallId: event.result.toolCallId }, ...messages.slice(index + 1)]; return [...messages, { role: 'tool', text: `${event.result.toolName} · ${status}`, ok: event.result.ok, toolCallId: event.result.toolCallId }]; }
  return messages;
}
function appendToLast(messages: TuiMessage[], role: 'assistant' | 'thinking', delta: string): TuiMessage[] { const last = messages.at(-1); return last?.role === role ? [...messages.slice(0, -1), { role, text: `${last.text}${delta}` }] : [...messages, { role, text: delta }]; }
interface CommandContext { app: ReturnType<typeof useApp>; config: AgentConfig; sessionId?: string; setSessionId: (value: string | undefined) => void; showReasoning: boolean; setShowReasoning: (value: boolean) => void; openPicker: (kind: PickerKind) => Promise<void>; appendSystem: (text: string) => void; appendError: (text: string) => void; persistEffort: (level: ThinkingLevel, targetSessionId?: string) => Promise<void>; setModel: (model: string) => void; resumeSession: (sessionId?: string) => Promise<void>; }
async function handleCommand(line: string, ctx: CommandContext): Promise<void> {
  if (line === '/quit' || line === '/exit') { ctx.app.exit(); return; } if (line === '/help') { ctx.appendSystem(renderHelp().trim()); return; } if (line === '/new') { ctx.setSessionId(undefined); ctx.appendSystem('Started a new session.'); return; }
  if (line === '/trust') { new ProjectTrustStore().trust(ctx.config.workspaceRoot); ctx.config.projectTrusted = true; ctx.appendSystem('Workspace trusted for future runs.'); return; }
  if (line === '/fork') { if (!ctx.sessionId) { ctx.appendError('Start a session before forking it.'); return; } try { const child = await new JsonlSessionStore(`${ctx.config.workspaceRoot}/.nju-agent`).fork(ctx.sessionId); await ctx.resumeSession(child.id); } catch (error) { ctx.appendError(`Could not fork session: ${asMessage(error)}`); } return; }
  if (line === '/session') { const named = ctx.sessionId && ctx.config.session.enabled ? (await new JsonlSessionStore(`${ctx.config.workspaceRoot}/.nju-agent`).list()).find((item) => item.id === ctx.sessionId)?.name : undefined; ctx.appendSystem(`session: ${ctx.sessionId ?? '(new)'}${named ? `\nname: ${named}` : ''}\nmodel: ${ctx.config.model.model}\neffort: ${ctx.config.model.thinking.level}\nreasoning display: ${ctx.showReasoning ? 'on' : 'off'}\npermission: ${ctx.config.permissionMode}`); return; }
  if (line === '/name' || line.startsWith('/name ')) { const name = line.slice(5).trim(); if (!ctx.sessionId) { ctx.appendError('Start a session before naming it.'); return; } if (!name) { ctx.appendError('Usage: /name <name>'); return; } await new JsonlSessionStore(`${ctx.config.workspaceRoot}/.nju-agent`).append(ctx.sessionId, createSessionNameEntry(ctx.sessionId, name.slice(0, 120))); ctx.appendSystem(`session name: ${name.slice(0, 120)}`); return; }
  if (line === '/reasoning' || line === '/thinking') { await ctx.openPicker('reasoning-display'); return; } if (/^\/(reasoning|thinking) /.test(line)) { const requested = line.replace(/^\/(reasoning|thinking)\s+/, ''); if (requested !== 'on' && requested !== 'off') { ctx.appendError('Usage: /reasoning [on|off]'); return; } ctx.setShowReasoning(requested === 'on'); ctx.appendSystem(`reasoning display: ${requested}`); return; }
  if (line === '/effort') { await ctx.openPicker('effort'); return; } if (line.startsWith('/effort ')) { const requested = line.slice(8).trim(); if (!isThinkingLevel(requested)) { ctx.appendError(`Invalid effort: ${requested}. Expected: ${supportedEffortText(ctx.config)}`); return; } const level = clampThinkingLevel(requested, ctx.config.model.thinking.map); await ctx.persistEffort(level); ctx.appendSystem(`effort: ${level}`); return; }
  if (line === '/model') { await ctx.openPicker('model'); return; } if (line.startsWith('/model ')) { ctx.setModel(line.slice(7).trim()); return; }
  if (line === '/compact') { ctx.appendSystem('Context compaction is not implemented.'); return; }
  if (line === '/sessions') { if (!ctx.config.session.enabled) { ctx.appendSystem('Sessions are disabled.'); return; } const sessions = await new JsonlSessionStore(`${ctx.config.workspaceRoot}/.nju-agent`).list(); ctx.appendSystem(sessions.length ? sessions.map((item) => `${item.name ? `${item.name} · ` : ''}${item.id}`).join('\n') : 'No sessions.'); return; }
  if (line === '/resume') { await ctx.openPicker('resume'); return; } if (line.startsWith('/resume ')) { await ctx.resumeSession(line.slice(8).trim() || undefined); return; } ctx.appendError(`Unknown command: ${line}`);
}
async function createPicker(kind: PickerKind, config: AgentConfig, sessionId: string | undefined, showReasoning: boolean): Promise<PickerState> { if (kind === 'reasoning-display') return { kind, title: 'Reasoning display', index: showReasoning ? 0 : 1, options: [{ label: 'on', value: 'on' }, { label: 'off', value: 'off' }] }; if (kind === 'effort') { const options = supportedThinkingLevels(config).map((level) => ({ label: level, value: level, description: level === config.model.thinking.level ? 'current' : undefined })); return { kind, title: 'Thinking effort', options, index: selectedIndex(options, config.model.thinking.level) }; } if (kind === 'model') { const options = unique([config.model.model, ...modelSuggestions(config)]).map((model) => ({ label: model, value: model, description: model === config.model.model ? 'current' : undefined })); return { kind, title: 'Model', options, index: 0 }; } if (!config.session.enabled) return { kind, title: 'Resume session', options: [{ label: 'Sessions are disabled', value: '__disabled__', disabled: true }], index: 0 }; const sessions = await new JsonlSessionStore(`${config.workspaceRoot}/.nju-agent`).list(); const options: PickerOption[] = [{ label: '(new session)', value: '__new__', description: sessionId ? undefined : 'current' }, ...sessions.map((item) => ({ label: item.name ?? item.id, value: item.id, description: item.id === sessionId ? 'current' : `${item.id.slice(0, 8)} · ${new Date(item.mtimeMs).toLocaleString()}` }))]; return { kind, title: 'Resume session', options, index: selectedIndex(options, sessionId ?? '__new__') }; }
function selectedIndex(options: PickerOption[], value: string): number { return Math.max(0, options.findIndex((item) => item.value === value && !item.disabled)); }
function previousEnabledIndex(picker: PickerState): number { for (let i = picker.index - 1; i >= 0; i--) if (!picker.options[i]?.disabled) return i; return picker.index; }
function nextEnabledIndex(picker: PickerState): number { for (let i = picker.index + 1; i < picker.options.length; i++) if (!picker.options[i]?.disabled) return i; return picker.index; }
function isThinkingLevel(value: string): value is ThinkingLevel { return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value); }
function supportedThinkingLevels(config: AgentConfig): ThinkingLevel[] { return (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as ThinkingLevel[]).filter((level) => config.model.thinking.map?.[level] !== null); }
function supportedEffortText(config: AgentConfig): string { return supportedThinkingLevels(config).join(', '); }
function modelSuggestions(config: AgentConfig): string[] { return config.model.apiFormat === 'anthropic' ? ['claude-sonnet-4-5', 'claude-3-5-sonnet-latest'] : ['gpt-5', 'gpt-5-mini', 'gpt-4.1']; }
function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }
function asMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
