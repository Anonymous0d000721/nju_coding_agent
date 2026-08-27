import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { attachmentPathFromPrompt, expandPromptAttachments } from '../../src/context/attachments.js';

describe('prompt attachments', () => {
  it('expands explicit paths as bounded file data', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-attachments-'));
    await fs.writeFile(path.join(root, 'notes.txt'), 'hello\nsk-test-secret');
    expect(attachmentPathFromPrompt('review @notes.txt @notes.txt')).toEqual(['notes.txt', 'notes.txt']);

    const result = await expandPromptAttachments('review @notes.txt', root);

    expect(result.attachments).toHaveLength(1);
    expect(result.prompt).toContain('[File data: notes.txt]');
    expect(result.prompt).toContain('hello');
    expect(result.prompt).not.toContain('sk-test-secret');
  });

  it('rejects attachments outside the workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-attachments-'));
    await expect(expandPromptAttachments('read @../secret.txt', root)).rejects.toMatchObject({ code: 'path_outside_workspace' });
  });
});
