import { config } from '../../config.mjs';
import { buildInternalBypassHeaders } from '../platform/auth.mjs';
import { getProtocolSessionProvider } from '../sessions/protocol-session-registry.mjs';
import { buildInProcessFastifyRequest } from './in-process-mcp.mjs';
import { notifyAgentSessionDeleted } from '../agent/session-delete-events.mjs';

function authHeaders() {
  return config.auth.token ? buildInternalBypassHeaders() : {};
}

async function injectJson(app, options) {
  const res = await app.inject({
    ...options,
    headers: {
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });

  let payload = null;
  try {
    payload = res.body ? JSON.parse(res.body) : null;
  } catch {
    payload = null;
  }

  return { res, payload };
}

function buildAdapter({ kind, detailPath, inputPath }) {
  return {
    kind,
    async listSessions(app) {
      const { res, payload } = await injectJson(app, {
        method: 'GET',
        url: `/api/${kind}/sessions`,
      });

      if (res.statusCode >= 400) {
        throw new Error(payload?.error || `Session listing failed for ${kind}`);
      }

      return Array.isArray(payload?.sessions) ? payload.sessions : [];
    },

    async createSession(app, { sessionId, initialPrompt, workDir, args, model, provider, thinkingLevel, displayName, mcpProfile, mcpServers, codexPlugins, promptProfile, structured, sandbox, authContext } = {}) {
      if (authContext) {
        const request = buildInProcessFastifyRequest({ app, buildHeaders: authHeaders });
        try {
          return await request(`/api/${kind}/sessions`, {
            method: 'POST',
            body: { sessionId, initialPrompt, workDir, args, model, provider, thinkingLevel, displayName, mcpProfile, mcpServers, codexPlugins, promptProfile, structured, sandbox },
            authContext,
          });
        } catch (error) {
          error.code ||= error.payload?.code || null;
          throw error;
        }
      }
      const { res, payload } = await injectJson(app, {
        method: 'POST',
        url: `/api/${kind}/sessions`,
        payload: { sessionId, initialPrompt, workDir, args, model, provider, thinkingLevel, displayName, mcpProfile, mcpServers, codexPlugins, promptProfile, structured, sandbox },
      });

      if (res.statusCode >= 400) {
        const error = new Error(payload?.error || `Session creation failed for ${kind}`);
        error.statusCode = res.statusCode;
        error.code = payload?.code || null;
        error.payload = payload || null;
        throw error;
      }

      return payload;
    },

    async getSession(app, sessionId) {
      const { res, payload } = await injectJson(app, {
        method: 'GET',
        url: detailPath(sessionId),
      });

      if (res.statusCode >= 400) {
        const err = new Error(payload?.error || `Session lookup failed for ${kind}:${sessionId}`);
        err.statusCode = res.statusCode;
        err.code = payload?.code || null;
        err.payload = payload || null;
        throw err;
      }

      if (payload?.sessionEnded || payload?.code === 'session_not_found' || payload?.state?.status === 'ended') {
        const err = new Error(payload?.error || `Session ended: ${kind}:${sessionId}`);
        err.statusCode = 404;
        err.code = payload?.code || 'session_not_found';
        err.payload = payload || null;
        throw err;
      }

      return payload;
    },

    async deleteSession(app, sessionId) {
      const { res, payload } = await injectJson(app, {
        method: 'DELETE',
        url: detailPath(sessionId),
      });

      if (res.statusCode >= 400) {
        const err = new Error(payload?.error || `Session deletion failed for ${kind}:${sessionId}`);
        err.statusCode = res.statusCode;
        err.code = payload?.code || null;
        err.payload = payload || null;
        throw err;
      }
      if (payload?.ok !== true || !['terminated', 'already_gone'].includes(payload?.status)) {
        const err = new Error(`Session deletion returned an invalid terminal result for ${kind}:${sessionId}`);
        err.statusCode = 502;
        err.code = 'invalid_termination_result';
        err.payload = payload || null;
        throw err;
      }

      return payload;
    },

    async captureSession(app, sessionId) {
      const session = await this.getSession(app, sessionId);
      return typeof session.content === 'string' ? session.content : '';
    },

    async injectText(app, sessionId, text) {
      const deadlineAt = Date.now() + config.agentBus.injectDeadlineMs;
      const { res, payload } = await injectJson(app, {
        method: 'POST',
        url: inputPath(sessionId),
        payload: { text, enter: true, source: 'agent_bus', deadlineAt },
      });
      if (res.statusCode >= 400) {
        const err = new Error(payload?.error || `Session injection failed for ${kind}:${sessionId}`);
        err.statusCode = res.statusCode;
        err.code = payload?.code || null;
        err.payload = payload || null;
        throw err;
      }
      return payload || { ok: true };
    },

    async clearSession(app, sessionId) {
      const { res, payload } = await injectJson(app, {
        method: 'POST',
        url: `/api/${kind}/sessions/${encodeURIComponent(sessionId)}/clear`,
      });

      if (res.statusCode >= 400) {
        const err = new Error(payload?.error || `Session clear failed for ${kind}:${sessionId}`);
        err.statusCode = res.statusCode;
        err.code = payload?.code || null;
        err.payload = payload || null;
        err.clearUnsafe = payload?.code === 'unsafe_session_state';
        throw err;
      }

      return payload || { ok: true };
    },

    async injectEnvelope(app, sessionId, envelopeText, opts) {
      return this.injectText(app, sessionId, envelopeText, opts);
    },

    async injectStartupText(app, sessionId, text) {
      const deadlineAt = Date.now() + config.agentBus.injectDeadlineMs;
      const { res, payload } = await injectJson(app, {
        method: 'POST',
        url: `/api/${kind}/sessions/${encodeURIComponent(sessionId)}/startup-input`,
        payload: { text, enter: true, deadlineAt },
      });

      if (res.statusCode >= 400) {
        const err = new Error(payload?.error || `Startup injection failed for ${kind}:${sessionId}`);
        err.statusCode = res.statusCode;
        err.code = payload?.code || null;
        err.payload = payload || null;
        throw err;
      }

      return payload || { ok: true };
    },
  };
}

function buildProtocolAdapter({ kind, detailPath, inputPath }) {
  const fallback = buildAdapter({ kind, detailPath, inputPath });
  function binding() {
    return getProtocolSessionProvider(kind);
  }
  function projected(session) {
    const current = binding();
    return current?.project ? current.project(session) : session;
  }
  return {
    ...fallback,
    async listSessions(app) {
      const current = binding();
      return current ? current.service.list().map(projected) : fallback.listSessions(app);
    },
    async getSession(app, sessionId) {
      const current = binding();
      if (!current) return fallback.getSession(app, sessionId);
      const session = current.service.get(sessionId);
      if (!session || ['ended', 'interrupted'].includes(session.lifecycle)) {
        const error = new Error(`Session ended: ${kind}:${sessionId}`);
        error.statusCode = 404;
        error.code = 'session_not_found';
        throw error;
      }
      return projected(session);
    },
    async deleteSession(app, sessionId) {
      const current = binding();
      if (!current) return fallback.deleteSession(app, sessionId);
      const result = await current.service.terminate(sessionId, { reason: 'Agent Bus terminated session' });
      if (result.ok) await notifyAgentSessionDeleted({ kind, sessionId });
      return result;
    },
    async captureSession(app, sessionId) {
      const session = await this.getSession(app, sessionId);
      return typeof session.content === 'string' ? session.content : '';
    },
    async injectText(app, sessionId, inputText, { deliveryId } = {}) {
      const current = binding();
      if (!current) return fallback.injectText(app, sessionId, inputText, { deliveryId });
      if (current.service.get(sessionId)?.taskId) {
        throw Object.assign(new Error('Managed task input requires task_send'), { code: 'task_input_required', statusCode: 409 });
      }
      const turn = await current.service.prompt(sessionId, {
        blocks: [{ type: 'text', text: String(inputText || '') }],
        idempotencyKey: deliveryId ? `agent-bus:${deliveryId}` : `agent-bus:${Date.now()}:${Math.random().toString(16).slice(2)}`,
        source: 'agent_bus',
      });
      return { ok: true, state: 'sent', turnId: turn.turnId };
    },
    async injectEnvelope(app, sessionId, envelopeText, opts) {
      return this.injectText(app, sessionId, envelopeText, opts);
    },
    async injectStartupText(app, sessionId, inputText) {
      return this.injectText(app, sessionId, inputText);
    },
  };
}

export function createAgentAdapters() {
  return {
    claude: buildAdapter({
      kind: 'claude',
      detailPath: (sessionId) => `/api/claude/sessions/${encodeURIComponent(sessionId)}`,
      inputPath: (sessionId) => `/api/claude/sessions/${encodeURIComponent(sessionId)}/input`,
    }),
    codex: buildAdapter({
      kind: 'codex',
      detailPath: (sessionId) => `/api/codex/sessions/${encodeURIComponent(sessionId)}`,
      inputPath: (sessionId) => `/api/codex/sessions/${encodeURIComponent(sessionId)}/input`,
    }),
    pi: buildAdapter({
      kind: 'pi',
      detailPath: (sessionId) => `/api/pi/sessions/${encodeURIComponent(sessionId)}`,
      inputPath: (sessionId) => `/api/pi/sessions/${encodeURIComponent(sessionId)}/input`,
    }),
    // DeepSeek is attachable to the solo-session thread Fleet creates for every
    // interactive session, but is omitted from collaboration model catalogs.
    deepseek: buildProtocolAdapter({
      kind: 'deepseek',
      detailPath: (sessionId) => `/api/deepseek/sessions/${encodeURIComponent(sessionId)}`,
      inputPath: (sessionId) => `/api/deepseek/sessions/${encodeURIComponent(sessionId)}/input`,
    }),
    'codex-app-server': buildProtocolAdapter({
      kind: 'codex-app-server',
      detailPath: (sessionId) => `/api/codex-app-server/sessions/${encodeURIComponent(sessionId)}`,
      inputPath: (sessionId) => `/api/codex-app-server/sessions/${encodeURIComponent(sessionId)}/input`,
    }),
  };
}
