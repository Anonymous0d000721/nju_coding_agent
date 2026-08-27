import fs from 'node:fs';
import path from 'node:path';
import type { ApiFormat, CliArgs } from '../app/cli-args.js';
import type { ThinkingConfig, ThinkingLevel, ThinkingLevelMap } from '../model/model-client.js';
import { clampThinkingLevel } from '../model/thinking.js';
import { ProjectTrustStore } from './trust.js';

export interface AgentConfig {
  workspaceRoot: string;
  permissionMode: 'yolo' | 'strict' | 'confirm';
  telemetry: 'off' | 'normal' | 'debug';
  trustOverride?: boolean;
  projectTrusted: boolean;
  model: { apiKey?: string; baseUrl: string; model: string; apiFormat: ApiFormat; thinking: ThinkingConfig };
  session: { enabled: boolean; id?: string };
  mcpServers: Array<{ name: string; command: string; args?: string[]; cwd?: string; env?: Record<string, string> }>;
}

export function loadConfig(input: { env: NodeJS.ProcessEnv; args: CliArgs; cwd: string }): AgentConfig {
  const workspaceRoot = path.resolve(input.args.cwd ?? input.cwd);
  const localEnv = loadDotEnv(path.join(workspaceRoot, '.env'));
  const envValue = (name: string): string | undefined => input.env[name] ?? localEnv[name];
  const thinkingMap = parseThinkingMap(envValue('NJU_AGENT_THINKING_LEVEL_MAP'));
  const requestedLevel = parseThinkingLevel(envValue('NJU_AGENT_THINKING_LEVEL'));
  const projectTrusted = input.args.approve === true || (input.args.approve !== false && new ProjectTrustStore().isTrusted(workspaceRoot));
  return {
    workspaceRoot,
    permissionMode: input.args.permissionMode,
    telemetry: input.args.telemetry,
    trustOverride: input.args.approve,
    projectTrusted,
    model: {
      apiKey: envValue(input.args.apiKeyEnv),
      baseUrl: input.args.baseUrl ?? envValue('NJU_AGENT_BASE_URL') ?? 'https://api.openai.com/v1',
      model: input.args.model ?? envValue('NJU_AGENT_MODEL') ?? 'gpt-4.1-mini',
      apiFormat: input.args.apiFormat ?? parseApiFormat(envValue('NJU_AGENT_API_FORMAT')),
      thinking: { level: clampThinkingLevel(requestedLevel, thinkingMap), map: thinkingMap, format: parseThinkingFormat(envValue('NJU_AGENT_THINKING_FORMAT')), budgets: parseThinkingBudgets(envValue('NJU_AGENT_THINKING_BUDGETS')) },
    },
    session: { enabled: !input.args.noSession, id: input.args.session },
    mcpServers: parseMcpServers(envValue('NJU_AGENT_MCP_SERVERS')),
  };
}

function parseMcpServers(value: string | undefined): AgentConfig['mcpServers'] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error('must be a JSON array');
    return parsed.map((item) => {
      if (!item || typeof item !== 'object' || typeof (item as { name?: unknown }).name !== 'string' || typeof (item as { command?: unknown }).command !== 'string') throw new Error('each server needs string name and command');
      const server = item as { name: string; command: string; args?: unknown; cwd?: unknown; env?: unknown };
      if (server.args !== undefined && (!Array.isArray(server.args) || !server.args.every((arg) => typeof arg === 'string'))) throw new Error('args must be strings');
      if (server.env !== undefined && (!server.env || typeof server.env !== 'object' || Array.isArray(server.env) || !Object.values(server.env).every((entry) => typeof entry === 'string'))) throw new Error('env must be an object of strings');
      return { name: server.name, command: server.command, args: server.args as string[] | undefined, cwd: typeof server.cwd === 'string' ? server.cwd : undefined, env: server.env as Record<string, string> | undefined };
    });
  } catch (error) { throw new Error(`Invalid NJU_AGENT_MCP_SERVERS: ${error instanceof Error ? error.message : String(error)}`); }
}

export function parseApiFormat(value: string | undefined): ApiFormat {
  if (!value || value === 'openai-chat') return 'openai-chat';
  if (value === 'openai-responses' || value === 'anthropic') return value;
  throw new Error(`Invalid NJU_AGENT_API_FORMAT: ${value}. Expected openai-chat, openai-responses, or anthropic`);
}

function parseThinkingLevel(value: string | undefined): ThinkingLevel {
  const level = value ?? 'medium';
  if (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level)) return level as ThinkingLevel;
  throw new Error(`Invalid NJU_AGENT_THINKING_LEVEL: ${level}`);
}
function parseThinkingFormat(value: string | undefined): ThinkingConfig['format'] {
  if (!value) return undefined;
  if (value === 'reasoning_effort' || value === 'anthropic-adaptive' || value === 'anthropic-budget') return value;
  throw new Error(`Invalid NJU_AGENT_THINKING_FORMAT: ${value}`);
}
function parseThinkingMap(value: string | undefined): ThinkingLevelMap | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be a JSON object');
    return parsed as ThinkingLevelMap;
  } catch (error) { throw new Error(`Invalid NJU_AGENT_THINKING_LEVEL_MAP: ${error instanceof Error ? error.message : String(error)}`); }
}
function parseThinkingBudgets(value: string | undefined): ThinkingConfig['budgets'] {
  if (!value) return undefined;
  try { return JSON.parse(value) as ThinkingConfig['budgets']; }
  catch (error) { throw new Error(`Invalid NJU_AGENT_THINKING_BUDGETS: ${error instanceof Error ? error.message : String(error)}`); }
}

export function loadDotEnv(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const result: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) result[match[1]] = unquoteEnvValue(match[2].trim());
  }
  return result;
}
function unquoteEnvValue(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
  const hashIndex = value.indexOf(' #');
  return hashIndex >= 0 ? value.slice(0, hashIndex).trimEnd() : value;
}
