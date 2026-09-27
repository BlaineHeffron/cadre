export function piMcpToolName(server, tool) {
  return `mcp__${String(server || '').trim()}__${String(tool || '').trim()}`;
}

export function registerPiMcpTools({ pi, server, client, tools, typeUnsafe, registeredNames }) {
  for (const tool of tools || []) {
    const exposedName = piMcpToolName(server, tool.name);
    if (registeredNames.has(exposedName)) continue;
    registeredNames.add(exposedName);
    pi.registerTool({
      name: exposedName,
      label: tool.name,
      description: tool.description || `Call ${tool.name} on MCP server ${server}.`,
      parameters: typeUnsafe(tool.inputSchema || { type: 'object', additionalProperties: true }),
      async execute(_id, args, signal) {
        const result = await client.callTool(
          { name: tool.name, arguments: args || {} },
          undefined,
          { signal, timeout: 60000 },
        );
        return { ...result, details: { server, tool: tool.name } };
      },
    });
  }
}
