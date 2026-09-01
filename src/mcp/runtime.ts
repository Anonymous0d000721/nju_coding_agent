import { diffCatalogs, McpManager, safeMcpName, type McpToolChange, type McpTransport } from './client.js';

export interface McpRuntimeServer {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export type McpTransportFactory = (server: McpRuntimeServer) => McpTransport | Promise<McpTransport>;

export interface McpSyncResult {
  changes: McpToolChange[];
  failures: Array<{ server: string; error: Error }>;
  connected: string[];
  reloaded: string[];
  disconnected: string[];
}

/** Owns MCP connections for one application process so reload can compare live catalogs. */
export class McpRuntime {
  readonly manager: McpManager;

  constructor(timeoutMs?: number) {
    this.manager = new McpManager(timeoutMs);
  }

  async reload(configured: McpRuntimeServer[], createTransport: McpTransportFactory): Promise<McpSyncResult> {
    return this.sync(configured, createTransport, true);
  }

  async sync(configured: McpRuntimeServer[], createTransport: McpTransportFactory, reload = false): Promise<McpSyncResult> {
    const before = this.manager.catalogSnapshot().tools;
    const failures: McpSyncResult['failures'] = [];
    const connected: string[] = [];
    const reloaded: string[] = [];
    const disconnected: string[] = [];
    const configuredNames = new Set(configured.map((server) => safeMcpName(server.name)));

    if (reload) {
      for (const name of this.manager.serverNames()) {
        if (configuredNames.has(name)) continue;
        try {
          await this.manager.disconnect(name);
          disconnected.push(name);
        } catch (error) {
          disconnected.push(name);
          failures.push({ server: name, error: asError(error) });
        }
      }
    }

    for (const server of configured) {
      try {
        if (reload && this.manager.hasServer(server.name)) {
          await this.manager.reload(server.name, await createTransport(server));
          reloaded.push(safeMcpName(server.name));
        } else if (!this.manager.hasServer(server.name)) {
          await this.manager.connect(server.name, await createTransport(server));
          connected.push(safeMcpName(server.name));
        }
      } catch (error) {
        failures.push({ server: server.name, error: asError(error) });
      }
    }

    const changes = diffCatalogs(before, this.manager.catalogSnapshot().tools);
    if (reload) {
      if (failures.length > 0) this.manager.markReloadFailed(new Error(failures.map((failure) => `${failure.server}: ${failure.error.message}`).join('; ')));
      else this.manager.markReloadApplied(changes);
    }
    return { changes, failures, connected, reloaded, disconnected };
  }

  async close(): Promise<void> {
    await this.manager.disconnectAll();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
