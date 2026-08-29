import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProjectInstructions } from '../../src/context/instructions.js';
import { SkillRegistry } from '../../src/context/skills.js';

describe('context resources', () => {
  it('loads ancestor instructions with bounded source metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-context-'));
    await fs.mkdir(path.join(root, 'child'));
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'root rules');
    await fs.writeFile(path.join(root, 'child', 'CLAUDE.md'), 'child rules');

    expect(loadProjectInstructions(path.join(root, 'child'), false)).toEqual([]);
    const items = loadProjectInstructions(path.join(root, 'child'), true);

    expect(items.map((item) => item.content)).toEqual(['root rules', 'child rules']);
    expect(items.every((item) => item.path && item.trusted === true)).toBe(true);
  });

  it('keeps untrusted skills out and exposes only trusted catalog metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-skills-'));
    const skillDir = path.join(root, '.nju-agent', 'skills', 'testing');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: testing\ndescription: Run focused tests\n---\nSECRET SKILL BODY');

    const untrusted = new SkillRegistry();
    expect(untrusted.scan(root, false)).toEqual([]);
    expect(untrusted.catalog()).toBe('');

    const trusted = new SkillRegistry();
    expect(trusted.scan(root, true)).toEqual([{ name: 'testing', description: 'Run focused tests', path: path.join(skillDir, 'SKILL.md'), trusted: true }]);
    expect(trusted.catalog()).toBe('- testing: Run focused tests');
    expect(trusted.load('testing').content).toContain('SECRET SKILL BODY');
    expect(() => trusted.load('../testing')).toThrow('Unknown skill');
  });
});
