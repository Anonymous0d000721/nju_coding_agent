// Minimal user-plugin example. Copy this file to .nju-agent/plugins/ and adapt it.
export default {
  id: 'nju-mcp-adaptor',
  version: '0.1.0',
  description: 'Expose a local, pre-declared MCP-style manifest as a safe read-only tool.',
  tools: [{
    name: 'nju_mcp_manifest_info',
    description: 'Return the names of tools declared in a local manifest supplied by the caller.',
    risk: 'read',
    readonly: true,
    parameters: {
      type: 'object',
      properties: { manifest: { type: 'object' } },
      required: ['manifest'],
      additionalProperties: false,
    },
    handler: (args) => {
      const manifest = args;
      const tools = manifest && typeof manifest === 'object' && Array.isArray(manifest.tools) ? manifest.tools : [];
      return { tools: tools.filter((tool) => tool && typeof tool.name === 'string').map((tool) => tool.name) };
    },
  }],
};
