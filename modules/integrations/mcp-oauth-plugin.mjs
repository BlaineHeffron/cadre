/**
 * Operator routes for the MCP OAuth broker.
 *
 * The callback stays behind fleet auth: the operator's browser carries the fleet
 * session cookie through the provider redirect, and the PKCE state check runs on
 * top of that. The capability catalog itself is served by
 * `GET /api/agents/mcp-servers`.
 */

import { config } from '../../config.mjs';
import { getMcpOauthBroker } from './mcp-oauth.mjs';

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function callbackPage(title, detail) {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>`
    + '<body style="font-family:system-ui;padding:2rem;max-width:36rem">'
    + `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`
    + '<p>You can close this tab and return to the fleet console.</p></body>';
}

export async function mcpOauthPlugin(app, opts = {}) {
  const sourceConfig = opts.sourceConfig || config;
  const broker = opts.broker || getMcpOauthBroker(sourceConfig);

  app.get('/api/mcp/oauth', async () => ({
    redirectUri: broker.redirectUri(),
    providers: Object.values(await broker.status().catch(() => ({}))),
  }));

  app.post('/api/mcp/oauth/:provider/start', async (req, reply) => {
    try {
      return await broker.startAuthorization(req.params?.provider);
    } catch (error) {
      return reply.code(error.statusCode || 400).send({ error: error.message });
    }
  });

  app.get('/api/mcp/oauth/callback', async (req, reply) => {
    const { code, state, error: providerError } = req.query || {};
    if (providerError) {
      return reply.code(400).type('text/html').send(callbackPage('Authorization declined', String(providerError)));
    }
    try {
      const result = await broker.completeAuthorization({ code, state });
      return reply.type('text/html').send(callbackPage('Connected', `${result.providerId} is now available to fleet agents.`));
    } catch (error) {
      req.log?.warn?.({ code: 'mcp_oauth_callback_failed' }, 'MCP OAuth callback failed');
      return reply.code(error.statusCode || 400).type('text/html').send(callbackPage('Authorization failed', error.message));
    }
  });

  app.delete('/api/mcp/oauth/:provider', async (req, reply) => {
    try {
      return await broker.disconnect(req.params?.provider);
    } catch (error) {
      return reply.code(error.statusCode || 400).send({ error: error.message });
    }
  });
}
