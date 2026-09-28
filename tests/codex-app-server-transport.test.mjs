import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, test } from 'node:test';
import { CodexAppServerTransport, codexAppServerCapabilities } from '../modules/agent/codex-app-server-transport.mjs';
import { assertAgentTransport } from '../modules/agent/agent-transport.mjs';
const fixture = resolve('tests/fixtures/codex-app-server/provider.mjs');
const evidence = { source: 'subprocess_fixture', cliVersion: 'fixture/0.153.4', schemaSha256: 'fixture', steerExpectedTurnId: true,
  methods: ['initialize', 'thread/start', 'thread/read', 'thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt', 'mcpServerStatus/list'] };
const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup(scenario = 'normal', options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dueno-app-fixture-')); cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const log = join(cwd, 'frames.jsonl');
  const transport = new CodexAppServerTransport({ binary: process.execPath, argsPrefix: [fixture, scenario, log], env: {},
    schemaReader: async () => evidence, requestTimeoutMs: 150, ...options });
  cleanup.push(() => transport.terminate());
  assertAgentTransport(transport);
  const events = []; const consumed = (async () => { for await (const event of transport.events()) events.push(event); })();
  const frames = async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  return { transport, cwd, events, frames, consumed };
}
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); } assert.fail('Timed out waiting for provider event'); }
const prompt = (transport) => transport.prompt({ turnId: 'fleet-turn', blocks: [{ type: 'text', text: 'hello' }], idempotencyKey: 'once' });

test('handshake records provider model/tool evidence and sends normal turn/start, settling on terminal receipt', async () => {
  const { transport, cwd, events, frames } = await setup();
  const started = await transport.start({ cwd, model: 'fixture-model', requiredTools: ['room_context', 'room_send'] });
  assert.equal(started.startup.effectiveModel, 'fixture-model');
  assert.equal(started.startup.modelEvidence.inferenceIdentityVerified, false);
  assert.equal(started.startup.roomRead.status, 'unverified');
  assert.equal(started.negotiated.busParticipation, 'none');
  assert.equal(started.negotiated.turn.steer, true);
  const result = await prompt(transport);
  assert.equal(result.evidence.settled, true);
  assert.equal(result.providerTurnId, 'provider-turn-1');
  assert.equal(events.filter((e) => e.type === 'message.committed').at(-1).blocks[0].text, 'answer');
  assert.equal(events.some((e) => e.delta?.text === 'FOREIGN'), false);
  assert.deepEqual((await frames()).slice(0, 3).map((e) => e.method), ['initialize', 'initialized', 'thread/start']);
  assert.equal((await frames()).filter((e) => e.method === 'turn/start').length, 1);
  assert.equal(events.find((e) => e.type === 'turn.started' && e.phase === 'inflight').providerTurnId, 'provider-turn-1');
});

test('busy ordinary input is rejected; explicit steering fences provider ID; interrupt ack is not completion', async () => {
  const { transport, cwd, frames } = await setup('hold'); await transport.start({ cwd });
  const pending = prompt(transport); await until(() => transport.snapshot().providerTurnId);
  await assert.rejects(prompt(transport), { code: 'turn_inflight' });
  await assert.rejects(transport.steer({ expectedTurnId: 'fleet-turn', blocks: [{ type: 'text', text: 'x' }] }), { code: 'turn_not_active' });
  await assert.rejects(transport.steer({ expectedTurnId: 'provider-turn-1', blocks: [{ type: 'image' }] }), { code: 'unsupported_capability' });
  assert.equal(transport.snapshot().lifecycle, 'working');
  const receipt = await transport.steer({ expectedTurnId: 'provider-turn-1', blocks: [{ type: 'text', text: 'steer' }] });
  assert.equal(receipt.accepted, true);
  const cancelled = await transport.cancel({ turnId: 'fleet-turn' });
  assert.equal(cancelled.settledTurnId, undefined); assert.equal(transport.snapshot().lifecycle, 'cancelling');
  assert.equal((await pending).stopReason, 'cancelled');
  const requests = await frames();
  assert.equal(requests.filter((e) => e.method === 'turn/start').length, 1);
  assert.equal(requests.find((e) => e.method === 'turn/steer').params.expectedTurnId, 'provider-turn-1');
});

for (const scenario of ['death', 'lost-ack', 'malformed']) test(`${scenario} preserves uncertainty and forbids retry`, async () => {
  const { transport, cwd, events, frames } = await setup(scenario); await transport.start({ cwd });
  await assert.rejects(prompt(transport), (error) => error.uncertain === true && error.evidence.settled === false);
  await assert.rejects(prompt(transport), { code: 'turn_inflight' });
  assert.equal((await frames()).filter((e) => e.method === 'turn/start').length, 1);
  assert.equal(events.find((e) => e.type === 'turn.settled').evidence.quiescent, false);
});

for (const scenario of ['early', 'failed', 'reject']) test(`${scenario} uses real terminal/admission evidence`, async () => {
  const { transport, cwd, events } = await setup(scenario); await transport.start({ cwd });
  if (scenario === 'early') {
    const result = await prompt(transport);
    assert.ok(result.events.findIndex((e) => e.type === 'message.committed') < result.events.findIndex((e) => e.type === 'turn.settled'));
  } else await assert.rejects(prompt(transport), (error) => error.responseReceived === true && error.uncertain === false);
  assert.equal(transport.snapshot().lifecycle, 'ready');
});

test('resume reads the identified stored thread before resuming; never starts or replays a turn', async () => {
  const { transport, cwd, frames } = await setup();
  const started = await transport.attach({ cwd, protocolSessionId: 'thread-1', providerTurnId: 'old-turn' });
  assert.equal(started.startup.reconciliation.turn.items[0].text, 'persisted answer');
  assert.equal(started.startup.reconciliation.evidence.settled, true);
  assert.deepEqual((await frames()).map((e) => e.method), ['initialize', 'initialized', 'thread/read', 'thread/resume', 'mcpServerStatus/list']);
});

test('active or missing provider turn rejects resume without admission', async () => {
  for (const scenario of ['resume-active', 'normal']) {
    const { transport, cwd, frames } = await setup(scenario);
    await assert.rejects(transport.attach({ cwd, protocolSessionId: 'thread-1', providerTurnId: scenario === 'normal' ? 'missing' : 'old-turn' }), { code: 'resume_uncertain' });
    assert.equal((await frames()).some((e) => ['thread/resume', 'turn/start'].includes(e.method)), false);
  }
});

for (const [scenario, spec, code] of [['mismatch', { model: 'requested' }, 'model_mismatch'], ['normal', { requiredTools: ['absent'] }, 'startup_tools_missing'], ['startup-timeout', {}, 'request_timeout']]) {
  test(`startup ${code} fails closed`, async () => {
    const { transport, cwd } = await setup(scenario);
    await assert.rejects(transport.start({ cwd, ...spec }), { code });
    assert.equal(transport.snapshot().lifecycle, 'failed');
  });
}

test('schema lacking exact steer contract cannot advertise or send steering', async () => {
  const { transport, cwd, frames } = await setup('normal', { schemaReader: async () => ({ ...evidence, steerExpectedTurnId: false }) });
  await transport.start({ cwd });
  assert.equal(transport.capabilities().turn.steer, false);
  await assert.rejects(transport.steer({ expectedTurnId: 'x' }), { code: 'unsupported_capability' });
  assert.equal((await frames()).some((e) => e.method === 'turn/steer'), false);
  assert.equal(codexAppServerCapabilities().sessionOps.resume, 'unsupported');
});

test('approval decisions are single-use structured replies', async () => {
  const { transport, cwd, events, frames } = await setup('approval'); await transport.start({ cwd });
  const pending = prompt(transport); await until(() => events.some((e) => e.type === 'interaction.requested'));
  const interactionId = events.find((e) => e.type === 'interaction.requested').interactionId;
  assert.deepEqual(events.find((e) => e.type === 'interaction.requested').options.map((o) => o.optionId), ['accept', 'decline']);
  await assert.rejects(transport.answerInteraction({ interactionId, optionId: 'acceptForSession' }), { code: 'invalid_interaction_option' });
  await transport.answerInteraction({ interactionId, optionId: 'decline' });
  await assert.rejects(transport.answerInteraction({ interactionId, optionId: 'decline' }), { code: 'interaction_not_open' });
  await pending;
  assert.deepEqual((await frames()).find((e) => e.id === 'approval-1').result, { decision: 'decline' });
});

test('server requests round-trip session grants, permission profiles, user-input answers, and declines', async () => {
  const { transport, cwd, events, frames } = await setup('requests'); await transport.start({ cwd });
  for (const decision of ['acceptForSession', 'decline']) {
    const seen = events.length;
    const pending = prompt(transport);
    const requested = () => events.slice(seen).filter((e) => e.type === 'interaction.requested');
    await until(() => requested().length === 4);
    const by = (name, index = 0) => requested().filter((e) => e.toolCall.name === name)[index];
    const [file, perm, color, name] = [by('item/fileChange/requestApproval'), by('item/permissions/requestApproval'),
      by('item/tool/requestUserInput'), by('item/tool/requestUserInput', 1)];
    assert.deepEqual(perm.options.map((o) => o.optionId), ['accept', 'acceptForSession', 'decline']);
    assert.deepEqual([color.kind, color.toolCall.title, color.options.map((o) => o.optionId)], ['selection', 'Color: Pick a color', ['Red', 'Blue']]);
    assert.equal(name.kind, 'unknown_blocking');
    assert.deepEqual(file.options.map((o) => o.optionId), ['accept', 'acceptForSession', 'decline', 'cancel']);
    await transport.answerInteraction({ interactionId: file.interactionId, optionId: decision });
    await transport.answerInteraction({ interactionId: perm.interactionId, optionId: decision });
    await assert.rejects(transport.answerInteraction({ interactionId: color.interactionId, text: 'Green' }), { code: 'invalid_interaction_option' });
    await transport.answerInteraction({ interactionId: color.interactionId, optionId: 'Blue' });
    assert.equal(transport.snapshot().lifecycle, 'blocked');
    await assert.rejects(transport.answerInteraction({ interactionId: name.interactionId }), { code: 'invalid_interaction_option' });
    await transport.answerInteraction({ interactionId: name.interactionId, text: 'notes.txt' });
    await pending;
  }
  const replies = (id) => frames().then((all) => all.filter((f) => !f.method && f.id === id).map((f) => f.result || f.error.code));
  assert.deepEqual(await replies('file-1'), [{ decision: 'acceptForSession' }, { decision: 'decline' }]);
  assert.deepEqual(await replies('perm-1'), [{ permissions: { network: { enabled: true } }, scope: 'session' }, { permissions: {} }]);
  assert.deepEqual(await replies('input-1'), Array(2).fill({ answers: { color: { answers: ['Blue'] }, name: { answers: ['notes.txt'] } } }));
  assert.deepEqual(await replies('elicit-1'), [{ action: 'decline' }, { action: 'decline' }]);
  assert.deepEqual(await replies('unknown-1'), [-32601, -32601]);
});

test('model rerouting records execution evidence separately from startup model', async () => {
  const { transport, cwd } = await setup('reroute'); await transport.start({ cwd, model: 'fixture-model' });
  const result = await prompt(transport);
  const rerouted = result.events.find((event) => event.kind === 'model_rerouted');
  assert.equal(rerouted.effectiveModel, 'fallback-model');
  assert.equal(transport.snapshot().negotiated.effectiveModel, 'fallback-model');
  assert.equal(transport.snapshot().startup.effectiveModel, 'fixture-model');
  assert.equal(rerouted.modelEvidence.source, 'model/rerouted');
});

test('unexpected MCP inventory rejects bounded startup before any turn', async () => {
  const { transport, cwd, frames } = await setup();
  await assert.rejects(transport.start({ cwd, allowedMcpServers: [] }), { code: 'startup_mcp_scope_expanded' });
  assert.equal((await frames()).some((frame) => frame.method === 'turn/start'), false);
});

test('bounded startup disables discovered top-level and plugin servers at their actual configuration scopes', async () => {
  const { transport, cwd, frames } = await setup('isolation');
  const started = await transport.start({ cwd, allowedMcpServers: ['dueno'], allowedMcpTools: ['room_context', 'room_send'] });
  assert.deepEqual(started.startup.tools.filter((server) => server.names.length).map((server) => server.server), ['dueno']);
  assert.equal(started.startup.tools.find((server) => server.server === 'pluginTool').runtimeStatus, 'disabled');
  const request = (await frames()).find((frame) => frame.method === 'thread/start');
  assert.equal(request.params.config.mcp_servers.external.enabled, false);
  assert.equal(request.params.config.plugins['fixture@local'].mcp_servers.pluginTool.enabled, false);
  assert.deepEqual(request.params.config.mcp_servers.dueno.enabled_tools, ['room_context', 'room_send']);
  await prompt(transport);
});
