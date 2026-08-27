import type { AgentRunResult } from '../agent/types.js';

export function renderHelp(): string {
  return `nju-agent - a local coding agent\n\nUsage:\n  nju-agent [options] [prompt]\n  nju-agent --print "explain this repo"\n  nju-agent --mode json "explain this repo"\n\nOptions:\n  -h, --help                       Show this help message\n  -v, --version                    Show version\n  -p, --print <prompt>             Run one prompt in human-readable mode\n      --mode <text|json|rpc>       Select run mode (default: text)\n      --json                       Shortcut for --mode json\n      --rpc                        Shortcut for --mode rpc\n      --api-format <format>        openai-chat, openai-responses, or anthropic\n      --model <id>                 Override NJU_AGENT_MODEL\n      --base-url <url>             Override NJU_AGENT_BASE_URL\n      --api-key-env <name>         API key env var (default: NJU_AGENT_API_KEY)\n      --cwd <path>                 Workspace root\n      --session <id>               Resume a session\n      --no-session                 Do not persist this conversation\n      --permission-mode <mode>     yolo, strict, or confirm (default: yolo)\n      --approve                    Trust current workspace for this run\n      --no-approve                 Do not load trust-gated project resources\n      --telemetry <mode>           off, normal, or debug\n\nEnvironment:\n  NJU_AGENT_API_FORMAT             API protocol (openai-chat, openai-responses, anthropic)\n  NJU_AGENT_API_KEY                API key (never pass secrets as CLI args)\n  NJU_AGENT_BASE_URL               OpenAI-compatible base URL\n  NJU_AGENT_MODEL                  Model id\n`;
}

export function renderVersion(): string {
  return '0.1.0\n';
}

export function renderRunResult(result: AgentRunResult): string {
  const lines: string[] = [];
  for (const message of result.messages) {
    if (message.role === 'assistant' && message.content.trim()) {
      lines.push(`assistant: ${message.content.trim()}`);
    }
    if (message.role === 'tool') {
      lines.push(`tool_result ${message.toolCallId ?? '(unknown)'}: ${message.content.trim()}`);
    }
  }
  lines.push('');
  lines.push(`run ended: ${result.stopReason} (${result.turns} turns, ${result.toolCalls} tool calls)`);
  return `${lines.join('\n')}\n`;
}
