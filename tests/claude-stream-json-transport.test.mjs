import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it } from 'node:test';
import {
  buildClaudeStreamJsonArgs,
  ClaudeStreamJsonTransport,
} from '../modules/agent/claude-stream-json-transport.mjs';
import { ProcessSupervisor } from '../modules/agent/process-supervisor.mjs';
import { createJournalStore } from '../modules/sessions/journal-store.mjs';
import { SessionService } from '../modules/sessions/session-service.mjs';

const FAKE_CLAUDE = String.raw`
process.stdin.setEncoding('utf8');
let buffer = '';
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const input = JSON.parse(line);
    const text = input.message.content.find((block) => block.type === 'text')?.text || '';
    send({ type: 'system', subtype: 'init', session_id: input.session_id, model: 'claude-test' });
    send({ type: 'assistant', message: { role: 'assistant', content: [{
      type: 'text',
      text: 'auth:' + Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) + ':' + Boolean(process.env.ANTHROPIC_API_KEY),
    }] } });
    send({ type: 'assistant', message: { role: 'assistant', content: [{
      type: 'text', text: 'identity:' + (process.env.DUENO_PROVIDER || '') + ':' + (process.env.DUENO_SESSION_ID || ''),
    }] } });
    send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'input:' + input.message.content.map((block) => block.type).join(',') }] } });
    send({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 3 } } } });
    send({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/x' } } } });
    send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path"' } } });
    send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } });
    send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello ' } } });
    send({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'hello ' + text },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/x' } },
    ], usage: { output_tokens: 4 } } });
    send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } });
    send({ type: 'tool_progress', tool_use_id: 'tool-1', content: 'done' });
    send({ type: 'result', subtype: 'success', result: 'hello ' + text, total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 4 } });
  }
});
`;

const MALFORMED_CLAUDE = String.raw`
process.stdin.once('data', () => process.stdout.write('{bad json}\n'));
`;

const REMOTE_ERROR_CLAUDE = String.raw`
process.stdin.once('data', () => process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'permission_denied', is_error: true, result: 'denied',
}) + '\n'));
`;

const EXITING_CLAUDE = String.raw`
process.stdin.once('data', () => process.stdout.write(JSON.stringify({
  type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
}) + '\n', () => process.exit(9)));
`;

const INTERRUPTIBLE_CLAUDE = String.raw`
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'interrupted', is_error: false }) + '\n');
    }
  }
});
`;

const PERMISSION_CLAUDE = String.raw`
process.stdin.setEncoding('utf8');
let buffer = '';
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.type === 'user') send({
      type: 'control_request', request_id: 'permission-1', request: {
        subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' },
        tool_use_id: 'toolu_1', permission_suggestions: [], title: 'Run tests?',
      },
    });
    if (message.type === 'control_response') {
      const value = message.response;
      if (value.request_id !== 'permission-1' || value.response?.behavior !== 'allow'
        || value.response?.toolUseID !== 'toolu_1' || value.response?.updatedInput?.command !== 'npm test') process.exit(7);
      send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } });
      send({ type: 'result', subtype: 'success', is_error: false });
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

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'dueno-claude-stream-json-'));
  roots.push(root);
  const workDir = join(root, 'work');
  await mkdir(workDir);
  const supervisor = new ProcessSupervisor({ ledgerPath: join(root, 'ledger.json') });
  const transport = new ClaudeStreamJsonTransport({
    binary: process.execPath,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token',
      ANTHROPIC_API_KEY: 'must-not-leak',
    },
    supervisor,
  });
  transports.push(transport);
  return { root, workDir, supervisor, transport, args: ['-e', FAKE_CLAUDE] };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition timeout');
}

async function collectEvents(transport) {
  const events = [];
  for await (const event of transport.events()) events.push(event);
  return events;
}

async function nextEvent(transport, type) {
  for await (const event of transport.events()) {
    if (event.type === type) return event;
  }
  throw new Error(`Transport closed before ${type}`);
}

describe('ClaudeStreamJsonTransport', () => {
  it('builds the subscription-authenticated stream-json CLI contract', () => {
    assert.deepEqual(buildClaudeStreamJsonArgs({
      sessionId: '11111111-2222-4333-8444-555555555555',
      model: 'claude-sonnet-4-6',
      permissionMode: 'workspace-write',
      mcpConfigPath: '/state/dueno-mcp.json', settingsPath: '/state/hooks.json',
      promptArgs: ['--append-system-prompt-file', '/state/prompt.md'],
    }), [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--include-partial-messages', '--verbose', '--session-id', '11111111-2222-4333-8444-555555555555',
      '--permission-prompt-tool', 'stdio',
      '--model', 'claude-sonnet-4-6', '--permission-mode', 'acceptEdits',
      '--mcp-config', '/state/dueno-mcp.json', '--strict-mcp-config',
      '--settings', '/state/hooks.json', '--append-system-prompt-file', '/state/prompt.md',
    ]);
    assert.throws(() => buildClaudeStreamJsonArgs({
      sessionId: '11111111-2222-4333-8444-555555555555', permissionMode: 'mystery',
    }), (error) => error.code === 'unsupported_permission_mode');
  });

  it('launches the CLI with a UUID session id even when the Fleet session id is not one', async () => {
    const { root, workDir, supervisor } = await harness();
    const binary = join(root, 'fake-claude');
    await writeFile(binary, `#!/usr/bin/env node
const id = process.argv[process.argv.indexOf('--session-id') + 1];
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
  process.stderr.write('Error: Invalid session ID. Must be a valid UUID.\\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: id }) + '\\n');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    const transport = new ClaudeStreamJsonTransport({ binary, env: { PATH: process.env.PATH, HOME: root }, supervisor });
    transports.push(transport);
    const started = await transport.start({ cwd: workDir, sessionId: '96a69ce47ff47766' });
    assert.match(started.protocolSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(transport.lifecycle, 'ready');
    assert.equal(transport.eventHistory.some((event) => event.type === 'attempt.exited'), false);
  });

  it('maps stream-json messages to normalized transport events', async () => {
    const { transport, workDir, args } = await harness();
    await transport.start({
      cwd: workDir,
      sessionId: '11111111-2222-4333-8444-555555555555',
      args,
    });
    const result = await transport.prompt({
      turnId: 'turn-1', idempotencyKey: 'key-1', blocks: [
        { type: 'text', text: 'world' },
        { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
      ],
    });
    assert.equal(result.stopReason, 'success');
    const types = result.events.map((event) => event.type);
    for (const type of [
      'turn.started', 'diagnostic', 'usage', 'tool.call', 'tool.update',
      'thought.delta', 'message.delta', 'message.committed', 'turn.settled',
    ]) assert.equal(types.includes(type), true, type);
    assert.equal(result.events.filter((event) => event.type === 'tool.call').length, 1);
    assert.equal(result.events.some((event) => event.type === 'message.committed'
      && event.blocks[0]?.text === 'auth:true:false'), true);
    assert.equal(result.events.some((event) => event.type === 'message.committed'
      && event.blocks[0]?.text === 'input:text,image'), true);
    assert.equal(result.events.some((event) => event.type === 'message.committed'
      && event.blocks[0]?.text === 'hello world'), true);
    const second = await transport.prompt({
      turnId: 'turn-2', idempotencyKey: 'key-2', blocks: [{ type: 'text', text: 'again' }],
    });
    assert.equal(second.events.filter((event) => event.type === 'tool.call').length, 1);
    assert.equal(transport.snapshot().lifecycle, 'ready');
  });

  it('drives the existing SessionService and durable journal', async () => {
    const { root, workDir, supervisor } = await harness();
    const token = 'dueno_test_bearer_must_not_escape';
    const mcpConfigPath = join(root, 'dueno-mcp.json');
    const binary = join(root, 'fake-claude-service');
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { dueno: {
      type: 'http', url: 'http://127.0.0.1:4391/mcp', headers: { Authorization: 'Bearer ${DUENO_AGENT_BUS_TOKEN}' },
    } } }), { mode: 0o600 });
    await writeFile(binary, `#!/usr/bin/env node\n${FAKE_CLAUDE}`, { mode: 0o755 });
    const service = new SessionService({
      provider: 'claude',
      journal: createJournalStore({ rootDir: join(root, 'journal') }),
      transportFactory: () => {
        const transport = new ClaudeStreamJsonTransport({ binary, supervisor });
        transports.push(transport);
        return transport;
      },
    });
    const created = await service.start({
      sessionId: '11111111-2222-4333-8444-555555555555',
      workDir,
      permissionMode: 'workspace-write',
      mcpConfigPath,
      env: {
        ...process.env, DUENO_AGENT_BUS_TOKEN: token,
        DUENO_PROVIDER: 'claude', DUENO_SESSION_ID: '11111111-2222-4333-8444-555555555555',
      },
    });
    assert.equal(created.lifecycle, 'ready');
    const runtime = supervisor.list()[0];
    const persisted = `${await readFile(join(root, 'ledger.json'), 'utf8')}\n${await readFile(`/proc/${runtime.pid}/cmdline`, 'utf8')}`;
    assert.equal(persisted.includes(token), false);
    const turn = await service.prompt(created.id, {
      blocks: [{ type: 'text', text: 'service' }], idempotencyKey: 'service-turn',
    });
    assert.equal(turn.status, 'queued');
    const settled = await waitFor(() => service.get(created.id).turns[0]?.status === 'settled' && service.get(created.id));
    assert.equal(settled.lifecycle, 'ready');
    assert.equal(settled.transcript.some((entry) => entry.type === 'message.committed'), true);
    assert.equal(settled.transcript.some((entry) => entry.blocks?.[0]?.text
      === 'identity:claude:11111111-2222-4333-8444-555555555555'), true);
    const cursor = await service.cursor(created.id, { after: 0 });
    assert.equal(cursor.events.some((entry) => entry.type === 'transport.event'), true);
    assert.equal(JSON.stringify({ settled, cursor }).includes(token), false);
    await service.close();
  });

  it('fails closed on malformed stream-json output', async () => {
    const { transport, workDir } = await harness();
    await transport.start({
      cwd: workDir,
      sessionId: '11111111-2222-4333-8444-555555555555',
      args: ['-e', MALFORMED_CLAUDE],
    });
    const collected = collectEvents(transport);
    await assert.rejects(transport.prompt({
      turnId: 'turn-bad', idempotencyKey: 'key-bad', blocks: [{ type: 'text', text: 'bad' }],
    }), (error) => error.code === 'malformed_frame');
    assert.equal((await collected).some((event) => event.type === 'transport.error'
      && event.kind === 'malformed_frame'), true);
  });

  it('keeps the session ready after a remotely settled Claude error', async () => {
    const { transport, workDir } = await harness();
    await transport.start({ cwd: workDir, args: ['-e', REMOTE_ERROR_CLAUDE] });
    const settledEvent = nextEvent(transport, 'turn.settled');
    let error;
    try {
      await transport.prompt({ turnId: 'turn-error', blocks: [{ type: 'text', text: 'fail' }] });
    } catch (cause) { error = cause; }
    assert.equal(error.code, 'permission_denied');
    assert.equal(error.responseReceived, true);
    const settled = await settledEvent;
    assert.deepEqual(settled.evidence, { accepted: true, settled: true, quiescent: true });
    assert.equal(transport.snapshot().lifecycle, 'ready');
  });

  it('marks an admitted turn unknown when Claude exits before result', async () => {
    const { transport, workDir } = await harness();
    await transport.start({ cwd: workDir, args: ['-e', EXITING_CLAUDE] });
    const collected = collectEvents(transport);
    await assert.rejects(transport.prompt({
      turnId: 'turn-exit', blocks: [{ type: 'text', text: 'exit' }],
    }), (error) => error.code === 'transport_eof');
    const events = await collected;
    const settled = events.find((event) => event.type === 'turn.settled');
    assert.deepEqual(settled.evidence, { accepted: true, settled: false, quiescent: false });
    assert.equal(events.some((event) => event.type === 'attempt.exited' && event.code === 9), true);
  });

  it('interrupts an in-flight turn without destroying the session', async () => {
    const { transport, workDir } = await harness();
    await transport.start({ cwd: workDir, args: ['-e', INTERRUPTIBLE_CLAUDE] });
    const prompt = transport.prompt({ turnId: 'turn-interrupt', blocks: [{ type: 'text', text: 'wait' }] });
    const result = await transport.cancel({ turnId: 'turn-interrupt' });
    assert.equal(result.mode, 'best_effort');
    assert.equal((await prompt).stopReason, 'interrupted');
    assert.equal(transport.snapshot().lifecycle, 'ready');
  });

  it('surfaces and answers the real can_use_tool control protocol', async () => {
    const { transport, workDir } = await harness();
    await transport.start({ cwd: workDir, args: ['-e', PERMISSION_CLAUDE] });
    const prompt = transport.prompt({ turnId: 'turn-permission', blocks: [{ type: 'text', text: 'test' }] });
    const requested = await nextEvent(transport, 'interaction.requested');
    assert.equal(requested.toolCall.name, 'Bash');
    assert.deepEqual(requested.options.map((option) => option.optionId), ['allow_once', 'deny']);
    assert.equal(transport.snapshot().lifecycle, 'blocked');
    await transport.answerInteraction({ interactionId: requested.interactionId, optionId: 'allow_once' });
    assert.equal((await prompt).stopReason, 'success');
    assert.equal(transport.capabilities().interaction.permissions, 'structured_options');
    await assert.rejects(
      transport.answerInteraction({ interactionId: requested.interactionId, optionId: 'allow_once' }),
      (error) => error.code === 'interaction_not_open',
    );
  });

});
