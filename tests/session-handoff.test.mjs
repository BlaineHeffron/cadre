import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { buildHandoffPrompt, HANDOFF_CLOSING, readGitSummary } from '../modules/sessions/handoff.mjs';
import { extractClaudeConversationMessages, readConversationPage } from '../modules/telegram/transcript.mjs';
import { agentInterfacePlugin } from '../modules/agent/interface.mjs';
import { buildMonitorMcpServer } from '../modules/platform/monitor-mcp.mjs';
import { buildAgentBusMcpServer } from '../modules/agent-bus/mcp.mjs';
import { AGENT_BUS_AGENT_TOOL_SCOPES, AGENT_SPAWN_TOOL_SCOPES } from '../modules/agent-bus/mcp-auth.mjs';

const root = mkdtempSync(join(tmpdir(), 'cadre-handoff-'));
after(() => rmSync(root, { recursive: true, force: true }));

const TOKEN = 'handoff-test-token';
process.env.AUTH_TOKEN = TOKEN;
process.env.INTERNAL_BYPASS_TOKEN = TOKEN;

function claudeLine(role, content) {
  return JSON.stringify({ type: role, message: { role, content } });
}

// A Claude session log: the task, a tool call and its output, reasoning, and visible replies.
function writeClaudeLog(path, extra = []) {
  writeFileSync(path, [
    claudeLine('user', 'Fix the flaky login test in auth.spec'),
    claudeLine('assistant', [
      { type: 'thinking', thinking: 'SECRET REASONING about the bug' },
      { type: 'text', text: 'Looking at auth.spec first.' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
    ]),
    claudeLine('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'TOOL OUTPUT: 3 failing' }]),
    claudeLine('assistant', [{ type: 'text', text: 'The test races the session cookie; I added an await.' }]),
    claudeLine('user', 'Also run the linter please'),
    ...extra,
  ].join('\n') + '\n');
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
}

describe('handoff prompt', () => {
  it('keeps the task and visible text, drops tool calls, tool output and reasoning, and ends with the closing line', () => {
    const log = join(root, 'visible.jsonl');
    writeClaudeLog(log);
    const messages = extractClaudeConversationMessages(String(execFileSync('cat', [log])));
    const prompt = buildHandoffPrompt({
      source: { id: 'abc123', provider: 'anthropic', model: 'claude-opus-5-5' },
      firstTask: messages[0].text, messages,
    });
    assert.equal(prompt.split('\n')[0], 'Handoff from Cadre session abc123 (provider anthropic, model claude-opus-5-5).');
    assert.match(prompt, /## Original task\n\nFix the flaky login test in auth\.spec/);
    assert.match(prompt, /### Assistant\n\nThe test races the session cookie/);
    assert.match(prompt, /### User\n\nAlso run the linter please/);
    // The first task is not repeated in the recent conversation.
    assert.equal(prompt.split('Fix the flaky login test').length, 2);
    for (const hidden of ['SECRET REASONING', 'TOOL OUTPUT', 'npm test', 'tool_use']) assert.equal(prompt.includes(hidden), false, hidden);
    assert.equal(prompt.includes('## Working tree'), false);
    assert.ok(prompt.endsWith(HANDOFF_CLOSING));
  });

  it('stays within the bound by keeping the newest content', () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user', text: `message-${index} ${'x'.repeat(1500)}`,
    }));
    messages.push({ role: 'assistant', text: `${'y'.repeat(20_000)} NEWEST-TAIL` });
    const prompt = buildHandoffPrompt({ source: { id: 's1' }, firstTask: `TASK ${'t'.repeat(9000)}`, messages, maxChars: 12_000 });
    assert.ok(prompt.length <= 12_000, String(prompt.length));
    assert.ok(prompt.includes('NEWEST-TAIL'));
    assert.equal(prompt.includes('message-0 '), false);
    assert.match(prompt, /\d+ earlier messages omitted/);
    assert.match(prompt, /## Original task\n\nTASK t+/);
    assert.ok(prompt.endsWith(HANDOFF_CLOSING));
  });

  it('reports git status and diff stat for a repository and nothing for a plain directory', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-qm', 'init');
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(repo, 'new.txt'), 'new\n');
    const summary = await readGitSummary(repo);
    assert.match(summary.status, /^ M a\.txt$/m);
    assert.match(summary.status, /^\?\? new\.txt$/m);
    assert.match(summary.diffStat, /a\.txt \| 1 \+/);
    const prompt = buildHandoffPrompt({ source: { id: 's' }, git: summary, workDir: repo });
    assert.match(prompt, new RegExp(`## Working tree \\(${repo}\\)\\n\\n\\$ git status --short\\n M a\\.txt`));
    assert.match(prompt, /\$ git diff --stat\n a\.txt \| 1 \+/);

    const plain = join(root, 'plain');
    mkdirSync(plain);
    assert.equal(await readGitSummary(plain), null);
    assert.equal(await readGitSummary(''), null);
  });
});

// The real agent interface over stub provider routes, the seam its spawn tests use.
// An agy conversation log: steps, with Cadre's priming input first.
function writeAgyLog(path) {
  const request = (text) => ({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` });
  writeFileSync(path, [request('cadre:connect'), { step_index: 1, type: 'ERROR_MESSAGE', error: 'Cadre tools connected' },
    request('Fix the flaky login test in auth.spec'), { step_index: 3, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command' }] },
    { step_index: 4, type: 'GENERIC', content: 'TOOL OUTPUT: 3 failing' },
    { step_index: 5, type: 'PLANNER_RESPONSE', content: 'The test races the session cookie; I added an await.' },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n');
}

async function buildApp({ status = 'ready', refuse = null, sourceKind = 'claude' } = {}) {
  const workDir = join(root, `work-${Math.random().toString(36).slice(2)}`);
  mkdirSync(workDir);
  const log = join(workDir, 'session.jsonl');
  (sourceKind === 'agy' ? writeAgyLog : writeClaudeLog)(log);
  const app = Fastify({ logger: false });
  const created = [];
  const puts = [];
  const source = {
    id: 'src1', provider: 'anthropic', model: 'claude-opus-5-5', workDir, displayName: 'Login fix',
    state: { status }, mcpCapabilities: { profileId: 'dueno', serverIds: ['dueno'] }, promptProfile: 'none', skills: [],
  };
  for (const kind of ['claude', 'codex', 'pi', 'agy']) {
    app.get(`/api/${kind}/sessions`, async () => ({ sessions: kind === sourceKind ? [{ id: 'src1' }] : [] }));
  }
  app.get(`/api/${sourceKind}/sessions/:id`, async () => source);
  // As the tmux transcript route does: the same paged reader over the bound session log.
  app.get(`/api/${sourceKind}/sessions/:id/transcript`, async (req) => readConversationPage(log, sourceKind, req.query));
  app.put(`/api/${sourceKind}/sessions/:id`, async (req) => { puts.push({ id: req.params.id, body: req.body }); return { ok: true }; });
  for (const kind of ['codex', 'pi']) {
    app.post(`/api/${kind}/sessions`, async (req, reply) => {
      created.push({ kind, body: req.body });
      if (refuse && created.length === 1) return reply.code(400).send({ error: 'MCP server dueno is not selectable for this provider', code: refuse });
      return { id: `${kind}-new`, sessionName: `${kind}-new` };
    });
  }
  await app.register(agentInterfacePlugin, {
    idempotencyStore: { async get() { return null; }, async set() {}, async close() {} },
    getPreferences: async () => ({ claudeEnabled: true, codexEnabled: true, piEnabled: true, preferredSingleProvider: 'claude' }),
  });
  await app.ready();
  const handoff = (payload, id = 'src1') => app.inject({
    method: 'POST', url: `/api/agents/sessions/${id}/handoff`, headers: { authorization: `Bearer ${TOKEN}` }, payload,
  });
  return { app, created, puts, workDir, handoff };
}

describe('POST /api/agents/sessions/:id/handoff', () => {
  it('starts a Codex session in the same workDir with the brief and links both sessions', async () => {
    const { app, created, puts, workDir, handoff } = await buildApp();
    try {
      const res = await handoff({ provider: 'codex', model: 'gpt-6.1-sol', thinkingLevel: 'high' });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(created.length, 1);
      const { kind, body } = created[0];
      assert.equal(kind, 'codex');
      assert.equal(body.workDir, workDir);
      assert.equal(body.model, 'gpt-6.1-sol');
      assert.equal(body.thinkingLevel, 'high');
      assert.equal(body.displayName, 'Login fix (handoff)');
      assert.equal(body.mcpProfile, 'dueno');
      assert.deepEqual(body.mcpServers, { add: ['dueno'] });
      assert.deepEqual(body.metadata.handoffFrom, { sessionId: 'src1', kind: 'claude', provider: 'anthropic', model: 'claude-opus-5-5' });
      assert.match(body.initialPrompt, /^Handoff from Cadre session src1 \(provider anthropic, model claude-opus-5-5\)\./);
      assert.match(body.initialPrompt, /## Original task\n\nFix the flaky login test/);
      assert.match(body.initialPrompt, /Also run the linter please/);
      assert.equal(body.initialPrompt.includes('TOOL OUTPUT'), false);
      assert.ok(body.initialPrompt.endsWith(HANDOFF_CLOSING));
      const handoffTo = { sessionId: 'codex-new', kind: 'codex', provider: 'codex', model: 'gpt-6.1-sol' };
      assert.deepEqual(puts, [{ id: 'src1', body: { handoffTo } }]);
      assert.deepEqual(res.json().handoffTo, handoffTo);
      assert.deepEqual(res.json().dropped, []);
    } finally { await app.close(); }
  });

  it('hands off an agy session from its conversation log, without the priming turn', async () => {
    const { app, created, puts, handoff } = await buildApp({ sourceKind: 'agy' });
    try {
      const res = await handoff({ provider: 'codex' });
      assert.equal(res.statusCode, 200, res.body);
      const { body } = created[0];
      assert.equal(body.metadata.handoffFrom.kind, 'agy');
      assert.match(body.initialPrompt, /## Original task\n\nFix the flaky login test/);
      assert.match(body.initialPrompt, /I added an await/);
      assert.equal(/cadre:connect|TOOL OUTPUT/.test(body.initialPrompt), false);
      assert.deepEqual(puts.map((put) => put.id), ['src1']);
    } finally { await app.close(); }
  });

  it('starts a pi provider session, without the selections that provider refuses', async () => {
    const { app, created, puts, handoff } = await buildApp({ refuse: 'mcp_server_unsupported_provider' });
    try {
      const res = await handoff({ provider: 'openrouter', model: 'some/model' });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(created.map((entry) => entry.kind), ['pi', 'pi']);
      assert.equal(created[1].body.provider, 'openrouter');
      assert.equal(created[1].body.model, 'some/model');
      assert.equal(created[1].body.mcpProfile, undefined);
      assert.equal(created[1].body.mcpServers, undefined);
      assert.equal(res.json().dropped[0].code, 'mcp_server_unsupported_provider');
      assert.equal(puts[0].body.handoffTo.sessionId, 'pi-new');
    } finally { await app.close(); }
  });

  it('refuses a source that is mid-turn and starts nothing', async () => {
    const { app, created, puts, handoff } = await buildApp({ status: 'working' });
    try {
      const res = await handoff({ provider: 'codex' });
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().code, 'handoff_source_busy');
      assert.match(res.json().error, /mid-turn \(working\)/);
      assert.deepEqual([created, puts], [[], []]);
      assert.equal((await handoff({ provider: 'codex' }, 'missing')).statusCode, 404);
    } finally { await app.close(); }
  });
});

describe('handoff_session MCP tool', () => {
  it('is listed, is a spawn-scoped tool, and calls the handoff route', async () => {
    const calls = [];
    const requestImpl = async (path, opts) => {
      calls.push({ path, opts });
      return { id: 'new1', provider: 'codex', backendType: 'codex', handoffFrom: { sessionId: 'src1' }, handoffTo: { sessionId: 'new1' } };
    };
    const monitor = buildMonitorMcpServer({ requestImpl });
    assert.ok(monitor.listTools().some((tool) => tool.name === 'handoff_session'));
    assert.ok(AGENT_SPAWN_TOOL_SCOPES.includes('handoff_session'));
    assert.ok(AGENT_BUS_AGENT_TOOL_SCOPES.includes('handoff_session'));

    const mcp = buildAgentBusMcpServer({ requestImpl, extraTools: monitor.tools, credentialStore: { recordRejectedCall: async () => {} } });
    const agent = { authenticated: true, principal: { type: 'agent', kind: 'claude', sessionId: 'coord' }, threadAllowlist: ['@member'] };
    await assert.rejects(mcp.callTool('handoff_session', { session_id: 'src1', provider: 'codex' }, { ...agent, toolScopes: ['spawn_session'] }),
      (error) => error.reason === 'scope_missing');
    assert.equal(calls.length, 0);
    await assert.rejects(mcp.callTool('handoff_session', { session_id: 'src1', provider: 'codex' }, { legacyUntrusted: true }),
      (error) => error.reason === 'child_session_credential_required');

    const result = await mcp.callTool('handoff_session', { session_id: 'src1', provider: 'codex', model: 'gpt-6.1-sol' }, { ...agent, toolScopes: [...AGENT_BUS_AGENT_TOOL_SCOPES] });
    assert.equal(calls.at(-1).path, '/api/agents/sessions/src1/handoff');
    assert.deepEqual(calls.at(-1).opts.body, { provider: 'codex', model: 'gpt-6.1-sol', thinkingLevel: undefined, structured: true });
    assert.equal(result.structuredContent.session_id, 'new1');
  });
});
