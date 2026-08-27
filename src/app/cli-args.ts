import { CliError } from '../shared/errors.js';

export type CliMode = 'text' | 'json' | 'rpc';
export type PermissionMode = 'yolo' | 'strict' | 'confirm';
export type TelemetryMode = 'off' | 'normal' | 'debug';

export interface CliArgs {
  help: boolean;
  version: boolean;
  mode: CliMode;
  prompt?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv: string;
  cwd?: string;
  session?: string;
  noSession: boolean;
  permissionMode: PermissionMode;
  approve?: boolean;
  telemetry: TelemetryMode;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false,
    version: false,
    mode: 'text',
    apiKeyEnv: 'NJU_AGENT_API_KEY',
    noSession: false,
    permissionMode: 'yolo',
    telemetry: 'normal',
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--version':
      case '-v':
        args.version = true;
        break;
      case '--json':
        args.mode = 'json';
        break;
      case '--rpc':
        args.mode = 'rpc';
        break;
      case '--no-session':
        args.noSession = true;
        break;
      case '--approve':
        args.approve = true;
        break;
      case '--no-approve':
        args.approve = false;
        break;
      case '--print':
      case '-p':
        args.mode = 'text';
        args.prompt = requireValue(argv, ++i, arg);
        break;
      case '--mode':
        args.mode = parseChoice(requireValue(argv, ++i, arg), ['text', 'json', 'rpc'], arg);
        break;
      case '--model':
        args.model = requireValue(argv, ++i, arg);
        break;
      case '--base-url':
        args.baseUrl = requireValue(argv, ++i, arg);
        break;
      case '--api-key-env':
        args.apiKeyEnv = requireValue(argv, ++i, arg);
        break;
      case '--cwd':
        args.cwd = requireValue(argv, ++i, arg);
        break;
      case '--session':
        args.session = requireValue(argv, ++i, arg);
        break;
      case '--permission-mode':
        args.permissionMode = parseChoice(requireValue(argv, ++i, arg), ['yolo', 'strict', 'confirm'], arg);
        break;
      case '--telemetry':
        args.telemetry = parseChoice(requireValue(argv, ++i, arg), ['off', 'normal', 'debug'], arg);
        break;
      default:
        if (arg.startsWith('-')) throw new CliError(`Unknown option: ${arg}`, 2);
        positional.push(arg);
    }
  }

  if (args.mode === 'rpc' && (args.prompt || positional.length > 0)) {
    throw new CliError('--mode rpc does not accept a prompt argument.', 2);
  }
  if (!args.prompt && positional.length > 0) args.prompt = positional.join(' ');
  return args;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('-')) throw new CliError(`Missing value for ${flag}`, 2);
  return value;
}

function parseChoice<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new CliError(`Invalid value for ${flag}: ${value}. Expected one of: ${allowed.join(', ')}`, 2);
}