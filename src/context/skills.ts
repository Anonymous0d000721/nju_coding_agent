import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '../tools/types.js';

export interface SkillDescriptor {
  name: string;
  description: string;
  path: string;
  trusted: boolean;
}

export interface LoadedSkill extends SkillDescriptor {
  content: string;
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDescriptor>();

  scan(workspaceRoot: string, trusted = false): SkillDescriptor[] {
    if (!trusted) return [];
    const roots = [path.join(workspaceRoot, '.agents', 'skills'), path.join(workspaceRoot, '.nju-agent', 'skills')];
    for (const root of roots) this.scanRoot(root, trusted);
    return this.list();
  }

  list(): SkillDescriptor[] { return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name)); }

  load(name: string): LoadedSkill {
    const descriptor = this.skills.get(name);
    if (!descriptor) throw new Error(`Unknown skill: ${name}`);
    const content = fs.readFileSync(descriptor.path, 'utf8').slice(0, 80_000);
    return { ...descriptor, content };
  }

  catalog(): string {
    return this.list().map((skill) => `- ${skill.name}: ${skill.description}`).join('\n');
  }

  createLoadTool(): ToolDefinition {
    return {
      name: 'load_skill',
      description: 'Load the full text of a registered skill by name.',
      risk: 'read',
      readonly: true,
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
      handler: async (args) => {
        const name = (args as { name: string }).name;
        const skill = this.load(name);
        return { name: skill.name, source: skill.path, trusted: skill.trusted, content: skill.content };
      },
    };
  }

  private scanRoot(root: string, trusted: boolean): void {
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(root, entry.name, 'SKILL.md');
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8').slice(0, 12_000);
      const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(content)?.[1] ?? '';
      const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ?? entry.name;
      const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ?? 'No description provided.';
      if (/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) this.skills.set(name, { name, description, path: filePath, trusted });
    }
  }
}
