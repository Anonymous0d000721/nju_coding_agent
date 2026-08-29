import React, { useEffect, useRef, useState } from 'react';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process';
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink';
import type { AgentRunControl, AgentStreamEvent } from '../agent/types.js';
import type { ThinkingLevel } from '../model/model-client.js';
import { clampThinkingLevel } from '../model/thinking.js';
import { createSessionNameEntry, createThinkingLevelChangeEntry } from '../session/entries.js';
import { JsonlSessionStore } from '../session/jsonl-store.js';
import type { AgentConfig } from '../shared/config.js';
import { redact } from '../shared/redact.js';
import type { ToolDefinition } from '../tools/types.js';
import { ProjectTrustStore } from '../shared/trust.js';
import { renderHelp, renderVersion } from './renderer.js';
import { backspace, createEditorState, deleteForward, graphemeBoundaries, insertPaste, insertText, moveDown, moveLeft, moveRight, moveUp, parseBracketedPaste, slashCompletions, submitEditor, type EditorState } from './editor-state.js';
import type { SessionEntry } from '../session/session-types.js';
import type { AppResult, AppServices, compactSession, memoryStatus, runPrompt } from './app.js';
import { loadUserPlugins } from '../plugins/loader.js';

export type RunPrompt = typeof runPrompt;
export interface TuiOptions { config: AgentConfig; services: AppServices; runPrompt: RunPrompt; compactSession: typeof compactSession; memoryStatus: typeof memoryStatus; }
type TuiStatus = 'idle' | 'hydrating' | 'running' | 'cancelling' | 'error';
type PickerKind = 'resume' | 'model' | 'effort' | 'reasoning-display';
type PickerOption = { label: string; value: string; description?: string; disabled?: boolean };
type PickerState = { kind: PickerKind; title: string; options: PickerOption[]; index: number };
type CompletionItem = { name: string; description: string; kind: 'command' | 'file' };
export type TuiMessage =
  | { role: 'user' | 'assistant' | 'thinking' | 'system' | 'error' | 'cancelled'; text: string }
  | { role: 'tool'; text: string; preview?: string; detail?: string; expanded?: boolean; ok?: boolean; toolCallId?: string };

export const TUI_COMMANDS = [
  { name: '/help', description: 'show help' }, { name: '/session', description: 'show current session' },
  { name: '/new', description: 'start a new session' }, { name: '/fork', description: 'fork current session' }, { name: '/trust', description: 'trust this workspace' }, { name: '/name', description: 'name current session' }, { name: '/sessions', description: 'list sessions' },
  { name: '/resume', description: 'select a session' }, { name: '/rename', description: 'rename current session' }, { name: '/model', description: 'select a model' },
  { name: '/effort', description: 'select reasoning effort' }, { name: '/reasoning', description: 'toggle reasoning display' },
  { name: '/thinking', description: 'alias for /reasoning' }, { name: '/memory', description: 'show local memory status' }, { name: '/reload', description: 'reload user and MCP tools' }, { name: '/compact', description: 'compact current session' },
  { name: '/quit', description: 'exit TUI' }, { name: '/exit', description: 'exit TUI' },
] as const;

export async function runTui(options: TuiOptions): Promise<AppResult> {
  const instance = render(<TuiApp {...options} />, { stdin: (options.services.stdin ?? defaultStdin) as NodeJS.ReadStream, stdout: (options.services.stdout ?? defaultStdout) as NodeJS.WriteStream, exitOnCtrlC: false, incrementalRendering: true });
  await instance.waitUntilExit();
  return { exitCode: 0 };
}

function TuiApp({ config, runPrompt, compactSession, memoryStatus }: TuiOptions) {
  const app = useApp();
  const [editor, setEditor] = useState<EditorState>(() => createEditorState());
  const [messages, setMessages] = useState<TuiMessage[]>(() => config.session.id ? [{ role: 'system', text: 'Loading session history…' }] : [{ role: 'system', text: `nju-agent ${config.model.model} · type /help for commands` }]);
  const [status, setStatus] = useState<TuiStatus>(config.session.id ? 'hydrating' : 'idle');
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [sessionLabel, setSessionLabel] = useState<string | undefined>(undefined);
  const [approval, setApproval] = useState<ToolDefinition>();
  const [showReasoning, setShowReasoning] = useState(true);
  const reloadPlugins = useRef(false);
  const markPluginsForReload = () => { reloadPlugins.current = true; };
  const [picker, setPicker] = useState<PickerState>();
  const [pasteBuffer, setPasteBuffer] = useState('');
  const [completionIndex, setCompletionIndex] = useState(0);
  const [completionDismissed, setCompletionDismissed] = useState(false);
  const [fileCompletions, setFileCompletions] = useState<CompletionItem[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string>();
  const [transcriptOffset, setTranscriptOffset] = useState(0);
  const { rows: terminalRows } = useWindowSize();
  const controller = useRef<AbortController | undefined>(undefined);
  const hydrationController = useRef<AbortController | undefined>(undefined);
  const approvalResolver = useRef<((allowed: boolean) => void) | undefined>(undefined);
  const queuedMessages = useRef<string[]>([]);
  const steeredMessages = useRef<string[]>([]);
  const runControl = useRef<AgentRunControl>({
    queue: (message) => { queuedMessages.current.push(message); },
    steer: (message) => { steeredMessages.current.push(message); },
    drainQueue: () => queuedMessages.current.splice(0),
    drainSteers: () => steeredMessages.current.splice(0),
  });
  const initialSessionId = useRef(config.session.id);
  const initialHydrationStarted = useRef(false);
  const append = (message: TuiMessage) => setMessages((items) => [...items, message]);
  const appendSystem = (text: string) => append({ role: 'system', text });
  const appendError = (text: string) => { setStatus('error'); append({ role: 'error', text }); };
  const commandCompletions: CompletionItem[] = slashCompletions(editor.text, TUI_COMMANDS).map((item) => ({ ...item, kind: 'command' }));
  const completion = !picker && !completionDismissed ? (editor.text.startsWith('/') ? commandCompletions : fileCompletions) : [];
  const updateEditor = (transition: (state: EditorState) => EditorState) => { setCompletionDismissed(false); setCompletionIndex(0); setEditor(transition); };
  useEffect(() => {
    let active = true;
    if (picker || completionDismissed || editor.text.startsWith('/')) { setFileCompletions([]); return () => { active = false; }; }
    const token = fileReferenceToken(editor.text);
    if (!token) { setFileCompletions([]); return () => { active = false; }; }
    void findFileCompletions(config.workspaceRoot, token.query).then((items) => { if (active) setFileCompletions(items); }).catch(() => { if (active) setFileCompletions([]); });
    return () => { active = false; };
  }, [config.workspaceRoot, editor.text, picker, completionDismissed]);

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
    const previous = { sessionId, sessionLabel, messages, status, historyHasMore, historyCursor, transcriptOffset };
    hydrationController.current?.abort();
    if (!next) {
      config.session.id = undefined;
      setSessionId(undefined);
      setSessionLabel(undefined);
      setMessages([{ role: 'system', text: 'Started a new session.' }]);
      setHistoryHasMore(false);
      setHistoryCursor(undefined);
      setTranscriptOffset(0);
      setStatus('idle');
      return;
    }
    const signal = new AbortController();
    hydrationController.current = signal;
    setStatus('hydrating');
    setMessages([{ role: 'system', text: 'Loading session history…' }]);
    setHistoryHasMore(false);
    setHistoryCursor(undefined);
    setTranscriptOffset(0);
    try {
      const page = await new JsonlSessionStore(`${config.workspaceRoot}/.nju-agent`).readDisplayPage(next, { limit: 80 });
      if (signal.signal.aborted) {
        setSessionId(previous.sessionId);
        setSessionLabel(previous.sessionLabel);
        setMessages(previous.messages);
        setHistoryHasMore(previous.historyHasMore);
        setHistoryCursor(previous.historyCursor);
        setTranscriptOffset(previous.transcriptOffset);
        setStatus(previous.status);
        return;
      }
      const restored = sessionEntriesToTuiMessages(page.entries, showReasoning);
      config.session.id = next;
      setSessionId(next);
      setSessionLabel(page.name);
      setMessages(restored.length ? restored : [{ role: 'system', text: 'This session has no displayable history.' }]);
      setHistoryHasMore(page.hasMore);
      setHistoryCursor(page.nextBeforeEntryId);
      setTranscriptOffset(0);
      setStatus('idle');
    } catch (error) {
      if (signal.signal.aborted) {
        setSessionId(previous.sessionId);
        setSessionLabel(previous.sessionLabel);
        setMessages(previous.messages);
        setHistoryHasMore(previous.historyHasMore);
        setHistoryCursor(previous.historyCursor);
        setTranscriptOffset(previous.transcriptOffset);
        setStatus(previous.status);
      } else {
        setSessionId(previous.sessionId);
        setSessionLabel(previous.sessionLabel);
        setMessages([...previous.messages, { role: 'error', text: `Could not load session history: ${asMessage(error)}` }]);
        setHistoryHasMore(previous.historyHasMore);
        setHistoryCursor(previous.historyCursor);
        setTranscriptOffset(previous.transcriptOffset);
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
      setTranscriptOffset((offset) => offset + older.length);
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
  const submitWhileRunning = (kind: 'queue' | 'steer') => {
    const submitted = submitEditor(editor);
    if (!submitted.prompt) return;
    setEditor(submitted.state);
    if (kind === 'queue') {
      runControl.current.queue(submitted.prompt);
      appendSystem(`Queued message: ${submitted.prompt}`);
    } else {
      runControl.current.steer(submitted.prompt);
      appendSystem(`Steering message: ${submitted.prompt}`);
    }
  };
  const requestApproval = (tool: ToolDefinition) => new Promise<boolean>((resolve) => { approvalResolver.current = resolve; setApproval(tool); });
  const resolveApproval = (allowed: boolean) => { approvalResolver.current?.(allowed); approvalResolver.current = undefined; setApproval(undefined); };
  useEffect(() => {
    if (!initialSessionId.current || initialHydrationStarted.current) return;
    initialHydrationStarted.current = true;
    void resumeSession(initialSessionId.current);
  }, []);

  const handleSubmit = async () => {
    if (status === 'hydrating' || status === 'running' || status === 'cancelling') return;
    const submitted = submitEditor(editor); if (!submitted.prompt) return;
    setEditor(submitted.state); setTranscriptOffset(0); const raw = submitted.prompt; const line = raw.trim();
    if (line.startsWith('/')) { await handleCommand(line, { app, config, sessionId, setSessionId, setSessionLabel, showReasoning, setShowReasoning, openPicker, appendSystem, appendError, persistEffort, setModel, resumeSession, compactSession, memoryStatus, markPluginsForReload }); return; }
    append({ role: 'user', text: raw }); setStatus('running'); const signal = new AbortController(); controller.current = signal;
    try {
      const result = await runPrompt(config, raw, sessionId, 'text', config.model.thinking, undefined, showReasoning, (event) => setMessages((items) => applyAgentEvent(items, event, showReasoning)), signal.signal, requestApproval, reloadPlugins.current, runControl.current);
      reloadPlugins.current = false;
      if (result.sessionId) {
        setSessionId(result.sessionId);
        const current = (await new JsonlSessionStore(`${config.workspaceRoot}/.nju-agent`).list()).find((item) => item.id === result.sessionId);
        setSessionLabel(current?.name);
      }
      if (signal.signal.aborted) {
        append({ role: 'cancelled', text: 'Run interrupted.' });
        setStatus('idle');
      } else {
        if (result.stderr) appendError(result.stderr.trim());
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
    if (approval) {
      if (key.return || value.toLowerCase() === 'y') { resolveApproval(true); return; }
      if (key.escape || value.toLowerCase() === 'n') { resolveApproval(false); return; }
      return;
    }
    if (picker) {
      if (key.escape) { setPicker(undefined); return; } if (key.upArrow) { setPicker({ ...picker, index: previousEnabledIndex(picker) }); return; } if (key.downArrow) { setPicker({ ...picker, index: nextEnabledIndex(picker) }); return; }
      if (key.return) { const option = picker.options[picker.index]; if (option) void applyPicker(picker, option); return; } return;
    }
    if (status === 'hydrating') { if (key.escape) hydrationController.current?.abort(); return; }
    if (key.escape) { if (completion.length) { setCompletionDismissed(true); return; } cancelRun(); return; }
    if (key.ctrl && value === 'o') { setMessages((items) => toggleLastToolDetails(items)); return; }
    if (key.ctrl && value === 'c') { if (status === 'running' || status === 'cancelling') { cancelRun(); return; } if (editor.text) updateEditor((state) => ({ ...state, text: '', cursorOffset: 0 })); else app.exit(); return; }
    if (key.pageUp) {
      const pageSize = transcriptPageSize(terminalRows);
      if (transcriptOffset < Math.max(0, messages.length - pageSize)) {
        setTranscriptOffset((offset) => Math.min(Math.max(0, messages.length - pageSize), offset + pageSize));
      } else if (historyHasMore) void loadEarlierHistory();
      return;
    }
    if (key.pageDown) { setTranscriptOffset((offset) => Math.max(0, offset - transcriptPageSize(terminalRows))); return; }
    if (status === 'running') { if (key.ctrl && key.return) submitWhileRunning('steer'); else if (key.return) submitWhileRunning('queue'); return; }
    if (status === 'cancelling') return;
    if ((key.shift && key.return) || (key.ctrl && value === 'j')) { updateEditor((state) => insertText(state, '\n')); return; }
    if (completion.length && (key.upArrow || key.downArrow)) { setCompletionIndex((index) => Math.max(0, Math.min(completion.length - 1, index + (key.upArrow ? -1 : 1)))); return; }
    if (completion.length && (key.tab || key.return)) {
      const selected = completion[completionIndex] ?? completion[0];
      if (selected) {
        if (key.return && selected.kind === 'command') {
          updateEditor((state) => createEditorState(state.history));
          void handleCommand(selected.name, { app, config, sessionId, setSessionId, setSessionLabel, showReasoning, setShowReasoning, openPicker, appendSystem, appendError, persistEffort, setModel, resumeSession, compactSession, memoryStatus, markPluginsForReload });
        } else {
          updateEditor((state) => replaceFileReference(state, selected.name));
        }
      }
      return;
    }
    if (key.leftArrow) { updateEditor(moveLeft); return; } if (key.rightArrow) { updateEditor(moveRight); return; }
    if (key.upArrow) { updateEditor(moveUp); return; } if (key.downArrow) { updateEditor(moveDown); return; }
    if (key.backspace) { updateEditor(backspace); return; } if (key.delete) { updateEditor(deleteForward); return; }
    if (key.return) { void handleSubmit(); return; }
    if (value && !key.ctrl && !key.meta) updateEditor((state) => insertText(state, value));
  });

  const busy = status === 'hydrating' || status === 'running' || status === 'cancelling';
  const statusColor = status === 'error' ? 'red' : busy ? 'yellow' : 'gray';
  const statusText = formatStatusBar({ status, model: config.model.model, effort: config.model.thinking.level, sessionLabel, permissionMode: config.permissionMode, showReasoning });

  return <Box flexDirection="column">
    <Text color="gray" dimColor>nju-agent · {config.workspaceRoot}</Text>
    <TranscriptView messages={messages} terminalRows={terminalRows} offset={transcriptOffset} historyHasMore={historyHasMore} />
    <EditorView editor={editor} busy={busy} />
    {approval ? <ApprovalView tool={approval} /> : picker ? <PickerView picker={picker} /> : completion.length ? <CompletionView items={completion} selectedIndex={completionIndex} /> : null}
    <Text color={statusColor} wrap="truncate">{statusText}</Text>
  </Box>;
}

const TRANSCRIPT_PAGE_LINES = 12;
export function transcriptPageSize(terminalRows: number): number { return Math.max(TRANSCRIPT_PAGE_LINES, Math.floor(terminalRows * 0.6)); }
export function transcriptWindow<T>(items: T[], pageSize: number, offset: number): { start: number; end: number; items: T[] } {
  const end = Math.max(0, items.length - Math.max(0, offset));
  const start = Math.max(0, end - Math.max(1, pageSize));
  return { start, end, items: items.slice(start, end) };
}
function TranscriptView({ messages, terminalRows, offset, historyHasMore }: { messages: TuiMessage[]; terminalRows: number; offset: number; historyHasMore: boolean }) {
  const pageSize = transcriptPageSize(terminalRows);
  const window = transcriptWindow(messages, pageSize, offset);
  const { start, end, items: visible } = window;
  return <Box flexDirection="column" flexGrow={1} marginBottom={1}>
    {start > 0 || historyHasMore ? <Text color="gray">↑ Earlier history · PageUp</Text> : null}
    {offset > 0 ? <Text color="gray">↓ Newer messages · PageDown</Text> : null}
    {visible.map((message, index) => <MessageLine key={`${start + index}-${message.role}`} message={message} />)}
  </Box>;
}

function EditorView({ editor, busy }: { editor: EditorState; busy: boolean }) {
  const lines = editorLinesWithCursor(editor);
  return <Box borderStyle="round" flexDirection="column">{lines.map((line, index) => <Text key={index}><Text color={index === 0 ? (busy ? 'yellow' : 'green') : 'gray'}>{index === 0 ? (busy ? '… ' : '> ') : '  '}</Text>{line.before}<Text underline bold color={busy ? 'yellow' : 'white'}>{line.at || '▌'}</Text>{line.after}</Text>)}</Box>;
}

export function formatStatusBar(input: { status: TuiStatus; model: string; effort: ThinkingLevel; sessionLabel?: string; permissionMode: AgentConfig['permissionMode']; showReasoning: boolean }): string {
  const state = input.status === 'running' ? 'run' : input.status === 'cancelling' ? 'cancel' : input.status === 'hydrating' ? 'load' : input.status;
  const session = input.sessionLabel?.trim() || 'new';
  return `${state} · ${input.model} · ${input.effort} · ${session} · ${input.permissionMode} · R:${input.showReasoning ? 'on' : 'off'} · ^J newline · Esc cancel`;
}

export function editorLinesWithCursor(editor: EditorState): Array<{ before: string; at: string; after: string }> {
  const lines = editor.text.split('\\n');
  let offset = 0;
  return lines.map((line) => {
    const start = offset;
    const end = start + line.length;
    offset = end + 1;
    if (editor.cursorOffset < start || editor.cursorOffset > end) return { before: line, at: '', after: '' };
    const local = editor.cursorOffset - start;
    const boundary = graphemeBoundaries(line).find((value) => value > local) ?? line.length;
    return { before: line.slice(0, local), at: line.slice(local, boundary), after: line.slice(boundary) };
  });
}
function CompletionView({ items, selectedIndex }: { items: readonly CompletionItem[]; selectedIndex: number }) {
  const files = items.some((item) => item.kind === 'file');
  return <Box flexDirection="column"><Text color="cyan">{files ? 'files' : 'commands'} · ↑/↓ choose · Tab/Enter accept · Esc cancel</Text>{items.map((item, index) => <Box key={`${item.kind}-${item.name}`} width="100%" backgroundColor={index === selectedIndex ? 'gray' : undefined}><Text color={index === selectedIndex ? 'white' : 'gray'}>{index === selectedIndex ? '› ' : '  '}{item.name} — {item.description}</Text></Box>)}</Box>;
}
function ApprovalView({ tool }: { tool: ToolDefinition }) {
  return <Box flexDirection="column"><Text color="yellow">Allow {tool.name} · {tool.risk}</Text><Text color="gray">{tool.description}</Text><Text color="gray">Enter/y allow · n/Esc deny</Text></Box>;
}
function PickerView({ picker }: { picker: PickerState }) {
  return <Box flexDirection="column"><Text color="cyan">{picker.title} (↑/↓ choose · Enter select · Esc cancel)</Text>{picker.options.map((option, index) => <Box key={`${option.value}-${index}`} width="100%" backgroundColor={!option.disabled && index === picker.index ? 'gray' : undefined}><Text color={option.disabled ? 'gray' : index === picker.index ? 'white' : 'white'}>{index === picker.index ? '› ' : '  '}{option.label}</Text>{option.description ? <Text color="gray"> — {option.description}</Text> : null}</Box>)}</Box>;
}
type MessagePresentation = { color: 'green' | 'white' | 'gray' | 'cyan' | 'blue' | 'red' | 'yellow'; marker: string; dim?: boolean };
export function messagePresentation(message: TuiMessage): MessagePresentation {
  if (message.role === 'user') return { color: 'green', marker: '› ', dim: false };
  if (message.role === 'thinking') return { color: 'gray', marker: '· ', dim: true };
  if (message.role === 'tool') return { color: message.ok === false ? 'red' : 'cyan', marker: '• ' };
  if (message.role === 'system') return { color: 'blue', marker: '· ', dim: true };
  if (message.role === 'error') return { color: 'red', marker: '! ' };
  if (message.role === 'cancelled') return { color: 'yellow', marker: '· ' };
  return { color: 'white', marker: '' };
}
function MessageLine({ message }: { message: TuiMessage }) {
  const presentation = messagePresentation(message);
  const text = message.role === 'tool' && message.expanded && message.detail ? `${message.text}\n${message.detail}` : message.text;
  return <Box marginBottom={1}><Text color={presentation.color} dimColor={presentation.dim}>{presentation.marker}</Text><MarkdownView text={text} color={presentation.color} dim={presentation.dim} /></Box>;
}
function MarkdownView({ text, color, dim = false }: { text: string; color: MessagePresentation['color']; dim?: boolean }) {
  let code = false;
  const lines = sanitizeMarkdown(text).split('\n');
  const children: React.ReactNode[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('```')) { code = !code; continue; }
    const next = lines[index + 1];
    if (isMarkdownTableRow(line) && next !== undefined && isMarkdownTableSeparator(next)) {
      const header = parseMarkdownTableRow(line);
      const separator = parseMarkdownTableRow(next);
      const rows: string[][] = [header];
      index += 1;
      while (index + 1 < lines.length && isMarkdownTableRow(lines[index + 1]!)) {
        index += 1;
        rows.push(parseMarkdownTableRow(lines[index]!));
      }
      children.push(<TableView key={index} rows={rows} separator={separator} color={color} dim={dim || code} />);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line); const quote = /^>\s?(.*)$/.exec(line); const list = /^\s*[-*+]\s+(.*)$/.exec(line);
    const value = heading?.[2] ?? quote?.[1] ?? list?.[1] ?? line;
    children.push(<Text key={index} color={color} bold={Boolean(heading)} dimColor={dim || Boolean(quote) || code}>{list ? '• ' : quote ? '│ ' : ''}{inlineMarkdown(value)}</Text>);
  }
  return <Box flexDirection="column">{children}</Box>;
}

export function isMarkdownTableRow(line: string): boolean { return /^\s*\|.*\|\s*$/.test(line); }
export function isMarkdownTableSeparator(line: string): boolean { return isMarkdownTableRow(line) && parseMarkdownTableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell.trim())); }
export function parseMarkdownTableRow(line: string): string[] { return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()); }
function TableView({ rows, separator, color, dim }: { rows: string[][]; separator: string[]; color: MessagePresentation['color']; dim: boolean }) {
  return <Box flexDirection="column" marginBottom={1}>{rows.map((row, rowIndex) => <Box key={rowIndex}><Text color={color} dimColor={dim}>{row.map((cell, cellIndex) => `${cellIndex ? ' │ ' : '│ '}${cell}${cellIndex === row.length - 1 ? ' │' : ''}`).join('')}</Text></Box>)}</Box>;
}
function sanitizeMarkdown(text: string): string { return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/<[^>]*>/g, ''); }
function inlineMarkdown(text: string): React.ReactNode[] { const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]*\))/g); return parts.filter(Boolean).map((part, index) => { if (part.startsWith('**')) return <Text key={index} bold>{part.slice(2, -2)}</Text>; if (part.startsWith('`')) return <Text key={index} bold>{part.slice(1, -1)}</Text>; const link = /^\[([^\]]+)\]\([^)]*\)$/.exec(part); return <Text key={index} underline={Boolean(link)}>{link?.[1] ?? part}</Text>; }); }

export function sessionEntriesToTuiMessages(entries: SessionEntry[], showReasoning = false): TuiMessage[] {
  const messages: TuiMessage[] = [];
  const toolNames = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type === 'message') {
      const message = entry.message;
      if (message.role === 'user') messages.push({ role: 'user', text: message.content });
      else if (message.role === 'assistant') {
        if (message.content) messages.push({ role: 'assistant', text: message.content });
        for (const call of message.toolCalls ?? []) { toolNames.set(call.id, call.name); messages.push({ role: 'tool', text: call.preview ?? `${call.name} · completed`, ok: true, toolCallId: call.id }); }
      } else if (message.role === 'tool') {
        const name = toolNames.get(message.toolCallId ?? '') ?? 'tool';
        const failed = /failed|error|denied/i.test(message.content);
        const index = messages.findIndex((item) => item.role === 'tool' && item.toolCallId === message.toolCallId);
        const card: TuiMessage = { role: 'tool', text: message.preview ?? `${name} · ${failed ? 'failed' : 'completed'}`, detail: message.content, expanded: false, ok: !failed, toolCallId: message.toolCallId };
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
  if (event.type === 'tool_call') return [...messages, { role: 'tool', text: event.preview ?? event.toolCall.preview ?? `${event.toolCall.name} · running`, toolCallId: event.toolCall.id }];
  if (event.type === 'tool_result') { const status = event.result.ok ? 'completed' : `failed:${event.result.error?.code ?? 'error'}`; const text = event.result.preview ?? `${event.result.toolName} · ${status}`; let index = -1; for (let i = messages.length - 1; i >= 0; i -= 1) { const item = messages[i]; if (item?.role === 'tool' && item.toolCallId === event.result.toolCallId) { index = i; break; } } const replacement = { role: 'tool' as const, text, detail: toolDetail(event.result.content), expanded: false, ok: event.result.ok, toolCallId: event.result.toolCallId }; if (index >= 0) return [...messages.slice(0, index), replacement, ...messages.slice(index + 1)]; return [...messages, replacement]; }
  return messages;
}

export function toggleLastToolDetails(messages: TuiMessage[]): TuiMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'tool' && message.detail) return [...messages.slice(0, index), { ...message, expanded: !message.expanded }, ...messages.slice(index + 1)];
  }
  return messages;
}

function appendToLast(messages: TuiMessage[], role: 'assistant' | 'thinking', delta: string): TuiMessage[] { const last = messages.at(-1); return last?.role === role ? [...messages.slice(0, -1), { role, text: `${last.text}${delta}` }] : [...messages, { role, text: delta }]; }
function toolDetail(content: string): string { const redacted = redact(content); const lines = redacted.split(/\r?\n/); return lines.length > 120 ? `${lines.slice(0, 120).join('\n')}\n…` : redacted; }
interface CommandContext { app: ReturnType<typeof useApp>; config: AgentConfig; sessionId?: string; setSessionId: (value: string | undefined) => void; setSessionLabel: (value: string | undefined) => void; showReasoning: boolean; markPluginsForReload: () => void; setShowReasoning: (value: boolean) => void; openPicker: (kind: PickerKind) => Promise<void>; appendSystem: (text: string) => void; appendError: (text: string) => void; persistEffort: (level: ThinkingLevel, targetSessionId?: string) => Promise<void>; setModel: (model: string) => void; resumeSession: (sessionId?: string) => Promise<void>; compactSession: typeof compactSession; memoryStatus: typeof memoryStatus; }
async function handleCommand(line: string, ctx: CommandContext): Promise<void> {
  if (line === '/quit' || line === '/exit') { ctx.app.exit(); return; } if (line === '/help') { ctx.appendSystem(renderHelp().trim()); return; } if (line === '/new') { await ctx.resumeSession(undefined); return; }
  if (line === '/trust') { new ProjectTrustStore().trust(ctx.config.workspaceRoot); ctx.config.projectTrusted = true; ctx.appendSystem('Workspace trusted for future runs.'); return; }
  if (line === '/fork') { if (!ctx.sessionId) { ctx.appendError('Start a session before forking it.'); return; } try { const child = await new JsonlSessionStore(`${ctx.config.workspaceRoot}/.nju-agent`).fork(ctx.sessionId); await ctx.resumeSession(child.id); } catch (error) { ctx.appendError(`Could not fork session: ${asMessage(error)}`); } return; }
  if (line === '/session') { const named = ctx.sessionId && ctx.config.session.enabled ? (await new JsonlSessionStore(`${ctx.config.workspaceRoot}/.nju-agent`).list()).find((item) => item.id === ctx.sessionId)?.name : undefined; ctx.appendSystem(`session: ${ctx.sessionId ?? '(new)'}${named ? `\nname: ${named}` : ''}\nmodel: ${ctx.config.model.model}\neffort: ${ctx.config.model.thinking.level}\nreasoning display: ${ctx.showReasoning ? 'on' : 'off'}\npermission: ${ctx.config.permissionMode}`); return; }
  if (line === '/name' || line.startsWith('/name ') || line === '/rename' || line.startsWith('/rename ')) { const name = line.replace(/^\/(?:name|rename)/, '').trim(); if (!name) { ctx.appendError('Usage: /rename <session_name>'); return; } if (!ctx.config.session.enabled) { ctx.appendError('Sessions are disabled.'); return; } const normalized = name.slice(0, 120); try { const named = await ensureNamedSession(ctx.config, ctx.sessionId, normalized); ctx.config.session.id = named.sessionId; ctx.setSessionId(named.sessionId); ctx.setSessionLabel(normalized); ctx.appendSystem(`session name: ${normalized}`); } catch (error) { ctx.appendError(`Could not name session: ${asMessage(error)}`); } return; }
  if (line === '/reasoning' || line === '/thinking') { await ctx.openPicker('reasoning-display'); return; } if (/^\/(reasoning|thinking) /.test(line)) { const requested = line.replace(/^\/(reasoning|thinking)\s+/, ''); if (requested !== 'on' && requested !== 'off') { ctx.appendError('Usage: /reasoning [on|off]'); return; } ctx.setShowReasoning(requested === 'on'); ctx.appendSystem(`reasoning display: ${requested}`); return; }
  if (line === '/effort') { await ctx.openPicker('effort'); return; } if (line.startsWith('/effort ')) { const requested = line.slice(8).trim(); if (!isThinkingLevel(requested)) { ctx.appendError(`Invalid effort: ${requested}. Expected: ${supportedEffortText(ctx.config)}`); return; } const level = clampThinkingLevel(requested, ctx.config.model.thinking.map); await ctx.persistEffort(level); ctx.appendSystem(`effort: ${level}`); return; }
  if (line === '/model') { await ctx.openPicker('model'); return; } if (line.startsWith('/model ')) { ctx.setModel(line.slice(7).trim()); return; }
  if (line === '/memory') { const status = ctx.memoryStatus(ctx.config); ctx.appendSystem(`memory: ${status.enabled ? 'enabled' : 'disabled'}\ndirectory: ${status.directory}\nindex: ${status.indexExists ? `${status.indexLines} lines, ${status.indexBytes} bytes${status.truncated ? ' (truncated for context)' : ''}` : 'not created'}\ntopics: ${status.topics.join(', ') || '(none)'}`); return; }
  if (line === '/reload') { try { const plugins = await loadUserPlugins(ctx.config.workspaceRoot, ctx.config.projectTrusted, true); ctx.markPluginsForReload(); ctx.appendSystem(`Reloaded ${plugins.length} user plugin(s). New tools will be active on the next agent run.`); } catch (error) { ctx.appendError(`Could not reload tools: ${asMessage(error)}`); } return; }
  if (line === '/compact') { if (!ctx.sessionId) { ctx.appendError('Start a session before compacting it.'); return; } try { const result = await ctx.compactSession(ctx.config, ctx.sessionId); ctx.appendSystem(result.compacted ? `Compacted ${result.omittedMessages} messages into a deterministic ${result.outputChars}-character summary.` : 'Not enough session history to compact.'); } catch (error) { ctx.appendError(`Could not compact session: ${asMessage(error)}`); } return; }
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
export async function ensureNamedSession(config: AgentConfig, sessionId: string | undefined, name: string): Promise<{ sessionId: string }> {
  const store = new JsonlSessionStore(`${config.workspaceRoot}/.nju-agent`);
  const session = sessionId
    ? await store.open(sessionId)
    : await store.create({ cwd: config.workspaceRoot, model: config.model.model, appVersion: renderVersion().trim() });
  await store.append(session.id, createSessionNameEntry(session.id, name));
  return { sessionId: session.id };
}
export function fileReferenceToken(text: string): { start: number; query: string } | undefined {
  const match = /(?:^|\s)@([^\s]*)$/.exec(text);
  return match ? { start: match.index + match[0].length - match[1]!.length - 1, query: match[1]! } : undefined;
}
export function replaceFileReference(state: EditorState, filePath: string): EditorState {
  const token = fileReferenceToken(state.text.slice(0, state.cursorOffset));
  if (!token) return state;
  const before = state.text.slice(0, token.start);
  const after = state.text.slice(state.cursorOffset);
  const replacement = `@${filePath} `;
  const text = `${before}${replacement}${after}`;
  return { ...state, text, cursorOffset: before.length + replacement.length };
}
export async function findFileCompletions(workspaceRoot: string, query: string, limit = 30): Promise<CompletionItem[]> {
  const results: CompletionItem[] = [];
  const root = path.resolve(workspaceRoot);
  async function visit(directory: string): Promise<void> {
    if (results.length >= limit) return;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (results.length >= limit) return;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (['node_modules', '.git', '.nju-agent', 'dist'].includes(entry.name) && entry.isDirectory()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) await visit(absolute);
      else if (relative.toLowerCase().startsWith(query.toLowerCase())) results.push({ name: relative, description: 'file', kind: 'file' });
    }
  }
  await visit(root);
  return results;
}
function asMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
