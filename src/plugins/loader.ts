import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ToolDefinition } from '../tools/types.js';
import { normalizeRelative, resolveWorkspacePath } from '../tools/path-guard.js';
import type { LoadedUserPlugin, PluginLoadDiagnostic, PluginTrustNotice, UserPlugin, UserPluginLoadReport, UserPluginModule } from './types.js';

const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOOL_NAME = /^[a-z0-9][a-z0-9_]{0,63}$/;
const VERSIONS = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FORBIDDEN_SCHEMA_KEYS = /^(?:command|cwd|env|exec|executable|headers?|network|shell|token|secret|password|credential|authorization|url)$/i;
const FORBIDDEN_SCHEMA_FEATURES = new Set(['$ref', 'allOf', 'anyOf', 'not', 'patternProperties', 'unevaluatedProperties']);

export async function loadUserPlugins(workspaceRoot: string, trusted: boolean, reload = false): Promise<LoadedUserPlugin[]> {
  return (await loadUserPluginReport(workspaceRoot, trusted, reload)).loaded;
}

export async function loadUserPluginReport(workspaceRoot: string, trusted: boolean, reload = false): Promise<UserPluginLoadReport> {
  if (!trusted) {
    return {
      loaded: [],
      diagnostics: [{ code: 'untrusted_workspace', message: 'User plugins were not loaded because the workspace is not trusted.', recoverable: true }],
      trustNotices: [],
    };
  }

  const directory = (await resolveWorkspacePath(workspaceRoot, '.nju-agent/plugins')).absolutePath;
  let files: string[];
  try {
    files = (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.(?:mjs|js|cjs)$/.test(entry.name))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { loaded: [], diagnostics: [], trustNotices: [] };
    throw error;
  }

  const loaded: LoadedUserPlugin[] = [];
  const diagnostics: PluginLoadDiagnostic[] = [];
  const trustNotices: PluginTrustNotice[] = [];
  const ids = new Map<string, { version?: string; source: string }>();
  const toolOwners = new Map<string, string>();
  for (const file of files) {
    const relative = normalizeRelative(path.relative(workspaceRoot, file));
    let safeFile: string;
    try {
      safeFile = (await resolveWorkspacePath(workspaceRoot, relative)).absolutePath;
    } catch (error) {
      diagnostics.push(diagnostic('load_failed', messageOf(error), file));
      continue;
    }
    try {
      const source = await fs.readFile(safeFile);
      const module = await import(`${pathToFileUrl(safeFile)}${reload ? `?reload=${Date.now()}-${Math.random()}` : ''}`) as UserPluginModule;
      const candidate = module.default ?? module.plugin;
      const plugin = typeof candidate === 'function' ? await candidate() : candidate;
      validatePlugin(plugin, safeFile);
      const digest = createHash('sha256').update(source).digest('hex');
      const previous = ids.get(plugin.id);
      if (previous) {
        const code = previous.version !== plugin.version ? 'version_conflict' : 'invalid_manifest';
        diagnostics.push(diagnostic(code, `Plugin id '${plugin.id}' conflicts with ${previous.source}${previous.version ? ` (version ${previous.version})` : ''}.`, safeFile, plugin.id));
        continue;
      }
      const conflictingTool = plugin.tools.find((tool) => toolOwners.has(tool.name));
      if (conflictingTool) {
        diagnostics.push(diagnostic('tool_name_conflict', `Plugin '${plugin.id}' tool '${conflictingTool.name}' conflicts with ${toolOwners.get(conflictingTool.name)}.`, safeFile, plugin.id));
        continue;
      }
      ids.set(plugin.id, { version: plugin.version, source: safeFile });
      for (const tool of plugin.tools) toolOwners.set(tool.name, `${plugin.id}:${tool.name}`);
      loaded.push({ ...plugin, source: safeFile, sha256: digest });
      trustNotices.push({ source: relative, sha256: digest, message: `Loaded trusted user plugin ${plugin.id}${plugin.version ? `@${plugin.version}` : ''}; review this hash if the file changes.` });
    } catch (error) {
      diagnostics.push(diagnostic(isValidationError(error) ? 'invalid_manifest' : 'load_failed', messageOf(error), safeFile));
    }
  }
  return { loaded, diagnostics, trustNotices };
}

export function pluginTools(plugins: LoadedUserPlugin[]): ToolDefinition[] {
  return plugins.flatMap((plugin) => plugin.tools);
}

export function validateUserPlugin(plugin: UserPlugin | undefined, source = '<plugin>'): asserts plugin is UserPlugin {
  validatePlugin(plugin, source);
}

function validatePlugin(plugin: UserPlugin | undefined, source: string): asserts plugin is UserPlugin {
  if (!plugin || typeof plugin !== 'object' || !PLUGIN_ID.test(plugin.id)) throw invalid(`Invalid user plugin in ${source}: id must match [a-z0-9][a-z0-9._-]{0,63}`);
  if (plugin.version !== undefined && (typeof plugin.version !== 'string' || !VERSIONS.test(plugin.version))) throw invalid(`Invalid user plugin ${plugin.id}: version must be semver-like x.y.z`);
  if (plugin.description !== undefined && (typeof plugin.description !== 'string' || plugin.description.length > 2_000)) throw invalid(`Invalid user plugin ${plugin.id}: description must be at most 2000 characters`);
  if (!Array.isArray(plugin.tools)) throw invalid(`Invalid user plugin ${plugin.id}: tools must be an array`);
  const names = new Set<string>();
  for (const tool of plugin.tools) {
    if (!tool || typeof tool !== 'object' || !TOOL_NAME.test(tool.name) || names.has(tool.name)) throw invalid(`Invalid tool in user plugin ${plugin.id}: name must be unique lowercase snake_case`);
    names.add(tool.name);
    if (typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > 2_000) throw invalid(`Invalid tool ${plugin.id}:${tool.name}: description is required and bounded`);
    if (!['read', 'write', 'shell', 'external'].includes(tool.risk)) throw invalid(`Invalid tool ${plugin.id}:${tool.name}: unsupported risk`);
    if (typeof tool.readonly !== 'boolean' || (tool.risk === 'read' ? !tool.readonly : tool.readonly)) throw invalid(`Invalid tool ${plugin.id}:${tool.name}: readonly must match risk`);
    if (!tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) throw invalid(`Invalid tool ${plugin.id}:${tool.name}: parameters must be an object schema`);
    validatePluginSchema(tool.parameters as Record<string, unknown>, `${plugin.id}:${tool.name}`);
    if (typeof tool.handler !== 'function') throw invalid(`Invalid tool ${plugin.id}:${tool.name}: handler is required`);
    if (tool.timeoutMs !== undefined && (!Number.isInteger(tool.timeoutMs) || tool.timeoutMs < 1 || tool.timeoutMs > 300_000)) throw invalid(`Invalid tool ${plugin.id}:${tool.name}: timeoutMs must be 1..300000`);
  }
}

function validatePluginSchema(schema: Record<string, unknown>, label: string): void {
  if (schema.type !== 'object') throw invalid(`Invalid schema ${label}: root type must be object`);
  if (schema.properties !== undefined && !isRecord(schema.properties)) throw invalid(`Invalid schema ${label}: properties must be an object`);
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw invalid(`Invalid schema ${label}: additionalProperties must be false`);
  for (const key of Object.keys(schema)) {
    if (FORBIDDEN_SCHEMA_FEATURES.has(key)) throw invalid(`Invalid schema ${label}: ${key} is not allowed for plugins`);
  }
  const walk = (value: unknown, location: string): void => {
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_SCHEMA_KEYS.test(key)) throw invalid(`Invalid schema ${label}: dangerous field '${location}.${key}'`);
      if (FORBIDDEN_SCHEMA_FEATURES.has(key)) throw invalid(`Invalid schema ${label}: ${key} is not allowed for plugins`);
      if (isRecord(child)) walk(child, `${location}.${key}`);
      else if (Array.isArray(child)) child.forEach((item, index) => walk(item, `${location}[${index}]`));
    }
  };
  walk(schema.properties ?? {}, `${label}.properties`);
}

function diagnostic(code: PluginLoadDiagnostic['code'], message: string, source?: string, pluginId?: string): PluginLoadDiagnostic {
  return { code, message, recoverable: true, ...(source ? { source } : {}), ...(pluginId ? { pluginId } : {}) };
}
function invalid(message: string): Error & { pluginValidation: true } { return Object.assign(new Error(message), { pluginValidation: true as const }); }
function isValidationError(error: unknown): boolean { return typeof error === 'object' && error !== null && 'pluginValidation' in error; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function pathToFileUrl(file: string): string {
  const normalized = file.replace(/\\/g, '/');
  return `file://${normalized.startsWith('/') ? '' : '/'}${encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}
