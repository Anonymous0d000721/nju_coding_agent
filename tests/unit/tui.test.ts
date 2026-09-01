import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyAgentEvent, editorLinesWithCursor, ensureNamedSession, fileReferenceToken, findFileCompletions, formatRunStatus, formatStatusBar, isMarkdownTableSeparator, isMarkdownTableRow, messagePresentation, parseMarkdownTableRow, replaceFileReference, sessionEntriesToTuiMessages, toggleLastToolDetails, transcriptPageSize, transcriptWindow, type TuiMessage } from '../../src/app/tui.js';
import { createEditorState } from '../../src/app/editor-state.js';
import type { SessionEntry } from '../../src/session/session-types.js';
import type { AgentStreamEvent } from '../../src/agent/types.js';
import { createIdleRunStatus, type RunStatus } from '../../src/telemetry/report.js';
import { JsonlSessionStore } from '../../src/session/jsonl-store.js';
import { currentMcpStatus } from '../../src/app/tui.js';
import { McpRuntime } from '../../src/mcp/runtime.js';
import type { AgentConfig } from '../../src/shared/config.js';
import { ApprovalBroker } from '../../src/tools/approval.js';

const base: TuiMessage[] = [{ role: 'system', text: 'ready' }];

describe('TUI event rendering', () => {
  it('appends text deltas to the current assistant message', () => {
    const first = applyAgentEvent(base, { type: 'text_delta', delta: 'Hel' }, false);
    const second = applyAgentEvent(first, { type: 'text_delta', delta: 'lo' }, false);

    expect(second).toEqual([
      { role: 'system', text: 'ready' },
      { role: 'assistant', text: 'Hello' },
    ]);
  });

  it('hides reasoning deltas by default and shows them when enabled', () => {
    const event: AgentStreamEvent = { type: 'thinking_delta', delta: 'thinking' };

    expect(applyAgentEvent(base, event, false)).toBe(base);
    expect(applyAgentEvent(base, event, true)).toEqual([
      { role: 'system', text: 'ready' },
      { role: 'thinking', text: 'thinking' },
    ]);
  });

  it('renders tool call and tool result summaries only', () => {
    const withCall = applyAgentEvent(base, {
      type: 'tool_call',
      toolCall: { id: 'call-1', name: 'read_file', argumentsJson: '{"path":"secret"}' },
      preview: 'read secret lines 1–400',
    }, false);
    const withResult = applyAgentEvent(withCall, {
      type: 'tool_result',
      result: { toolCallId: 'call-1', toolName: 'read_file', ok: false, content: '', preview: 'read secret lines 1–400\nfailed: permission_denied', error: { code: 'permission_denied', message: 'denied', recoverable: true }, elapsedMs: 1 },
    }, false);

    expect(withResult).toEqual([
      { role: 'system', text: 'ready' },
      { role: 'tool', text: 'read secret lines 1–400\nfailed: permission_denied', detail: '', expanded: false, ok: false, toolCallId: 'call-1' },
    ]);
  });

  it('updates the active tool card instead of appending a trailing result overview', () => {
    const withCall = applyAgentEvent(base, {
      type: 'tool_call',
      toolCall: { id: 'call-1', name: 'read_file', argumentsJson: '{"path":"a"}' },
    }, false);
    const completed = applyAgentEvent(withCall, {
      type: 'tool_result',
      result: { toolCallId: 'call-1', toolName: 'read_file', ok: true, content: 'hidden', preview: 'read a lines 1–1', elapsedMs: 1 },
    }, false);

    expect(completed).toEqual([
      { role: 'system', text: 'ready' },
      { role: 'tool', text: 'read a lines 1–1', detail: 'hidden', expanded: false, ok: true, toolCallId: 'call-1' },
    ]);
  });

  it('keeps the status bar compact while retaining active controls', () => {
    const text = formatStatusBar({ status: 'running', model: 'gpt-5', effort: 'medium', sessionLabel: 'demo', permissionMode: 'yolo', showReasoning: true });

    expect(text).toBe('run · gpt-5 · medium · demo · yolo · R:on · ^J newline · Esc cancel');
    expect(text).not.toContain('api ');
    expect(text).not.toContain('permission ');
    expect(text).not.toContain('reasoning ');
    expect(text).not.toContain('session ');
  });

  it('formats a fresh idle status with current configuration and not-started reason', () => {
    const text = formatRunStatus(createIdleRunStatus({ workspace: 'D:/workspace', sessionId: undefined, model: 'deepseek-v4-flash', effort: 'medium', permissionMode: 'yolo' }));

    expect(text).toContain('run: idle');
    expect(text).toContain('workspace: D:/workspace');
    expect(text).toContain('model: deepseek-v4-flash');
    expect(text).toContain('effort: medium');
    expect(text).toContain('permission: yolo');
    expect(text).toContain('turns: 0 · tool calls: 0 (0 ok, 0 failed)');
    expect(text).toContain('stop reason: (not started)');
  });

  it('keeps live MCP catalog and reload state in idle TUI status', async () => {
    const runtime = new McpRuntime();
    const config = {
      workspaceRoot: 'D:/workspace', projectTrusted: true,
      mcpServers: [{ name: 'demo', command: 'node' }],
    } as AgentConfig;
    await runtime.sync(config.mcpServers, async () => ({
      request: async (method) => method === 'tools/list' ? { tools: [{ name: 'read', risk: 'read' }] } : { protocolVersion: '2024-11-05' },
    }));

    const connected = currentMcpStatus(runtime, config);
    expect(connected).toMatchObject({ servers: [{ name: 'demo', state: 'connected' }], toolCatalog: [{ qualifiedName: 'mcp__demo__read' }], reload: { status: 'idle' } });

    runtime.manager.requestReload();
    expect(currentMcpStatus(runtime, config)).toMatchObject({ servers: [{ name: 'demo', state: 'connected' }], toolCatalog: [{ qualifiedName: 'mcp__demo__read' }], reload: { status: 'scheduled', requested: true } });
    await runtime.close();
  });

  it('formats structured run evidence without losing command and error details', () => {
    const status: RunStatus = {
      runId: 'run-1', workspace: 'D:/workspace', sessionId: 'session-1', state: 'completed', model: 'gpt-5', effort: 'medium', permissionMode: 'yolo',
      turns: 2, toolCalls: 2, tools: [], policyDecisions: 1, toolSuccesses: 1, toolFailures: 1,
      verification: { plan: { requirements: [{ kind: 'test' }], invalidateOnMutation: true }, evidence: [], status: 'failed' },
      commands: [{ command: 'npm test', exitCode: 1, stderrTail: 'one test failed' }], filesChanged: ['src/app.ts'], compactions: 1, lastCompactionReason: 'threshold', stopReason: 'model_finished', warnings: ['retrying'], errors: ['read_file: permission_denied'],
    };
    const text = formatRunStatus(status);

    expect(text).toContain('run: completed');
    expect(text).toContain('verification: failed');
    expect(text).toContain('last command: npm test · exit 1');
    expect(text).toContain('stderr: one test failed');
    expect(text).toContain('changed files: src/app.ts');
    expect(text).toContain('warnings: retrying');
    expect(text).toContain('errors: read_file: permission_denied');
  });

  it('toggles the latest tool details without changing other messages', () => {
    const messages: TuiMessage[] = [
      { role: 'assistant', text: 'Inspecting' },
      { role: 'tool', text: 'read file lines 1–2', detail: 'line 1\nline 2', expanded: false, ok: true, toolCallId: 'call-1' },
    ];

    const expanded = toggleLastToolDetails(messages);
    expect(expanded[1]).toMatchObject({ expanded: true });
    expect(toggleLastToolDetails(expanded)[1]).toMatchObject({ expanded: false });
    expect(expanded[0]).toBe(messages[0]);
  });

  it('pages transcript windows without discarding history', () => {
    const messages = ['m1', 'm2', 'm3', 'm4', 'm5'];
    expect(transcriptPageSize(10)).toBe(12);
    expect(transcriptWindow(messages, 2, 0)).toEqual({ start: 3, end: 5, items: ['m4', 'm5'] });
    expect(transcriptWindow(messages, 2, 2)).toEqual({ start: 1, end: 3, items: ['m2', 'm3'] });
    expect(transcriptWindow(messages, 2, 99)).toEqual({ start: 0, end: 0, items: [] });
  });

  it('lists rename and reload commands', () => {
    expect([' /rename', ' /reload'].map((value) => value.trim())).toEqual(['/rename', '/reload']);
  });

  it('creates and names a new session before the first prompt', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'nju-agent-tui-'));
    const config = {
      workspaceRoot,
      model: { model: 'test-model' },
    } as Parameters<typeof ensureNamedSession>[0];
    const result = await ensureNamedSession(config, undefined, 'debug session');
    const session = await new JsonlSessionStore(`${workspaceRoot}/.nju-agent`).open(result.sessionId);

    expect(result.sessionId).toBe(session.id);
    expect(session.entries.at(-1)).toMatchObject({ type: 'session_name', name: 'debug session' });
  });

  it('completes workspace-relative @ file references and replaces the token', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'nju-agent-files-'));
    const fs = await import('node:fs/promises');
    await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'src', 'app.ts'), 'export const app = true;');
    await fs.writeFile(path.join(workspaceRoot, 'README.md'), '# nju-agent');

    expect(fileReferenceToken('review @src/ap')).toEqual({ start: 7, query: 'src/ap' });
    expect(fileReferenceToken('plain text')).toBeUndefined();
    await expect(findFileCompletions(workspaceRoot, 'src/ap')).resolves.toEqual([{ name: 'src/app.ts', description: 'file', kind: 'file' }]);
    expect(replaceFileReference({ text: 'review @src/ap', cursorOffset: 14, history: [] }, 'src/app.ts')).toMatchObject({ text: 'review @src/app.ts ', cursorOffset: 19 });
  });

  it('recognizes and parses Markdown tables', () => {
    expect(isMarkdownTableRow('| Name | Status |')).toBe(true);
    expect(isMarkdownTableSeparator('| --- | :---: |')).toBe(true);
    expect(parseMarkdownTableRow('| Name | Status |')).toEqual(['Name', 'Status']);
  });

  it('keeps the visible editor cursor on the active multiline line', () => {
    const editor = { ...createEditorState(), text: 'first\\nsecond', cursorOffset: 8 };
    expect(editorLinesWithCursor(editor)).toEqual([
      { before: 'first', at: '', after: '' },
      { before: 'se', at: 'c', after: 'ond' },
    ]);
  });

  it('uses foreground markers instead of transcript background blocks', () => {
    expect(messagePresentation({ role: 'user', text: 'prompt' })).toEqual({ color: 'green', marker: '› ', dim: false });
    expect(messagePresentation({ role: 'assistant', text: 'answer' })).toEqual({ color: 'white', marker: '' });
    expect(messagePresentation({ role: 'tool', text: 'failed', ok: false })).toEqual({ color: 'red', marker: '• ' });
    expect(messagePresentation({ role: 'thinking', text: 'reasoning' })).toEqual({ color: 'gray', marker: '· ', dim: true });
  });

  it('shares the approval broker lifecycle used by TUI and RPC', async () => {
    let visibleRequest: Awaited<ReturnType<ApprovalBroker['pendingRequests']>>[number] | undefined;
    const visibility = new ApprovalBroker({ onRequest: (request) => { visibleRequest = request; }, onResult: (request) => { if (visibleRequest?.requestId === request.requestId) visibleRequest = undefined; } });
    const pending = visibility.request({ runId: 'tui-run', toolCallId: 'tui-call', toolName: 'write_file', risk: 'medium', args: { path: 'src/app.ts', token: '[REDACTED]' }, workspacePath: 'src/app.ts', reason: 'Mutation requires approval.', grantKey: 'write_file:mutation-approval' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(visibleRequest).toMatchObject({ runId: 'tui-run', toolCallId: 'tui-call', args: { token: '[REDACTED]' } });
    expect(visibility.resolve(visibleRequest!.requestId, { outcome: 'allow_once', reason: 'approved in TUI' })).toEqual({ ok: true });
    await expect(pending).resolves.toMatchObject({ outcome: 'allow_once' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(visibleRequest).toBeUndefined();
  });

  it('rebuilds persisted conversation and tool status for session hydration', () => {
    const entries: SessionEntry[] = [
      { type: 'message', id: 'u', sessionId: 's', timestamp: 't', schemaVersion: 1, message: { role: 'user', content: 'Fix **this**.' } },
      { type: 'message', id: 'a', sessionId: 's', timestamp: 't', schemaVersion: 1, message: { role: 'assistant', content: 'I will inspect it.', toolCalls: [{ id: 'call-1', name: 'read_file', argumentsJson: '{}' }] } },
      { type: 'message', id: 'r', sessionId: 's', timestamp: 't', schemaVersion: 1, message: { role: 'tool', toolCallId: 'call-1', content: 'contents' } },
      { type: 'run_end', id: 'end', sessionId: 's', timestamp: 't', schemaVersion: 1, stopReason: 'user_cancelled', turns: 1, toolCalls: 1 },
    ];

    expect(sessionEntriesToTuiMessages(entries)).toEqual([
      { role: 'user', text: 'Fix **this**.' },
      { role: 'assistant', text: 'I will inspect it.' },
      { role: 'tool', text: 'read_file · completed', detail: 'contents', expanded: false, ok: true, toolCallId: 'call-1' },
      { role: 'cancelled', text: 'Run interrupted.' },
    ]);
  });
});
