import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Type } from '@sinclair/typebox';
import { registerPiMcpTools } from './pi-mcp-tool-name.mjs';
import { readEnv } from '../platform/cadre-env.mjs';

const connections = new Map();
const CHILD_ENV_ALLOWLIST = new Set([
  'PATH', 'Path', 'HOME', 'USER', 'USERNAME', 'USERPROFILE', 'SHELL',
  'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'APPDATA',
  'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
]);

function configs() {
  const path = String(readEnv('DUENO_PI_MCP_CONFIG') || '').trim();
  if (!path) throw new Error('DUENO_PI_MCP_CONFIG is required');
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {};
}

function childEnv(config = {}) {
  const inherited = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (typeof process.env[key] === 'string') inherited[key] = process.env[key];
  }
  return { ...inherited, ...(config.env || {}) };
}

async function clientFor(name) {
  if (connections.has(name)) return connections.get(name).client;
  const config = configs()[name];
  if (!config) throw new Error(`Unknown MCP server: ${name}`);
  const transport = typeof config.command === 'string'
    ? new StdioClientTransport({
        command: config.command,
        args: Array.isArray(config.args) ? config.args : [],
        env: childEnv(config),
        ...(config.cwd ? { cwd: config.cwd } : {}),
      })
    : new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers && typeof config.headers === 'object'
          ? { headers: config.headers }
          : undefined,
      });
  const client = new Client({ name: 'dueno-pi', version: '1' });
  await client.connect(transport);
  connections.set(name, { client, transport });
  return client;
}

function textResult(text, details = {}) {
  return { content: [{ type: 'text', text }], details };
}

export default async function duenoPiMcp(pi) {
  const registeredNames = new Set(['mcp_servers', 'mcp_discover', 'mcp_call']);
  for (const server of Object.keys(configs())) {
    try {
      const client = await clientFor(server);
      const discovered = await client.listTools(undefined, { timeout: 30000 });
      registerPiMcpTools({
        pi,
        server,
        client,
        tools: discovered.tools,
        typeUnsafe: Type.Unsafe,
        registeredNames,
      });
    } catch {
      // Generic discovery/call tools remain available for transient servers.
    }
  }

  pi.registerTool({
    name: 'mcp_servers',
    label: 'MCP Servers',
    description: 'List MCP servers enabled for this Cadre session.',
    parameters: Type.Object({}),
    async execute() {
      const servers = Object.entries(configs()).map(([name, value]) => ({
        name,
        transport: typeof value.command === 'string' ? 'stdio' : 'http',
      }));
      return textResult(JSON.stringify({ servers }, null, 2), { servers });
    },
  });

  pi.registerTool({
    name: 'mcp_discover',
    label: 'MCP Discover',
    description: 'List tools exposed by one enabled MCP server.',
    parameters: Type.Object({ server: Type.String() }),
    async execute(_id, { server }, signal) {
      const client = await clientFor(server);
      const result = await client.listTools(undefined, { signal, timeout: 30000 });
      return textResult(JSON.stringify(result.tools || [], null, 2), { server, toolCount: result.tools?.length || 0 });
    },
  });

  pi.registerTool({
    name: 'mcp_call',
    label: 'MCP Call',
    description: 'Call a tool on one enabled MCP server. Use mcp_discover first.',
    parameters: Type.Object({
      server: Type.String(),
      tool: Type.String(),
      args: Type.Optional(Type.Object({}, { additionalProperties: true })),
    }),
    async execute(_id, { server, tool, args }, signal) {
      const client = await clientFor(server);
      const result = await client.callTool(
        { name: tool, arguments: args || {} },
        undefined,
        { signal, timeout: 60000 },
      );
      return { ...result, details: { server, tool } };
    },
  });

  pi.on('session_shutdown', async () => {
    await Promise.all([...connections.values()].map(async ({ client, transport }) => {
      await client.close().catch(() => transport.close?.());
    }));
    connections.clear();
  });
}
