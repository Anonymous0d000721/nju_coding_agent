import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { compactMessages } from '../src/context/compactor.js';
import { AgentRunner } from '../src/agent/runner.js';
import type { AgentMessage, AgentStreamEvent } from '../src/agent/types.js';
import type { ModelClient } from '../src/model/model-client.js';
import { withModelRetry, ModelTransportError } from '../src/model/retry.js';
import { TelemetryStore } from '../src/telemetry/store.js';
import { McpManager, type McpTransport } from '../src/mcp/client.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { loadUserPluginReport } from '../src/plugins/loader.js';

interface BenchmarkMetric { value: number; unit: string; note?: string; }
interface BenchmarkReport {
  schemaVersion: 1;
  mode: 'deterministic-runtime-benchmark';
  startedAt: string;
  finishedAt: string;
  node: string;
  platform: string;
  metrics: Record<string, BenchmarkMetric>;
  checks: { largeOutputBounded: boolean; telemetryQueryable: boolean; pluginIsolation: boolean; mcpIsolation: boolean };
  artifactPath?: string;
}

const startedAt = new Date().toISOString();
const memoryBefore = process.memoryUsage().heapUsed;
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-agent-benchmark-'));
const metrics: Record<string, BenchmarkMetric> = {};

try {
  const startupStart = performance.now();
  const telemetry = new TelemetryStore(path.join(workspace, 'events.jsonl'), 'normal', ['benchmark-secret'], { maxBytes: 32_000, maxFiles: 2 });
  const registry = new ToolRegistry();
  metrics.startup = metric(performance.now() - startupStart, 'ms', 'construct telemetry store and host registry');

  let firstTokenMs: number | undefined;
  const model: ModelClient = {
    complete: async () => ({ id: 'complete', text: 'done', toolCalls: [], stopReason: 'end_turn' }),
    stream: async (_request, handler) => {
      const tokenStart = performance.now();
      await handler?.({ type: 'text_delta', delta: 'done' });
      firstTokenMs = performance.now() - tokenStart;
      return { id: 'stream', text: 'done', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const runner = new AgentRunner({ model, tools: new ToolExecutor(registry, { workspaceRoot: workspace }), systemPrompt: 'benchmark', toolDefinitions: [] });
  const runStart = performance.now();
  await runner.run('benchmark', { runId: 'benchmark-run' });
  metrics.firstToken = metric(firstTokenMs ?? performance.now() - runStart, 'ms', 'FakeModel stream callback');

  const largeRegistry = new ToolRegistry();
  largeRegistry.register(tool('large_output', async () => 'x'.repeat(50_000)));
  const largeResult = (await new ToolExecutor(largeRegistry, { workspaceRoot: workspace }).executeBatch([{ id: 'large', name: 'large_output', argumentsJson: '{}' }]))[0]!;
  metrics.largeOutput = metric(largeResult.content.length, 'chars', 'ToolExecutor bounded observation');

  const concurrentRegistry = new ToolRegistry();
  concurrentRegistry.register(tool('delayed_read', async () => { await delay(10); return 'ok'; }));
  const calls = Array.from({ length: 8 }, (_, index) => ({ id: `call-${index}`, name: 'delayed_read', argumentsJson: '{}' }));
  const toolsStart = performance.now();
  const toolResults = await new ToolExecutor(concurrentRegistry, { workspaceRoot: workspace, maxConcurrency: 4 }).executeBatch(calls, undefined, 4);
  metrics.toolBatch = metric(performance.now() - toolsStart, 'ms', '8 independent calls at maxConcurrency=4');
  metrics.toolAverage = metric(toolResults.reduce((sum, result) => sum + result.elapsedMs, 0) / toolResults.length, 'ms', 'reported per-call elapsedMs');

  const history: AgentMessage[] = Array.from({ length: 300 }, (_, index) => ({ role: index % 3 === 0 ? 'user' : index % 3 === 1 ? 'assistant' : 'tool', content: `message-${index} ${'history '.repeat(120)}`, sessionEntryId: `entry-${index}` }));
  const compactionStart = performance.now();
  const compacted = compactMessages(history, 20_000, 8, true);
  metrics.compaction = metric(performance.now() - compactionStart, 'ms', `${history.length} messages to ${compacted.messages.length}`);
  metrics.compactionOutput = metric(compacted.stats.outputChars, 'chars', 'deterministic summary size');

  const retryEvents: number[] = [];
  let attempts = 0;
  const retryStart = performance.now();
  await withModelRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new ModelTransportError('temporary failure', { retryable: true, code: 'benchmark_retry' });
    return true;
  }, undefined, { baseDelayMs: 2, maxDelayMs: 4, random: () => 0, onRetry: (event) => retryEvents.push(event.delayMs) });
  metrics.retryWait = metric(performance.now() - retryStart, 'ms', `retry delays: ${retryEvents.join(',')} ms`);

  for (let index = 0; index < 12; index += 1) {
    const pluginDirectory = path.join(workspace, '.nju-agent', 'plugins');
    await fs.mkdir(pluginDirectory, { recursive: true });
    await fs.writeFile(path.join(pluginDirectory, `plugin-${index}.mjs`), `export default { id: 'benchmark-${index}', tools: [{ name: 'read_${index}', description: 'benchmark', risk: 'read', readonly: true, parameters: { type: 'object', additionalProperties: false }, handler: () => 'ok' }] };\n`, 'utf8');
  }
  const pluginStart = performance.now();
  const plugins = await loadUserPluginReport(workspace, true);
  metrics.pluginLoad = metric(performance.now() - pluginStart, 'ms', `${plugins.loaded.length} plugins`);
  metrics.pluginCount = metric(plugins.loaded.length, 'plugins');

  const manager = new McpManager(1_000);
  const mcpStart = performance.now();
  for (let index = 0; index < 10; index += 1) await manager.connect(`server-${index}`, mockTransport(index));
  metrics.mcpConnect = metric(performance.now() - mcpStart, 'ms', '10 independent mock stdio-equivalent transports');
  metrics.mcpServerCount = metric(manager.serversStatus().length, 'servers');
  await manager.disconnectAll();

  await telemetry.append({ type: 'benchmark', sessionId: 'benchmark-session', runId: 'benchmark-run', data: { toolCallId: 'benchmark-call', output: 'benchmark-secret' } });
  const queried = await telemetry.query({ runId: 'benchmark-run', toolCallId: 'benchmark-call' });
  metrics.memoryHeapDelta = metric(process.memoryUsage().heapUsed - memoryBefore, 'bytes', 'process heap delta; includes benchmark harness');
  const report: BenchmarkReport = {
    schemaVersion: 1,
    mode: 'deterministic-runtime-benchmark',
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    metrics,
    checks: { largeOutputBounded: largeResult.content.length <= 12_100, telemetryQueryable: queried.length === 1 && queried[0]?.schemaVersion === 1, pluginIsolation: plugins.diagnostics.length === 0 && plugins.loaded.length === 12, mcpIsolation: metrics.mcpServerCount.value === 10 },
  };
  const artifact = path.join(workspace, 'benchmark.json');
  await fs.writeFile(artifact, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  report.artifactPath = artifact;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  metrics.memoryHeapDelta = metric(process.memoryUsage().heapUsed - memoryBefore, 'bytes', 'process heap delta; includes benchmark harness');
  await fs.rm(workspace, { recursive: true, force: true });
}

function tool(name: string, handler: ToolDefinition['handler']): ToolDefinition {
  return { name, description: name, parameters: { type: 'object', additionalProperties: false }, risk: 'read', readonly: true, handler };
}
function mockTransport(index: number): McpTransport {
  return { request: async (method) => method === 'initialize' ? { protocolVersion: '2024-11-05', serverInfo: { version: `1.0.${index}` } } : { tools: [{ name: `read_${index}`, description: 'benchmark', risk: 'read', inputSchema: { type: 'object' } }] } };
}
function metric(value: number, unit: string, note?: string): BenchmarkMetric { return { value: Number(value.toFixed(3)), unit, ...(note ? { note } : {}) }; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
