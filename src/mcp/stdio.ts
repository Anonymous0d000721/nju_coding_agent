import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { McpTransport } from './client.js';

export interface StdioTransportOptions { command: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv; }
const MAX_STDERR_CHARS = 8_000;

export function createStdioTransport(options: StdioTransportOptions): McpTransport {
  const child = spawn(options.command, options.args ?? [], { cwd: options.cwd, env: { ...process.env, ...options.env }, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  return new StdioJsonRpcTransport(child);
}

class StdioJsonRpcTransport implements McpTransport {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly lines;
  private stderrTail = '';
  private closed = false;
  private exited = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
    });
    child.on('error', (error) => this.failAll(error));
    child.on('exit', (code, signal) => {
      this.exited = true;
      this.failAll(new Error(`MCP server exited (${code ?? signal ?? 'unknown'})`));
    });
  }

  diagnostics(): { stderrTail?: string; pid?: number; closed?: boolean; exited?: boolean } {
    return {
      ...(this.stderrTail ? { stderrTail: this.stderrTail.slice(-MAX_STDERR_CHARS) } : {}),
      ...(typeof this.child.pid === 'number' ? { pid: this.child.pid } : {}),
      closed: this.closed,
      exited: this.exited,
    };
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed || this.exited) return Promise.reject(new Error('MCP transport is closed'));
    const id = this.nextId++;
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${request}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('MCP transport closed'));
    this.lines.close();
    await terminateChild(this.child, () => { this.exited = true; });
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

async function terminateChild(child: ChildProcessWithoutNullStreams, markExited: () => void): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) { markExited(); return; }
  const exited = new Promise<void>((resolve) => child.once('exit', () => { markExited(); resolve(); }));
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    await new Promise<void>((resolve) => { killer.once('error', resolve); killer.once('exit', resolve); });
  } else {
    child.kill();
  }
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill();
  markExited();
}
