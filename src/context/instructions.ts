import fs from 'node:fs';
import path from 'node:path';

export interface ProjectInstruction {
  path: string;
  content: string;
  trusted: boolean;
}

const INSTRUCTION_NAMES = ['AGENTS.md', 'CLAUDE.md', 'instructions.md'];

export function loadProjectInstructions(workspaceRoot: string, trusted = false): ProjectInstruction[] {
  const result: ProjectInstruction[] = [];
  let current = path.resolve(workspaceRoot);
  while (true) {
    for (const name of INSTRUCTION_NAMES) {
      const filePath = path.join(current, name);
      if (!fs.existsSync(filePath)) continue;
      const content = readBounded(filePath, 40_000);
      if (content !== undefined) result.push({ path: filePath, content, trusted });
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result.reverse();
}

function readBounded(filePath: string, maxChars: number): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8').slice(0, maxChars);
  } catch {
    return undefined;
  }
}
