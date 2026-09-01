import type { ToolDefinition } from '../tools/types.js';

export interface UserPlugin {
  id: string;
  version?: string;
  description?: string;
  tools: ToolDefinition[];
}

export interface UserPluginModule {
  default?: UserPlugin | (() => UserPlugin | Promise<UserPlugin>);
  plugin?: UserPlugin | (() => UserPlugin | Promise<UserPlugin>);
}

export interface PluginLoadDiagnostic {
  source?: string;
  pluginId?: string;
  code: 'untrusted_workspace' | 'load_failed' | 'invalid_manifest' | 'version_conflict' | 'tool_name_conflict';
  message: string;
  recoverable: true;
}

export interface PluginTrustNotice {
  source: string;
  sha256: string;
  message: string;
}

export interface UserPluginLoadReport {
  loaded: LoadedUserPlugin[];
  diagnostics: PluginLoadDiagnostic[];
  trustNotices: PluginTrustNotice[];
}

export interface LoadedUserPlugin extends UserPlugin {
  source: string;
  sha256: string;
}
