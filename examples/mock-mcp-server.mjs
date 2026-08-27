import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'nju-demo', version: '1.0.0' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, risk: 'read' }] };
  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: String(request.params?.arguments?.text ?? '') }] };
  else { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })}\n`); return; }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
});
