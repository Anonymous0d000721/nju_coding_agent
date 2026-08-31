import { spawn, type ChildProcess } from 'node:child_process';

/** Terminates a child and its descendants so cancelled work does not outlive the tool call. */
export async function terminateProcessTree(child: ChildProcess, timeoutMs = 1_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    await new Promise<void>((resolve) => { killer.once('error', resolve); killer.once('exit', resolve); });
  } else {
    child.kill();
  }
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  if (child.exitCode === null && child.signalCode === null) child.kill();
}
