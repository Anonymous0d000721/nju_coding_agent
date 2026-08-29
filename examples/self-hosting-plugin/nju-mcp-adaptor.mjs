import { readFile } from 'node:fs/promises';
import path from 'node:path';

const NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const RISKS = new Set(['read', 'write', 'shell', 'external']);

export default {
  id: 'nju-mcp-adaptor',
  version: '0.2.0',
  description: 'Validate a local MCP-style manifest and expose its declared tool catalog.',
  tools: [{
    name: 'nju_mcp_manifest_info',
    description: 'Read and validate a local MCP-style manifest inside the current workspace.',
    risk: 'read',
    readonly: true,
    parameters: {
      type: 'object',
      properties: { manifestPath: { type: 'string', minLength: 1 } },
      required: ['manifestPath'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const manifestPath = resolveWorkspacePath(context.workspaceRoot, args?.manifestPath);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const tools = validateManifest(manifest);
      return {
        manifestPath: path.relative(context.workspaceRoot, manifestPath),
        version: manifest.version,
        tools: tools.map(({ name, description, risk, readonly, inputSchema }) => ({ name, description, risk, readonly, inputSchema })),
      };
    },
  }],
};

function resolveWorkspacePath(workspaceRoot, candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('manifest_path_required');
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('manifest_outside_workspace');
  return resolved;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest_must_be_object');
  if (manifest.version !== '1') throw new Error('unsupported_manifest_version');
  if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) throw new Error('manifest_tools_required');
  const names = new Set();
  return manifest.tools.map((tool) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw new Error('tool_must_be_object');
    if (typeof tool.name !== 'string' || !NAME_PATTERN.test(tool.name) || names.has(tool.name)) throw new Error(`invalid_tool_name:${tool.name ?? ''}`);
    if (typeof tool.description !== 'string' || !tool.description.trim()) throw new Error(`invalid_tool_description:${tool.name}`);
    if (!RISKS.has(tool.risk) || typeof tool.readonly !== 'boolean') throw new Error(`invalid_tool_policy:${tool.name}`);
    if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || tool.inputSchema.type !== 'object') throw new Error(`invalid_input_schema:${tool.name}`);
    if (tool.endpoint !== undefined || tool.command !== undefined || tool.url !== undefined) throw new Error(`external_execution_forbidden:${tool.name}`);
    names.add(tool.name);
    return tool;
  });
}
