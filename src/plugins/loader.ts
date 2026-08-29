import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition } from '../tools/types.js';
import type { UserPlugin, UserPluginModule } from './types.js';

export interface LoadedUserPlugin extends UserPlugin {
  source: string;
}

export async function loadUserPlugins(workspaceRoot: string, trusted: boolean, reload = false): Promise<LoadedUserPlugin[]> {
  if (!trusted) return [];
  const directory = path.join(workspaceRoot, '.nju-agent', 'plugins');
  let files: string[];
  try {
    files = (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.(?:mjs|js|cjs)$/.test(entry.name))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const plugins: LoadedUserPlugin[] = [];
  for (const file of files) {
    const suffix = reload ? `?reload=${Date.now()}-${Math.random()}` : '';
    const module = await import(`${pathToFileUrl(file)}${suffix}`) as UserPluginModule;
    const candidate = module.default ?? module.plugin;
    const plugin = typeof candidate === 'function' ? await candidate() : candidate;
    validatePlugin(plugin, file);
    plugins.push({ ...plugin, source: file });
  }
  return plugins;
}

export function pluginTools(plugins: LoadedUserPlugin[]): ToolDefinition[] {
  return plugins.flatMap((plugin) => plugin.tools);
}

function validatePlugin(plugin: UserPlugin | undefined, source: string): asserts plugin is UserPlugin {
  if (!plugin || typeof plugin !== 'object' || typeof plugin.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(plugin.id)) throw new Error(`Invalid user plugin in ${source}: id must match [a-z0-9][a-z0-9._-]{0,63}`);
  if (!Array.isArray(plugin.tools)) throw new Error(`Invalid user plugin in ${source}: tools must be an array`);
  for (const tool of plugin.tools) {
    if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || typeof tool.handler !== 'function') throw new Error(`Invalid tool in user plugin ${plugin.id}`);
  }
}

function pathToFileUrl(file: string): string {
  const normalized = file.replace(/\\/g, '/');
  return `file://${normalized.startsWith('/') ? '' : '/'}${encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}
