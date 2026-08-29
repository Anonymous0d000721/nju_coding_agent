import type { AgentRunResult } from '../agent/types.js';
import type { ToolDefinition } from '../tools/types.js';

export type ContextPriority = 'stable' | 'project' | 'memory' | 'history' | 'runtime';
export type ContextLabel = 'memory' | 'project_instruction' | 'skill_catalog' | 'summary' | 'runtime_note';

export interface ContextContribution {
  id: string;
  priority: ContextPriority;
  label: ContextLabel;
  content: string;
  source: { plugin: string; paths?: string[]; entryIds?: string[] };
  trusted: boolean;
}

export interface HarnessContext {
  workspaceRoot: string;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface HarnessPlugin {
  readonly id: string;
  readonly version: string;
  beforeContextBuild?(context: HarnessContext): Promise<ContextContribution[]> | ContextContribution[];
  afterRun?(context: HarnessContext, result: AgentRunResult): Promise<void> | void;
  tools?(): ToolDefinition[];
}

export interface HarnessDiagnostic {
  plugin: string;
  phase: 'before_context_build' | 'after_run';
  message: string;
}

const PRIORITY_ORDER: Record<ContextPriority, number> = {
  stable: 0,
  project: 1,
  memory: 2,
  history: 3,
  runtime: 4,
};

/** Runs optional context plugins without allowing one failed plugin to stop the agent. */
export class HarnessPluginHost {
  private readonly plugins: HarnessPlugin[];

  constructor(plugins: HarnessPlugin[] = []) {
    const ids = new Set<string>();
    for (const plugin of plugins) {
      if (ids.has(plugin.id)) throw new Error(`Duplicate harness plugin: ${plugin.id}`);
      ids.add(plugin.id);
    }
    this.plugins = [...plugins].sort((left, right) => left.id.localeCompare(right.id));
  }

  toolDefinitions(): ToolDefinition[] {
    return this.plugins.flatMap((plugin) => plugin.tools?.() ?? []);
  }

  async contributions(context: HarnessContext, nativeContributions: ContextContribution[] = []): Promise<{ contributions: ContextContribution[]; diagnostics: HarnessDiagnostic[] }> {
    const contributions: ContextContribution[] = [...nativeContributions];
    const diagnostics: HarnessDiagnostic[] = [];
    for (const plugin of this.plugins) {
      if (!plugin.beforeContextBuild) continue;
      try {
        for (const contribution of await plugin.beforeContextBuild(context)) {
          if (!contribution.content.trim()) continue;
          contributions.push(contribution);
        }
      } catch (error) {
        diagnostics.push({ plugin: plugin.id, phase: 'before_context_build', message: errorMessage(error) });
      }
    }
    contributions.sort((left, right) => PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] || left.id.localeCompare(right.id));
    return { contributions, diagnostics };
  }

  async afterRun(context: HarnessContext, result: AgentRunResult): Promise<HarnessDiagnostic[]> {
    const diagnostics: HarnessDiagnostic[] = [];
    for (const plugin of this.plugins) {
      if (!plugin.afterRun) continue;
      try {
        await plugin.afterRun(context, result);
      } catch (error) {
        diagnostics.push({ plugin: plugin.id, phase: 'after_run', message: errorMessage(error) });
      }
    }
    return diagnostics;
  }
}

export function createNativeContribution(id: string, priority: ContextPriority, label: Extract<ContextLabel, 'project_instruction' | 'skill_catalog'>, content: string, paths: string[] = []): ContextContribution {
  return { id, priority, label, content, source: { plugin: 'native', paths }, trusted: true };
}

export function renderContributions(contributions: ContextContribution[]): string {
  return contributions.map((contribution) => {
    const source = contribution.source.paths?.join(', ') ?? contribution.source.plugin;
    return `[${contribution.label}; source: ${source}; lower priority than host policy]\n${contribution.content}`;
  }).join('\n\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
