import { describe, expect, it } from 'vitest';
import { formatToolCallPreview, formatToolResultPreview } from '../../src/tools/preview.js';

describe('tool activity previews', () => {
  it('summarizes read ranges and limits write content to eight lines', () => {
    expect(formatToolCallPreview({ id: 'r', name: 'read_file', argumentsJson: '{"path":"src/a.ts","offset":12,"limit":5}' })).toBe('read src/a.ts lines 12–16');
    const content = Array.from({ length: 9 }, (_, index) => `line-${index + 1}`).join('\n');
    const preview = formatToolCallPreview({ id: 'w', name: 'write_file', argumentsJson: JSON.stringify({ path: 'a.ts', content }) });
    expect(preview).toContain('write a.ts');
    expect(preview).toContain('line-8');
    expect(preview).not.toContain('line-9');
    expect(preview).toContain('…');
  });

  it('formats edit diffs and command output with the shared line limit', () => {
    const edit = formatToolResultPreview({ id: 'e', name: 'hashline_edit', argumentsJson: '{"path":"a.ts","edits":[]}' }, { path: 'a.ts', preview: '@@ -1,1 +1,1 @@\n- old\n+ new' }, { ok: true });
    expect(edit).toContain('@@ -1,1 +1,1 @@');
    expect(edit).toContain('- old');
    expect(edit).toContain('+ new');
    const output = Array.from({ length: 9 }, (_, index) => `out-${index + 1}`).join('\n');
    const command = formatToolResultPreview({ id: 'c', name: 'run_command', argumentsJson: '{"command":"npm test"}' }, { command: 'npm test', stdout: output }, { ok: true });
    expect(command).toContain('run npm test');
    expect(command).toContain('out-8');
    expect(command).not.toContain('out-9');
  });

  it('redacts sensitive generic arguments and keeps command text', () => {
    expect(formatToolCallPreview({ id: 'c', name: 'run_command', argumentsJson: '{"command":"echo sk-1234567890"}' })).toBe('run echo [REDACTED_SECRET]');
    expect(formatToolCallPreview({ id: 'x', name: 'custom_tool', argumentsJson: '{"token":"hidden","path":"a.txt"}' })).toContain('path="a.txt"');
    expect(formatToolCallPreview({ id: 'x', name: 'custom_tool', argumentsJson: '{"token":"hidden","path":"a.txt"}' })).not.toContain('hidden');
  });
});
