import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { buildInProcessFastifyRequest } from '../modules/agent-bus/in-process-mcp.mjs';
import {
  authPlugin,
  buildInternalBypassHeaders,
  permissionAuthorityForRequest,
  TELEGRAM_OPERATOR_POLICY,
} from '../modules/platform/auth.mjs';
import { TelegramBridgeLoop } from '../modules/telegram/bridge-loop.mjs';
import { TelegramSender } from '../modules/telegram/sender.mjs';

const AUTH = { authToken: 'telegram-authority-operator', bypassToken: 'telegram-authority-internal' };
const CHAT_ID = -100123;
const permissionState = { revision: 5, status: 'blocked', interaction: { kind: 'permission', fingerprint: 'perm-5', options: [{ key: '1' }, { key: '2' }] } };

// Session routes guarded like the real ones while a prompt is blocking.
async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(authPlugin, { token: AUTH.authToken, internalBypassToken: AUTH.bypassToken });
  const answers = [];
  for (const route of ['input', 'keys', 'terminate']) {
    app.post(`/api/claude/sessions/:id/${route}`, async (request, reply) => {
      try {
        const audit = permissionAuthorityForRequest(request, { tool: `tmux.${route}`, risk: 'permission' });
        answers.push({ route, body: request.body, policy: audit.policy });
        return { ok: true };
      } catch (error) {
        return reply.code(error.statusCode).send({ error: error.message, code: error.code });
      }
    });
  }
  await app.ready();
  return { app, answers };
}

async function withBridge(fn) {
  const stateDir = await mkdtemp(join(tmpdir(), 'cadre-telegram-authority-'));
  const { app, answers } = await buildApp();
  try {
    await writeFile(join(stateDir, 'config.env'), `TELEGRAM_BOT_TOKEN="test-token"\nTELEGRAM_CHAT_ID=${CHAT_ID}\n`);
    await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
      'session:s1': { thread_id: 177, session_id: 's1', backend: 'claude' },
    }));
    await writeFile(join(stateDir, 'sent.json'), JSON.stringify({
      s1: { message_id: 902, thread_id: 177, interaction_revision: 5, interaction_kind: 'permission', interaction_fingerprint: 'perm-5' },
    }));
    const loop = new TelegramBridgeLoop({
      stateDir,
      sender: new TelegramSender({ stateDir, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: true }) }) }),
      listSessions: async () => [{ id: 's1', runtime: 'claude', tmuxSession: 'claude-s1', workDir: '/tmp/project', state: permissionState }],
      requestImpl: buildInProcessFastifyRequest({ app, buildHeaders: (options) => buildInternalBypassHeaders({ ...AUTH, ...options }) }),
      logger: { warn() {} },
    });
    await fn({ app, answers, loop });
  } finally {
    await app.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

const textUpdate = (updateId, chatId, text) => ({ update_id: updateId, message: { message_id: 900 + updateId, chat: { id: chatId }, message_thread_id: 177, text } });

describe('telegram operator interaction authority', () => {
  it('lets the configured chat answer a blocking prompt by button and by text', async () => {
    await withBridge(async ({ answers, loop }) => {
      assert.equal(await loop.handleUpdate({
        update_id: 1,
        callback_query: { id: 'cb-1', data: 'answer:2', message: { message_id: 902, chat: { id: CHAT_ID }, message_thread_id: 177, text: 'Allow?' } },
      }), true);
      assert.equal(await loop.handleUpdate(textUpdate(2, CHAT_ID, 'no, use the other path')), true);
      assert.deepEqual(answers, [
        { route: 'keys', body: { keys: '2', expectedRevision: 5, expectedFingerprint: 'perm-5', expectedInteractionKind: 'permission' }, policy: TELEGRAM_OPERATOR_POLICY },
        { route: 'input', body: { text: 'no, use the other path', enter: true, source: 'telegram_answer' }, policy: TELEGRAM_OPERATOR_POLICY },
      ]);
    });
  });

  it('ignores updates from any other chat', async () => {
    await withBridge(async ({ answers, loop }) => {
      assert.equal(await loop.handleUpdate(textUpdate(3, -100999, 'yes')), false);
      assert.equal(loop.lastIgnoredUpdate.reason, 'wrong_chat');
      assert.deepEqual(answers, []);
    });
  });

  it('cannot be claimed over HTTP or used beyond session input and keys', async () => {
    await withBridge(async ({ app, answers }) => {
      const policyHeaders = buildInternalBypassHeaders({ ...AUTH, automationPolicy: TELEGRAM_OPERATOR_POLICY });
      const inject = (route, headers) => app.inject({ method: 'POST', url: `/api/claude/sessions/s1/${route}`, headers, payload: { keys: '1' } });
      assert.equal((await inject('terminate', policyHeaders)).statusCode, 403, 'other session routes');

      const { 'x-cadre-in-process-policy': _nonce, ...withoutNonce } = policyHeaders;
      assert.equal((await inject('keys', withoutNonce)).statusCode, 403, 'the policy name alone');

      const url = await app.listen({ host: '127.0.0.1', port: 0 });
      const external = await fetch(`${url}/api/claude/sessions/s1/keys`, {
        method: 'POST',
        headers: { ...withoutNonce, 'x-cadre-in-process-policy': 'forged', 'content-type': 'application/json' },
        body: JSON.stringify({ keys: '1' }),
      });
      assert.equal(external.status, 403, 'an HTTP client holding the bypass token');
      assert.equal((await external.json()).code, 'permission_authority_required');
      assert.deepEqual(answers, []);
    });
  });
});
