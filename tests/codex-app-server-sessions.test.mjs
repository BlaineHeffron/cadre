import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createCodexAppServerSessionProvider } from '../modules/sessions/codex-app-server-sessions.mjs';
import { CodexAppServerTransport } from '../modules/agent/codex-app-server-transport.mjs';
import { getProtocolSessionProvider } from '../modules/sessions/protocol-session-registry.mjs';
import { headroomLaunchOverrides } from '../modules/agent/headroom.mjs';
const fixture = resolve('tests/fixtures/codex-app-server/provider.mjs');
const smokeScript = resolve('scripts/smoke-codex-app-server.mjs');
const evidence = { source: 'subprocess_fixture', cliVersion: 'fixture/0.153.4', steerExpectedTurnId: true,
  methods: ['initialize', 'thread/start', 'thread/read', 'thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt', 'mcpServerStatus/list'] };
const mcpCatalog = { defaultProfileId: 'dueno', profiles: [{ id: 'dueno', serverIds: ['dueno'] }],
  servers: [{ id: 'dueno', providers: ['codex'], runtimes: ['codex'], availability: { state: 'configured' }, dependencies: [], required: false }] };
async function fixtureBinding(run, { expanded = false, scenario = 'normal', headroomEnabled } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dueno-app-binding-'));
  const calls = [], cleanups = [];
  const binding = await createCodexAppServerSessionProvider({ sessionRoot: join(root, 'sessions'), mcpCatalog,
    modelValidator: async (model) => model,
    ...(headroomEnabled === undefined ? {} : { prepareHeadroom: async () => headroomEnabled
      ? headroomLaunchOverrides('codex') : { env: {}, args: [] } }),
    prepareLaunch: async (spec) => {
      calls.push(spec);
      return { token: 'disposable-fixture-token', credential: { toolScopes: expanded ? ['room_context', 'room_send', 'spawn_session'] : spec.toolScopes } };
    }, cleanupLaunch: async (spec) => { cleanups.push(spec); },
    transportFactory: (spec) => new CodexAppServerTransport({ binary: process.execPath, argsPrefix: [fixture, scenario, ''],
      env: { OPENAI_BASE_URL: spec.env.OPENAI_BASE_URL }, allowedEnvKeys: ['OPENAI_BASE_URL'], schemaReader: async () => evidence }),
  });
  try { await run({ root, binding, calls, cleanups }); }
  finally { await binding.close(); await rm(root, { recursive: true, force: true }); }
}

for (const enabled of [false, true]) test(`App Server child receives Headroom routing only when enabled (${enabled})`, async () => {
  await fixtureBinding(async ({ root, binding }) => {
    const started = await binding.start({ workDir: root, threadId: 'task-room', model: 'fixture-model' });
    await binding.service.prompt(started.id, { blocks: [{ type: 'text', text: 'inspect routing' }], idempotencyKey: 'routing' });
    for (let i = 0; i < 100 && binding.service.get(started.id).lifecycle !== 'ready'; i++) await delay(10);
    assert.ok(binding.project(binding.service.get(started.id)).content.includes(enabled ? 'headroom-routed' : 'direct-routed'));
  }, { scenario: 'headroom', headroomEnabled: enabled });
});

test('provider binding prepares bounded scope then launches real subprocess through SessionService', async () => {
  await fixtureBinding(async ({ root, binding, calls }) => {
    assert.equal(getProtocolSessionProvider('codex-app-server'), binding);
    const started = await binding.start({ workDir: root, sessionId: 'fixture-session', threadId: 'task-room', model: 'fixture-model' });
    assert.equal(calls[0].inheritSpawnScopes, false);
    assert.deepEqual(calls[0].threadAllowlist, ['task-room']);
    assert.deepEqual(calls[0].toolScopes, ['mcp:discover', 'room_context', 'room_send']);
    assert.equal(started.negotiated.effectiveModel, 'fixture-model');
    await binding.service.prompt(started.id, { blocks: [{ type: 'text', text: 'hello' }], idempotencyKey: 'message-1' });
    for (let i = 0; i < 100 && binding.service.get(started.id).lifecycle !== 'ready'; i++) await delay(10);
    const projected = binding.project(binding.service.get(started.id));
    assert.equal(projected.state.capabilities.canSendNow, true);
    assert.equal(projected.transport, 'app-server');
    assert.ok(projected.content.includes('partial'));
    assert.equal(JSON.stringify(projected).includes('disposable-fixture-token'), false);
  });
  assert.equal(getProtocolSessionProvider('codex-app-server'), null);
});

test('widened credential scope and unbounded launch fail before subprocess admission', async () => {
  await fixtureBinding(async ({ root, binding, cleanups }) => {
    await assert.rejects(binding.start({ workDir: root, model: 'fixture-model', threadId: 'task-room' }), { code: 'credential_scope_expanded' });
    assert.equal(binding.service.list().length, 0);
    assert.equal(cleanups[0].reason, 'start_failed');
    await assert.rejects(binding.start({ workDir: root, threadAllowlist: ['*'] }), { code: 'task_scope_required' });
  }, { expanded: true });
});

test('explicit inherited task tools execute without an operator approval', async () => {
  await fixtureBinding(async ({ root, binding }) => {
    const tools = ['task_spawn', 'task_send', 'task_wait', 'task_status', 'task_cancel', 'task_resume'];
    const started = await binding.start({ workDir: root, threadId: 'task-room', model: 'fixture-model',
      toolScopes: ['mcp:discover', 'room_context', 'room_send', ...tools], approvalPolicy: 'never' });
    for (const tool of tools) {
      await binding.service.prompt(started.id, { blocks: [{ type: 'text', text: tool }], idempotencyKey: tool });
      for (let i = 0; i < 100 && binding.service.get(started.id).lifecycle !== 'ready'; i++) await delay(10);
      const session = binding.service.get(started.id);
      assert.equal(session.lifecycle, 'ready');
      assert.ok(binding.project(session).content.includes(`Executed ${tool}`));
      assert.equal(session.interactions.some((entry) => entry.status === 'open'), false);
    }
  }, { scenario: 'task-approvals' });
});

for (const tool of ['task_cancel', 'task_unrecognized', 'spawn_session']) test(`approval whitelist excludes ${tool} without supported inherited authority`, async () => {
  await fixtureBinding(async ({ root, binding }) => {
    const started = await binding.start({ workDir: root, threadId: 'task-room', model: 'fixture-model',
      toolScopes: ['mcp:discover', 'room_context', 'room_send', 'task_spawn', 'task_wait',
        ...(tool === 'task_cancel' ? [] : [tool])], approvalPolicy: 'never' });
    await binding.service.prompt(started.id, { blocks: [{ type: 'text', text: tool }], idempotencyKey: tool });
    for (let i = 0; i < 100 && !['interrupted', 'ready'].includes(binding.service.get(started.id).lifecycle); i++) await delay(10);
    const session = binding.service.get(started.id);
    assert.equal(binding.project(session).content.includes(`Executed ${tool}`), false);
    assert.ok(session.turns.some((turn) => turn.error?.message?.includes('tool requires approval')));
  }, { scenario: 'task-approvals' });
});

test('standalone smoke rejects missing side-effect guards before starting disposable components', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dueno-app-smoke-guard-'));
  const safe = { CADRE_DISABLE_SIDE_EFFECTS: '1', CADRE_GITHUB_AGENT_POLLER_ENABLED: '0',
    CADRE_GITHUB_AGENTS_ENABLED: '0', CADRE_SCHEDULED_AGENT_PUMP_ENABLED: '0', TELEGRAM_BRIDGE: '0' };
  try {
    for (const key of Object.keys(safe)) {
      const env = { ...safe }; delete env[key];
      await assert.rejects(promisify(execFile)(process.execPath, [smokeScript], { cwd: root, env, timeout: 5000 }),
        (error) => error.code === 1 && error.stderr.includes(`Smoke requires ${key}=${safe[key]}`));
      assert.deepEqual(await readdir(root), []);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('provider catalog adds optional App Server while retaining Codex tmux default', async () => {
  const { buildAgentProviderCatalog } = await import('../modules/agent/provider-interface.mjs');
  const catalog = buildAgentProviderCatalog();
  assert.equal(catalog.find((provider) => provider.id === 'codex').transportCapabilities.protocol.name, 'tmux');
  const pending = catalog.find((provider) => provider.id === 'codex-app-server');
  assert.equal(pending.backendType, 'codex-app-server');
  assert.equal(pending.transportCapabilities.turn.steer, false);
  assert.equal(pending.supportsCollaboration, false);
  assert.equal(buildAgentProviderCatalog({}, { codexAppServerEvidence: evidence }).find((provider) => provider.id === 'codex-app-server').transportCapabilities.turn.steer, true);
});
