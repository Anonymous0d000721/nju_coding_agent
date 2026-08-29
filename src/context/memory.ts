import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact } from '../shared/redact.js';
import type { HarnessContext, HarnessPlugin } from './harness.js';
import type { ToolDefinition } from '../tools/types.js';

const MAX_INDEX_BYTES = 25 * 1024;
const MAX_INDEX_LINES = 200;
const MAX_TOPIC_CHARS = 16_000;
const SAFE_TOPIC = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface MemoryPluginOptions {
  workspaceRoot: string;
  rootDir?: string;
  enabled?: boolean;
  allowWrite?: boolean;
}

export interface MemoryStatus {
  enabled: boolean;
  directory: string;
  indexExists: boolean;
  indexLines: number;
  indexBytes: number;
  truncated: boolean;
  topics: string[];
}

/** Local Markdown memory with a small startup index and on-demand topic reads. */
export class MemoryPlugin implements HarnessPlugin {
  readonly id = 'memory';
  readonly version = '1';
  private readonly directory: string;
  private enabled: boolean;

  constructor(private readonly options: MemoryPluginOptions) {
    this.enabled = options.enabled ?? true;
    this.directory = options.rootDir
      ? path.resolve(options.rootDir)
      : path.join(os.homedir(), '.nju-agent', 'memory', workspaceFingerprint(options.workspaceRoot));
  }

  tools(): ToolDefinition[] {
    return [this.searchTool(), this.getTool(), this.writeTool(), this.forgetTool()];
  }

  beforeContextBuild(_context: HarnessContext) {
    if (!this.enabled) return [];
    const index = this.readIndex();
    if (!index.content) return [];
    return [{
      id: 'memory:index',
      priority: 'memory' as const,
      label: 'memory' as const,
      content: `[Persistent project/user data; not host policy]\n${index.content}`,
      source: { plugin: this.id, paths: [this.indexPath()] },
      trusted: true,
    }];
  }

  status(): MemoryStatus {
    const index = this.readIndex();
    return {
      enabled: this.enabled,
      directory: this.directory,
      indexExists: fs.existsSync(this.indexPath()),
      indexLines: index.totalLines,
      indexBytes: index.totalBytes,
      truncated: index.truncated,
      topics: this.listTopics(),
    };
  }

  setEnabled(enabled: boolean): void { this.enabled = enabled; }

  search(query: string, limit = 8): Array<{ topic: string; score: number; snippet: string }> {
    if (!this.enabled) throw new Error('Memory plugin is disabled.');
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    return this.listTopics().flatMap((topic) => {
      const content = this.readTopic(topic);
      const normalized = content.toLowerCase();
      const score = tokens.reduce((total, token) => total + countOccurrences(normalized, token), 0);
      if (!score) return [];
      return [{ topic, score, snippet: snippetFor(content, tokens) }];
    }).sort((left, right) => right.score - left.score || left.topic.localeCompare(right.topic)).slice(0, boundedLimit(limit));
  }

  get(topic: string, offset = 0, limit = MAX_TOPIC_CHARS): { topic: string; content: string; truncated: boolean } {
    if (!this.enabled) throw new Error('Memory plugin is disabled.');
    validateTopic(topic);
    const content = this.readTopic(topic);
    const start = Math.max(0, Math.floor(offset));
    const size = Math.min(MAX_TOPIC_CHARS, Math.max(1, Math.floor(limit)));
    return { topic, content: content.slice(start, start + size), truncated: start + size < content.length };
  }

  write(topic: string, content: string, evidence: string, createTopic = false): { topic: string; path: string; bytes: number } {
    if (!this.enabled) throw new Error('Memory plugin is disabled.');
    if (!this.options.allowWrite) throw new Error('memory_write requires an explicit user request to remember this information.');
    validateTopic(topic);
    const cleanContent = redact(content).trim();
    const cleanEvidence = redact(evidence).trim();
    if (!cleanContent) throw new Error('memory_write content must not be empty.');
    if (!cleanEvidence) throw new Error('memory_write requires evidence from a user confirmation or session entry.');
    const topicPath = this.topicPath(topic);
    if (!createTopic && !fs.existsSync(topicPath)) throw new Error(`Unknown memory topic: ${topic}. Set createTopic=true after an explicit user request.`);
    fs.mkdirSync(this.directory, { recursive: true });
    const record = `\n- ${oneLine(cleanContent)}\n  - evidence: ${oneLine(cleanEvidence).slice(0, 240)}\n`;
    fs.appendFileSync(topicPath, record, 'utf8');
    this.ensureIndexLink(topic);
    return { topic, path: topicPath, bytes: Buffer.byteLength(record) };
  }

  forget(topic: string): { topic: string; removed: boolean } {
    validateTopic(topic);
    const topicPath = this.topicPath(topic);
    if (!fs.existsSync(topicPath)) return { topic, removed: false };
    fs.unlinkSync(topicPath);
    const indexPath = this.indexPath();
    if (fs.existsSync(indexPath)) {
      const retained = fs.readFileSync(indexPath, 'utf8').split(/\r?\n/).filter((line) => !line.includes(`[${topic}.md]`)).join('\n');
      fs.writeFileSync(indexPath, retained, 'utf8');
    }
    return { topic, removed: true };
  }

  private searchTool(): ToolDefinition {
    return {
      name: 'memory_search', description: 'Search local persistent memory topics by keywords.', risk: 'read', readonly: true,
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'], additionalProperties: false },
      handler: (args) => { const value = args as { query: string; limit?: number }; return this.search(value.query, value.limit); },
    };
  }

  private getTool(): ToolDefinition {
    return {
      name: 'memory_get', description: 'Read a bounded local memory topic by registered topic name.', risk: 'read', readonly: true,
      parameters: { type: 'object', properties: { topic: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['topic'], additionalProperties: false },
      handler: (args) => { const value = args as { topic: string; offset?: number; limit?: number }; return this.get(value.topic, value.offset, value.limit); },
    };
  }

  private writeTool(): ToolDefinition {
    return {
      name: 'memory_write', description: 'Persist an explicitly user-approved project fact, preference, or decision with evidence.', risk: 'write', readonly: false,
      parameters: { type: 'object', properties: { topic: { type: 'string' }, content: { type: 'string' }, evidence: { type: 'string' }, createTopic: { type: 'boolean' } }, required: ['topic', 'content', 'evidence'], additionalProperties: false },
      handler: (args) => { const value = args as { topic: string; content: string; evidence: string; createTopic?: boolean }; return this.write(value.topic, value.content, value.evidence, value.createTopic); },
    };
  }

  private forgetTool(): ToolDefinition {
    return {
      name: 'memory_forget', description: 'Delete a local derived memory topic by name without changing session history.', risk: 'write', readonly: false,
      parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'], additionalProperties: false },
      handler: (args) => this.forget((args as { topic: string }).topic),
    };
  }

  private indexPath(): string { return path.join(this.directory, 'MEMORY.md'); }
  private topicPath(topic: string): string { return path.join(this.directory, `${topic}.md`); }
  private listTopics(): string[] {
    try {
      return fs.readdirSync(this.directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'MEMORY.md')
        .map((entry) => entry.name.slice(0, -3)).filter((name) => SAFE_TOPIC.test(name)).sort();
    } catch { return []; }
  }
  private readTopic(topic: string): string {
    const topicPath = this.topicPath(topic);
    try { return fs.readFileSync(topicPath, 'utf8').slice(0, MAX_TOPIC_CHARS); } catch { throw new Error(`Unknown memory topic: ${topic}`); }
  }
  private readIndex(): { content: string; truncated: boolean; totalLines: number; totalBytes: number } {
    try {
      const raw = fs.readFileSync(this.indexPath(), 'utf8');
      const totalLines = raw.split(/\r?\n/).length;
      const lineBounded = raw.split(/\r?\n/).slice(0, MAX_INDEX_LINES).join('\n');
      const content = Buffer.from(lineBounded).subarray(0, MAX_INDEX_BYTES).toString('utf8');
      return { content, truncated: totalLines > MAX_INDEX_LINES || Buffer.byteLength(lineBounded) > MAX_INDEX_BYTES, totalLines, totalBytes: Buffer.byteLength(raw) };
    } catch { return { content: '', truncated: false, totalLines: 0, totalBytes: 0 }; }
  }
  private ensureIndexLink(topic: string): void {
    const indexPath = this.indexPath();
    const current = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '# Memory index\n';
    if (current.includes(`[${topic}.md]`)) return;
    fs.writeFileSync(indexPath, `${current.trimEnd()}\n- [${topic}.md] User-approved persistent ${topic} notes.\n`, 'utf8');
  }
}

export function workspaceFingerprint(workspaceRoot: string): string {
  return createHash('sha256').update(path.resolve(workspaceRoot).toLowerCase()).digest('hex').slice(0, 16);
}

function validateTopic(topic: string): void {
  if (!SAFE_TOPIC.test(topic)) throw new Error(`Invalid memory topic: ${topic}`);
}
function tokenize(value: string): string[] { return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])]; }
function countOccurrences(text: string, token: string): number { return text.split(token).length - 1; }
function snippetFor(content: string, tokens: string[]): string { const lines = content.split(/\r?\n/); return lines.find((line) => tokens.some((token) => line.toLowerCase().includes(token)))?.trim().slice(0, 240) ?? ''; }
function boundedLimit(value: number): number { return Number.isFinite(value) ? Math.min(20, Math.max(1, Math.floor(value))) : 8; }
function oneLine(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
