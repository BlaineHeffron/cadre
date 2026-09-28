import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it } from 'node:test';
import { AcpTransport } from '../modules/agent/acp-transport.mjs';
import { assertAgentTransport } from '../modules/agent/agent-transport.mjs';
import { ProcessSupervisor } from '../modules/agent/process-supervisor.mjs';

const FAKE_ACP = String.raw`
process.stdin.setEncoding('utf8');
const mode = process.argv[1] || 'normal';
let buffer = '';
let heldPrompt = null;
let permissionPrompt = null;
let unknownRejected = mode !== 'unknown-ids';
if (mode === 'malformed') process.stdout.write('{bad json\n');
if (mode === 'oversize') process.stdout.write('x'.repeat(4096) + '\n');
if (mode === 'no-newline') process.stdout.write('x'.repeat(4096));
function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === 998 && message.error?.code === -32601) {
      unknownRejected = true;
      continue;
    }
    if (message.id === 700 && message.result) {
      send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'allowed' } } } });
      send({ jsonrpc: '2.0', id: permissionPrompt, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (message.method === 'initialize') {
      if (mode === 'unknown-ids') {
        send({ jsonrpc: '2.0', id: 999, result: { ignored: true } });
        send({ jsonrpc: '2.0', id: 998, method: 'unknown/server_method', params: {} });
      }
      if (!['malformed', 'oversize', 'no-newline'].includes(mode)) send({
        jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: 1,
          agentCapabilities: { promptCapabilities: { image: mode === 'image', audio: false, embeddedContext: false } },
        },
      });
    } else if (message.method === 'session/new') {
      if (!unknownRejected) send({ jsonrpc: '2.0', id: message.id, error: { code: 500, message: 'unknown request was not rejected' } });
      else send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fake-session' } });
      if (mode === 'epipe') {
        process.stdin.pause();
        require('node:fs').closeSync(0);
        setTimeout(() => process.exit(0), 1000);
      }
    } else if (message.method === 'session/prompt') {
      if (mode === 'exit-prompt') process.exit(9);
      else if (mode === 'permission') {
        permissionPrompt = message.id;
        send({ jsonrpc: '2.0', id: 700, method: 'session/request_permission', params: {
          toolCall: { title: 'Write file' },
          options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
        } });
      } else if (mode === 'hold') heldPrompt = message.id;
      else {
        send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } } });
        send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      }
    } else if (message.method === 'session/cancel' && heldPrompt) {
      send({ jsonrpc: '2.0', id: heldPrompt, result: { stopReason: 'cancelled' } });
      heldPrompt = null;
    }
  }
});
`;

const roots = [];
const transports = [];
afterEach(async () => {
  await Promise.allSettled(transports.splice(0).map((transport) => transport.terminate({ grace: 100 })));
  while (roots.length) await rm(roots.pop(), { recursive: true, force: true });
});

async function harness(mode = 'normal', options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dueno-acp-contract-'));
  roots.push(root);
  const workDir = join(root, 'work');
  await mkdir(workDir);
  const supervisor = new ProcessSupervisor({ ledgerPath: join(root, 'ledger.json') });
  const transport = new AcpTransport({
    binary: options.binary || process.execPath,
    configPath: '/tmp/fake-acp.yml',
    supervisor,
    maxFrameBytes: options.maxFrameBytes || 1024,
    startTimeoutMs: 1000,
    requestTimeoutMs: 500,
  });
  transports.push(transport);
  return { transport, workDir, args: ['-e', FAKE_ACP, mode] };
}

async function nextEvent(iterator, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const item = await Promise.race([
      iterator.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('event timeout')), remaining)),
    ]);
    if (item.done) throw new Error('event stream ended');
    if (predicate(item.value)) return item.value;
  }
  throw new Error('event timeout');
}

describe('AgentTransport contract: AcpTransport', () => {
  it('cancels interactions and an in-flight turn even when one response fails during termination', async () => {
    const notifications = [];
    const responses = [];
    const closeErrors = [];
    const terminateCalls = [];
    let stdinEndCalls = 0;
    const verdict = { ok: false, status: 'failed', residual: [{ pid: 4321 }] };
    const supervisor = {
      runtime: () => null,
      async terminate(instanceId, options) {
        terminateCalls.push({ instanceId, options });
        return verdict;
      },
    };
    const transport = new AcpTransport({ configPath: '/tmp/fake-acp.yml', supervisor });
    transport.instanceId = 'runtime-terminate';
    transport.protocolSessionId = 'protocol-terminate';
    transport.attemptId = 'attempt-terminate';
    transport.currentTurn = { turnId: 'turn-terminate', events: [] };
    transport.interactions.set('interaction-ok', { interactionId: 'interaction-ok', requestId: 1 });
    transport.interactions.set('interaction-failed', { interactionId: 'interaction-failed', requestId: 2 });
    transport.codec = {
      closed: false,
      async respond(requestId, result) {
        responses.push({ requestId, result });
        if (requestId === 2) throw new Error('connection closed');
      },
      async notify(method, params) { notifications.push({ method, params }); },
      close(error) { closeErrors.push(error); },
    };
    transport.child = { stdin: { end() { stdinEndCalls += 1; throw new Error('stdin already closed'); } } };

    assert.deepEqual(await transport.terminate({ grace: '250' }), verdict);
    assert.deepEqual(responses.map(({ requestId }) => requestId), [1, 2]);
    assert.deepEqual(notifications, [{
      method: 'session/cancel', params: { sessionId: 'protocol-terminate' },
    }]);
    assert.deepEqual(terminateCalls, [{ instanceId: 'runtime-terminate', options: { graceMs: 250 } }]);
    assert.equal(stdinEndCalls, 1);
    assert.equal(closeErrors[0].message, 'ACP transport terminated');
    assert.equal(transport.interactions.size, 0);
    assert.equal(transport.lifecycle, 'failed');
    assert.equal(transport.eventHistory.some((event) => event.type === 'interaction.cancelled' && event.interactionId === 'interaction-ok'), true);
    // respond() failure is swallowed so termination continues; that interaction is
    // dropped without a cancelled event and the verdict carries the transport failure.
    assert.equal(transport.eventHistory.some((event) => event.type === 'interaction.cancelled' && event.interactionId === 'interaction-failed'), false);
    assert.equal(transport.eventHistory.at(-1).type, 'attempt.exited');
    assert.deepEqual(transport.eventHistory.at(-1).verdict, verdict);
  });

  it('starts, prompts, streams normalized events, advertises graded capabilities, and terminates', { timeout: 15000 }, async () => {
    const { transport, workDir, args } = await harness();
    assertAgentTransport(transport);
    const started = await transport.start({ cwd: workDir, args });
    assert.equal(started.protocolSessionId, 'fake-session');
    assert.equal(transport.capabilities().delivery, 'structured');
    assert.equal(transport.capabilities().cancellation, 'best_effort');
    assert.equal(transport.capabilities().interaction.permissions, 'structured_options');
    const iterator = transport.events();
    const settlement = await transport.prompt({ turnId: 'turn-1', idempotencyKey: 'key-1', blocks: [{ type: 'text', text: 'hello' }] });
    assert.equal(settlement.stopReason, 'end_turn');
    const phases = settlement.events
      .filter((event) => event.type === 'turn.started')
      .map((event) => [event.phase, event.evidence]);
    assert.deepEqual(phases, [
      ['queued', { accepted: false, settled: false, quiescent: false }],
      ['admitted', { accepted: true, settled: false, quiescent: false }],
      ['inflight', { accepted: true, settled: false, quiescent: false }],
    ]);
    const settledEvent = await nextEvent(iterator, (event) => event.type === 'turn.settled');
    assert.equal(settledEvent.turnId, 'turn-1');
    assert.equal(settledEvent.schemaVersion, 1);
    assert.ok(settledEvent.eventId);
    await assert.rejects(() => transport.attach({}), (error) => error.code === 'unsupported_capability');
    await assert.rejects(
      () => transport.prompt({ blocks: [{ type: 'image', data: 'x' }] }),
      (error) => error.code === 'unsupported_capability',
    );
    const verdict = await transport.terminate({ grace: 100 });
    assert.equal(verdict.ok, true);
    assert.ok(['terminated', 'already_gone'].includes(verdict.status));
    assert.deepEqual(verdict.residual, []);
  });

  it('kills the runtime within the grace period when cancellation writes are stuck', async () => {
    const terminateCalls = [];
    const transport = new AcpTransport({ configPath: '/tmp/fake-acp.yml', supervisor: {
      runtime: () => null,
      async terminate(instanceId) { terminateCalls.push(instanceId); return { ok: true, status: 'terminated', residual: [] }; },
    } });
    Object.assign(transport, { instanceId: 'runtime-stuck', protocolSessionId: 'p', attemptId: 'a', currentTurn: { turnId: 't', events: [] } });
    transport.interactions.set('i', { interactionId: 'i', requestId: 1 });
    // A child that stopped reading stdin: every write (behind the hung answer) never settles.
    transport.codec = { closed: false, respond: () => new Promise(() => {}), notify: () => new Promise(() => {}), close() {} };
    const startedAt = Date.now();
    assert.equal((await transport.terminate({ grace: 50 })).status, 'terminated');
    assert.ok(Date.now() - startedAt < 1000);
    assert.deepEqual([terminateCalls, transport.lifecycle, transport.interactions.size], [['runtime-stuck'], 'ended', 0]);
  });

  it('orders and answers a structured permission exactly once', { timeout: 15000 }, async () => {
    const { transport, workDir, args } = await harness('permission');
    await transport.start({ cwd: workDir, args });
    const iterator = transport.events();
    const prompt = transport.prompt({ turnId: 'permission-turn', blocks: [{ type: 'text', text: 'write' }] });
    const requested = await nextEvent(iterator, (event) => event.type === 'interaction.requested');
    await transport.answerInteraction({ interactionId: requested.interactionId, optionId: 'allow_once' });
    await assert.rejects(
      () => transport.answerInteraction({ interactionId: requested.interactionId, optionId: 'allow_once' }),
      (error) => error.code === 'interaction_not_open',
    );
    assert.equal((await prompt).stopReason, 'end_turn');
    await nextEvent(iterator, (event) => event.type === 'interaction.answered');
  });

  it('maps an image block onto ACP only when the server advertises image prompts', { timeout: 15000 }, async () => {
    const { transport, workDir, args } = await harness('image');
    await transport.start({ cwd: workDir, args });
    assert.deepEqual(transport.capabilities().promptCapabilities.types, ['text', 'resource_link', 'image']);
    assert.deepEqual(transport.capabilities().promptCapabilities.mimeAllowlist, [
      'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    ]);
    const settlement = await transport.prompt({
      turnId: 'image-turn',
      blocks: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAAA' }],
    });
    assert.equal(settlement.stopReason, 'end_turn');
  });

  it('rejects malformed, spoofed, unsafe, and oversized ACP prompt payloads before RPC', { timeout: 15000 }, async () => {
    const { transport, workDir, args } = await harness('image');
    await transport.start({ cwd: workDir, args });
    await assert.rejects(
      () => transport.prompt({ blocks: [{ type: 'image', mimeType: 'image/png', data: 'not base64' }] }),
      (error) => error.code === 'attachment_invalid_base64',
    );
    await assert.rejects(
      () => transport.prompt({ blocks: [{
        type: 'image', mimeType: 'image/jpeg', data: 'iVBORw0KGgoAAAAA',
      }] }),
      (error) => error.code === 'attachment_mime_mismatch',
    );
    await assert.rejects(
      () => transport.prompt({ blocks: [{ type: 'resource_link', uri: 'file:///etc/passwd' }] }),
      (error) => error.code === 'unsafe_resource_uri',
    );
    const oversized = Buffer.alloc((8 * 1024 * 1024) + 1, 1).toString('base64');
    await assert.rejects(
      () => transport.prompt({ blocks: [{ type: 'image', mimeType: 'image/png', data: oversized }] }),
      (error) => error.code === 'attachment_file_quota_exceeded' && error.statusCode === 413,
    );
    assert.equal(transport.currentTurn, null);
  });

  it('keeps cancellation best-effort until the prompt settlement proves quiescence', { timeout: 15000 }, async () => {
    const { transport, workDir, args } = await harness('hold');
    await transport.start({ cwd: workDir, args });
    const prompt = transport.prompt({ turnId: 'cancel-turn', blocks: [{ type: 'text', text: 'wait' }] });
    const cancelled = await transport.cancel({ turnId: 'cancel-turn' });
    assert.deepEqual(cancelled, { mode: 'best_effort', settledTurnId: undefined });
    assert.equal((await prompt).stopReason, 'cancelled');
  });

  for (const mode of ['epipe', 'exit-prompt']) {
    it(`rejects a prompt when the ACP process fails (${mode})`, { timeout: 15000 }, async () => {
      const { transport, workDir, args } = await harness(mode);
      await transport.start({ cwd: workDir, args });
      if (mode === 'epipe') await new Promise((resolve) => setTimeout(resolve, 30));
      await assert.rejects(
        () => transport.prompt({ turnId: mode, blocks: [{ type: 'text', text: 'fail' }] }),
        mode === 'epipe'
          ? (error) => ['EPIPE', 'transport_write_error', 'transport_not_writable'].includes(error.code)
          : undefined,
      );
    });
  }

  for (const mode of ['malformed', 'oversize', 'no-newline']) {
    it(`fails closed on invalid framing (${mode})`, { timeout: 15000 }, async () => {
      const { transport, workDir, args } = await harness(mode);
      await assert.rejects(() => transport.start({ cwd: workDir, args }));
    });
  }

  it('tolerates unknown response ids and rejects unknown inbound requests', { timeout: 15000 }, async () => {
    const { transport, workDir, args } = await harness('unknown-ids');
    const started = await transport.start({ cwd: workDir, args });
    assert.equal(started.protocolSessionId, 'fake-session');
  });

  it('surfaces ENOENT without leaving a pending start request', { timeout: 15000 }, async () => {
    const { transport, workDir } = await harness('normal', { binary: '/definitely/missing/dueno-acp' });
    await assert.rejects(() => transport.start({ cwd: workDir, args: [] }), (error) => error.code === 'ENOENT' || /ENOENT|closed|write/i.test(error.message));
  });
});
