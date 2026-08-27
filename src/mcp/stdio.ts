import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { McpTransport } from './client.js';

export interface StdioTransportOptions { command: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv; }

export function createStdioTransport(options: StdioTransportOptions): McpTransport {
  const child = spawn(options.command, options.args ?? [], { cwd: options.cwd, env: { ...process.env, ...options.env }, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  return new StdioJsonRpcTransport(child);
}

class StdioJsonRpcTransport implements McpTransport {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly lines;
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => this.handleLine(line));
    child.on('error', (error) => this.failAll(error));
    child.on('exit', (code, signal) => this.failAll(new Error(`MCP server exited (${code ?? signal ?? 'unknown'})`)));
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('MCP transport is closed'));
    const id = this.nextId++;
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${request}\n`, (error) => { if (error) { this.pending.delete(id); reject(error); } });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('MCP transport closed'));
    this.lines.close();
    this.child.kill();
  }

  private handleLine(line: string): void {
    try {
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
      if (typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? 'MCP request failed'));
      else pending.resolve(message.result);
    } catch {
      this.failAll(new Error('Invalid JSON-RPC response from MCP server'));
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
