import fs from 'node:fs';
import path from 'node:path';
import type { CliArgs } from '../app/cli-args.js';

export interface AgentConfig {
  workspaceRoot: string;
  permissionMode: 'yolo' | 'strict' | 'confirm';
  telemetry: 'off' | 'normal' | 'debug';
  trustOverride?: boolean;
  model: {
    apiKey?: string;
    baseUrl: string;
    model: string;
  };
  session: {
    enabled: boolean;
    id?: string;
  };
}

export function loadConfig(input: { env: NodeJS.ProcessEnv; args: CliArgs; cwd: string }): AgentConfig {
  const workspaceRoot = path.resolve(input.args.cwd ?? input.cwd);
  const localEnv = loadDotEnv(path.join(workspaceRoot, '.env'));
  const envValue = (name: string): string | undefined => input.env[name] ?? localEnv[name];
  const apiKey = envValue(input.args.apiKeyEnv);
  return {
    workspaceRoot,
    permissionMode: input.args.permissionMode,
    telemetry: input.args.telemetry,
    trustOverride: input.args.approve,
    model: {
      apiKey,
      baseUrl: input.args.baseUrl ?? envValue('NJU_AGENT_BASE_URL') ?? 'https://api.openai.com/v1',
      model: input.args.model ?? envValue('NJU_AGENT_MODEL') ?? 'gpt-4.1-mini',
    },
    session: {
      enabled: !input.args.noSession,
      id: input.args.session,
    },
  };
}

export function loadDotEnv(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const result: Record<string, string> = {};
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    result[match[1]] = unquoteEnvValue(match[2].trim());
  }
  return result;
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
  }
  const hashIndex = value.indexOf(' #');
  return hashIndex >= 0 ? value.slice(0, hashIndex).trimEnd() : value;
}