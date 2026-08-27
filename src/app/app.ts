import { AgentRunner } from '../agent/runner.js';
import { buildSystemPrompt } from '../agent/system-prompt.js';
import { createModelClient } from '../model/create-client.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { createFileTools } from '../tools/file-tools.js';
import { createShellTool } from '../tools/shell-tool.js';
import { parseArgs } from './cli-args.js';
import { renderHelp, renderRunResult, renderVersion } from './renderer.js';
import { loadConfig } from '../shared/config.js';
import { CliError } from '../shared/errors.js';
import { redact } from '../shared/redact.js';
import { JsonlSessionStore } from '../session/jsonl-store.js';
import { createMessageEntry, createRunEndEntry, createRunStartEntry } from '../session/entries.js';

export interface AppServices {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface AppResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export function createApp(services: AppServices) {
  return {
    async run(): Promise<AppResult> {
      const args = parseArgs(services.argv);

      if (args.help) return { exitCode: 0, stdout: renderHelp() };
      if (args.version) return { exitCode: 0, stdout: renderVersion() };

      const config = loadConfig({ env: services.env, args, cwd: services.cwd });

      if (args.mode === 'rpc') {
        return { exitCode: 1, stderr: 'RPC mode is planned but not implemented yet.\n' };
      }

      const prompt = args.prompt;
      if (!prompt) {
        return {
          exitCode: 0,
          stdout: [
            `nju-agent ${renderVersion().trim()}`,
            `workspace: ${config.workspaceRoot}`,
            `model: ${config.model.model}`,
            `permission: ${config.permissionMode}`,
            '',
            'Interactive agent loop is planned but not implemented yet.',
            'Run `nju-agent --help` for available options.',
            '',
          ].join('\n'),
        };
      }

      if (!config.model.apiKey) {
        return missingAuth(args.mode);
      }

      const registry = new ToolRegistry();
      for (const tool of createFileTools()) registry.register(tool);
      registry.register(createShellTool());
      const sessionStore = config.session.enabled ? new JsonlSessionStore(`${config.workspaceRoot}/.nju-agent`) : undefined;
      const session = sessionStore
        ? (config.session.id
          ? await sessionStore.open(config.session.id)
          : await sessionStore.create({ cwd: config.workspaceRoot, model: config.model.model, appVersion: renderVersion().trim() }))
        : undefined;
      const userMessage = session ? createMessageEntry(session.id, { role: 'user', content: prompt }) : undefined;
      if (session && userMessage) {
        await sessionStore?.append(session.id, userMessage);
        await sessionStore?.append(session.id, createRunStartEntry(session.id, userMessage.id, {
          model: config.model.model,
          permissionMode: config.permissionMode,
        }));
      }
      const runner = new AgentRunner({
        model: createModelClient({ apiFormat: config.model.apiFormat, apiKey: config.model.apiKey, baseUrl: config.model.baseUrl, model: config.model.model }),
        tools: new ToolExecutor(registry, { workspaceRoot: config.workspaceRoot }),
        systemPrompt: buildSystemPrompt(config.workspaceRoot),
        toolDefinitions: registry.definitionsForModel(),
        onMessage: session && sessionStore
          ? async (message) => { await sessionStore.append(session.id, createMessageEntry(session.id, message)); }
          : undefined,
      });

      try {
        const result = await runner.run(prompt, { maxTurns: 8, maxToolCalls: 24 });
        if (session && sessionStore) await sessionStore.append(session.id, createRunEndEntry(session.id, result));
        if (args.mode === 'json') {
          return { exitCode: 0, stdout: `${JSON.stringify({ type: 'run_end', level: 'info', data: result })}\n` };
        }
        return { exitCode: 0, stdout: renderRunResult(result) };
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error), { extraSecrets: [config.model.apiKey] });
        if (args.mode === 'json') {
          return { exitCode: 3, stdout: `${JSON.stringify({ type: 'run_error', level: 'error', data: { message } })}\n` };
        }
        return { exitCode: 3, stderr: `${message}\n` };
      }
    },
  };
}

function missingAuth(mode: 'text' | 'json' | 'rpc'): AppResult {
  const message = 'Missing API key. Set NJU_AGENT_API_KEY, NJU_AGENT_BASE_URL, and NJU_AGENT_MODEL. See .env.example.';
  if (mode === 'json') {
    return { exitCode: 3, stdout: `${JSON.stringify({ type: 'run_error', level: 'error', data: { code: 'missing_auth', message } })}\n` };
  }
  return { exitCode: 3, stderr: `${message}\n` };
}
