# Mock MCP Server

Run from the repository root with an explicit opt-in configuration:

```powershell
$env:NJU_AGENT_MCP_SERVERS='[{"name":"demo","command":"node","args":["examples/mock-mcp-server.mjs"]}]'
npm run dev -- --print "Use the MCP echo tool with hello"
```

The server is local, dependency-free, and exists for tests/demo only.
