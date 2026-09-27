import { createInterface } from 'node:readline';

const tools = ['keyword_volume', 'register_email', 'verify_email'].map((name) => ({
  name,
  inputSchema: { type: 'object' },
}));

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (!Object.hasOwn(request, 'id')) return;
  if (request.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'stdio-tools-fixture', version: '1' },
      },
    })}\n`);
    return;
  }
  if (request.method === 'tools/list') {
    process.stdout.write(`${JSON.stringify(process.argv.includes('--fail-list')
      ? { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'fixture failure' } }
      : { jsonrpc: '2.0', id: request.id, result: { tools } })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`);
});
