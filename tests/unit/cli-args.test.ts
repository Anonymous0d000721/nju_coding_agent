import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/app/cli-args.js';
import { loadConfig, loadDotEnv } from '../../src/shared/config.js';

const cwd = 'D:/repo';

describe('parseArgs', () => {
  it('parses help without requiring auth', () => {
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('parses print prompt and defaults to yolo permission mode', () => {
    const args = parseArgs(['--print', 'fix tests']);
    expect(args.prompt).toBe('fix tests');
    expect(args.permissionMode).toBe('yolo');
  });

  it('accepts an explicit api format', () => {
    const args = parseArgs(['--api-format', 'anthropic']);
    expect(args.apiFormat).toBe('anthropic');
  });

  it('rejects unknown options', () => {
    expect(() => parseArgs(['--wat'])).toThrow('Unknown option');
  });

  it('rejects rpc prompts', () => {
    expect(() => parseArgs(['--mode', 'rpc', 'hello'])).toThrow('does not accept');
  });
});

describe('loadConfig', () => {
  it('loads opt-in MCP server configuration and rejects malformed entries', () => {
    const args = parseArgs([]);
    const config = loadConfig({ cwd: process.cwd(), args, env: { NJU_AGENT_MCP_SERVERS: '[{"name":"demo","command":"node","args":["server.js"]}]' } });
    expect(config.mcpServers).toEqual([{ name: 'demo', command: 'node', args: ['server.js'], cwd: undefined, env: undefined }]);
    expect(() => loadConfig({ cwd: process.cwd(), args, env: { NJU_AGENT_MCP_SERVERS: '{bad' } })).toThrow('Invalid NJU_AGENT_MCP_SERVERS');
  });

  it('loads model config from environment without exposing secrets in shape', () => {
    const args = parseArgs(['--model', 'demo-model', '--no-session']);
    const config = loadConfig({ cwd, args, env: { NJU_AGENT_API_KEY: 'test-key', NJU_AGENT_BASE_URL: 'https://example.test/v1' } });
    expect(config.model.apiKey).toBe('test-key');
    expect(config.model.baseUrl).toBe('https://example.test/v1');
    expect(config.model.model).toBe('demo-model');
    expect(config.session.enabled).toBe(false);
  });

  it('loads .env from workspace when process env is absent', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-agent-env-'));
    await fs.writeFile(path.join(root, '.env'), 'NJU_AGENT_API_KEY=local-key\nNJU_AGENT_MODEL="local-model"\n', 'utf8');

    const config = loadConfig({ cwd: root, args: parseArgs([]), env: {} });

    expect(config.model.apiKey).toBe('local-key');
    expect(config.model.model).toBe('local-model');
  });
});


describe('loadDotEnv', () => {
  it('parses comments, quotes, and inline comments', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nju-agent-dotenv-'));
    const envPath = path.join(root, '.env');
    await fs.writeFile(envPath, '# comment\nA=one # comment\nB="two"\nC=three\n', 'utf8');

    expect(loadDotEnv(envPath)).toEqual({ A: 'one', B: 'two', C: 'three' });
  });
});