import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { generateImage } from '../modules/integrations/image-generation.mjs';

export function createImageGenServer(generate = generateImage) {
  const server = new McpServer({ name: 'cadre-image-gen', version: '1.0.0' });
  server.registerTool('generate_image', {
    description: 'Generate an image using subscriptions: ChatGPT via Codex, Google Nano Banana 2 via local CLIProxyAPI; xAI via Grok Build image_gen. Saves to the session generated-images directory with output_path confined to that directory.',
    inputSchema: {
      provider: z.enum(['openai', 'google', 'xai']), prompt: z.string().min(1),
      output_path: z.string().min(1).optional(),
      aspect_ratio: z.string().min(1).optional().describe('Provider-supported ratio such as 1:1, 16:9, or 9:16. OpenAI uses a prompt hint and verifies the output ratio.'),
      size: z.string().min(1).optional().describe('Google only: 512, 1K, 2K, or 4K. Other subscription tools expose no size control.'),
      background: z.enum(['transparent', 'opaque']).optional().describe('Transparent is supported only by OpenAI and requires PNG alpha output.'),
    },
  }, async (input) => {
    try {
      const result = await generate(input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createImageGenServer().connect(new StdioServerTransport());
}
