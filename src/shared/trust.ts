import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface TrustFile { version: 1; workspaces: string[]; }

export class ProjectTrustStore {
  constructor(private readonly filePath = path.join(os.homedir(), '.nju-agent', 'trust.json')) {}

  isTrusted(workspaceRoot: string): boolean { return this.read().workspaces.includes(path.resolve(workspaceRoot)); }

  trust(workspaceRoot: string): void {
    const value = this.read();
    const workspace = path.resolve(workspaceRoot);
    if (!value.workspaces.includes(workspace)) value.workspaces.push(workspace);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  revoke(workspaceRoot: string): void {
    const value = this.read();
    value.workspaces = value.workspaces.filter((workspace) => workspace !== path.resolve(workspaceRoot));
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  private read(): TrustFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as TrustFile;
      if (parsed?.version !== 1 || !Array.isArray(parsed.workspaces) || !parsed.workspaces.every((workspace) => typeof workspace === 'string')) throw new Error('invalid trust store');
      return { version: 1, workspaces: parsed.workspaces.map((workspace) => path.resolve(workspace)) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, workspaces: [] };
      throw error;
    }
  }
}
