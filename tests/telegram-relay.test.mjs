import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSentStore, listSessionsFromRegistry, TelegramRelayLoop } from '../modules/telegram/relay.mjs';
import { buildBindingStore, claudeTranscriptPath } from '../modules/telegram/binding.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dueno-telegram-relay-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function session(overrides = {}) {
  return {
    id: 'session-123456',
    tmuxSession: 'codex-session-123456',
    workDir: '/tmp/project',
    runtime: 'codex',
    state: canonicalState('waiting_for_input'),
    ...overrides,
  };
}

function canonicalState(value, overrides = {}) {
  if (value && typeof value === 'object') return value;
  const legacy = String(value || 'unknown');
  const blocked = legacy === 'needs_approval' || legacy === 'needs_confirmation';
  const ready = legacy === 'waiting_for_input';
  const status = ready ? 'ready' : blocked ? 'blocked' : legacy;
  const interactionKind = ready
    ? 'free_text'
    : legacy === 'needs_confirmation'
      ? 'confirmation'
      : legacy === 'needs_approval'
        ? 'permission'
        : 'none';
  return {
    lifecycle: status === 'ended' ? 'ended' : 'running',
    status,
    revision: 1,
    reason: blocked ? 'Approval required' : status,
    interaction: {
      kind: interactionKind,
      detail: blocked ? 'Approval required' : '',
      options: [],
      fingerprint: interactionKind === 'none' ? '' : `${interactionKind}-fixture`,
    },
    capabilities: {
      sendMessage: ready,
      clear: ready,
      interrupt: status === 'working' || status === 'thinking',
      autoClose: status === 'ended',
      needsAttention: status === 'blocked',
    },
    ...overrides,
  };
}

function buildLoop({
  stateDir,
  sessions,
  deliveries,
  states = null,
  transcriptPaths = {},
  sessionTranscriptPaths = {},
  transcriptDeltas = {},
  transcriptMatches = {},
  bindingStore = null,
  resolveBinding: resolveBindingImpl = null,
  readTranscriptDelta: readTranscriptDeltaImpl = null,
  hookEvents = {},
  hookSessionMetadata = {},
  agentBusStatePaths = [],
  beforeDeliver = null,
  now = () => 1000,
  logger = null,
} = {}) {
  const stateQueues = states
    ? new Map(Object.entries(states).map(([key, value]) => [key, [...value]]))
    : null;
  const store = bindingStore || buildBindingStore({ stateDir, now });
  const sender = {
    async deliver(payload) {
      await beforeDeliver?.(payload);
      deliveries.push({
        ...(payload.route || {}),
        session_id: payload.route?.sessionId || '',
        bus_thread_id: payload.route?.scopeType === 'thread' ? payload.route.scopeId : '',
        bus_thread_title: payload.route?.scopeType === 'thread' ? payload.route.name : '',
        text: payload.text,
        buttons: payload.buttons,
        header: payload.header,
      });
      return { msgId: 900 + deliveries.length, threadId: 177, topicKey: payload.route?.key || '' };
    },
  };
  return new TelegramRelayLoop({
    config: { enabled: true, tickIntervalSec: 5 },
    sender,
    sentStore: buildSentStore({ stateDir }),
    bindingStore: store,
    listSessions: async () => sessions.map((entry) => {
      if (!stateQueues) return entry;
      const queue = stateQueues.get(entry.id) || ['active'];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return { ...entry, state: canonicalState(next) };
    }),
    readHookSessionMetadata: async ({ sessionId }) => hookSessionMetadata[sessionId] || { transcriptPath: '' },
    resolveBinding: resolveBindingImpl || (async (entry, { previous = null, liveTenantCount = 1 } = {}) => {
      if (previous?.transcript_path && transcriptMatches[previous.transcript_path] !== false) {
        return {
          path: previous.transcript_path,
          anchor: previous.anchor || 'identity',
          cliSessionId: previous.cli_session_id || 'fixture',
          ino: previous.ino || 1,
          reused: true,
        };
      }
      const hookPath = hookSessionMetadata[entry.id]?.transcriptPath || '';
      if (hookPath) {
        return { path: hookPath, anchor: 'hook', cliSessionId: 'fixture', ino: 1 };
      }
      const runtime = String(entry.runtime || entry.backend || '').toLowerCase();
      const ambiguous = liveTenantCount > 1;
      const key = ambiguous
        ? runtime === 'codex'
          ? `${runtime}:${entry.workDir}:${entry.id}:${entry.created}`
          : `${runtime}:${entry.workDir}:${entry.created}`
        : `${runtime}:${entry.workDir}`;
      const path = ambiguous ? sessionTranscriptPaths[key] : transcriptPaths[key];
      return path
        ? { path, anchor: 'identity', cliSessionId: 'fixture', ino: 1 }
        : { path: null, reason: ambiguous ? 'ambiguous' : 'not_found' };
    }),
    readTranscriptDelta: readTranscriptDeltaImpl || (async (filePath, prevOffset, runtime) => {
      const value = transcriptDeltas[filePath];
      if (typeof value === 'function') return value(prevOffset, runtime);
      return value || { text: '', nextOffset: prevOffset, path: filePath };
    }),
    readHookEvents: async ({ provider, sessionId }) => ({
      events: hookEvents[`${provider}:${sessionId}`] || [],
      cursor: 0,
      path: '',
    }),
    agentBusStatePaths,
    now,
    logger: logger || { warn() {} },
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

describe('telegram relay loop', () => {
  it('delivers bound transcript output from a canonical ready session', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const sessions = [session()];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const bindingStore = buildBindingStore({ stateDir });
      await bindingStore.load();
      await bindingStore.bind('session-123456', { path: transcriptPath, anchor: 'identity', ino: 1, runtime: 'codex', workDir: '/tmp/project' });
      await bindingStore.advance('session-123456', { path: transcriptPath, offset: 10 });
      const loop = buildLoop({
        stateDir,
        sessions,
        paneText: { 'codex-session-123456': 'raw pane' },
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: { [transcriptPath]: { text: 'first line\nsecond line', nextOffset: 44, path: transcriptPath } },
        bindingStore,
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input', 'waiting_for_input'] },
      });

      await loop.step();
      await loop.step();
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, 'first line\nsecond line');
      assert.equal(deliveries[0].buttons, undefined);

      await loop.step();
      assert.equal(deliveries.length, 1);
    });
  });

  it('binds and delivers transcript output on a canonical ready edge', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        paneText: { 'codex-session-123456': 'still active' },
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: { [transcriptPath]: { text: 'unbound live output', nextOffset: 19, path: transcriptPath } },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input'] },
      });

      await loop.step();
      await loop.step();
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, 'unbound live output');
    });
  });

  it('passes the session display name and bus thread info through delivery', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session({ name: 'Lead Implementer', busThreadId: 'thr_1', busThreadTitle: 'telegram bus' })],
        paneText: { 'codex-session-123456': 'raw pane' },
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: { [transcriptPath]: { text: 'done', nextOffset: 4, path: transcriptPath } },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input'] },
      });

      await loop.step();
      await loop.step();
      assert.equal(deliveries[0].name, 'telegram bus');
      assert.equal(deliveries[0].bus_thread_id, 'thr_1');
      assert.equal(deliveries[0].bus_thread_title, 'telegram bus');
    });
  });

  it('does not rename a named session onto a DM room topic', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session({
          name: 'Lead Implementer',
          busThreadId: 'thr_dm',
          busThreadTitle: 'DM: claude:aaaa|codex:session-123456',
        })],
        paneText: { 'codex-session-123456': 'raw pane' },
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: { [transcriptPath]: { text: 'done', nextOffset: 4, path: transcriptPath } },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input'] },
      });

      await loop.step();
      await loop.step();
      assert.equal(deliveries[0].name, 'Lead Implementer');
      assert.equal(deliveries[0].scopeType, 'session');
      assert.equal(deliveries[0].bus_thread_id, '');
    });
  });

  it('delivers clean transcript text instead of pane text and advances offset', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        paneText: { 'codex-session-123456': 'RAW PANE WITH TOOL CALLS' },
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: { [transcriptPath]: { text: 'Clean msg', nextOffset: 123, path: transcriptPath } },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input'] },
      });

      await loop.step();
      await loop.step();
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, 'Clean msg');
      const bindings = await readJson(join(stateDir, 'bindings.json'));
      assert.equal(bindings['session-123456'].transcript_path, transcriptPath);
      assert.equal(bindings['session-123456'].offset, 123);
      assert.equal(bindings['session-123456'].updated_at_ms, 1000);
      assert.deepEqual({
        transcript_path: bindings['session-123456'].transcript_path,
        offset: bindings['session-123456'].offset,
        updated_at_ms: bindings['session-123456'].updated_at_ms,
      }, {
        transcript_path: transcriptPath,
        offset: 123,
        updated_at_ms: 1000,
      });
    });
  });

  it('does not send raw pane text when no transcript path is found', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        paneText: { 'codex-session-123456': 'pane fallback' },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input'] },
      });

      await loop.step();
      await loop.step();
      assert.equal(deliveries.length, 0);
    });
  });

  it('preserves a legacy offset when re-anchoring the same transcript path', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const offsets = [];
      await writeFile(join(stateDir, 'transcript_offsets.json'), JSON.stringify({
        'session-123456': {
          transcript_path: transcriptPath,
          offset: 700,
          updated_at_ms: 900,
        },
      }));
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        paneText: { 'codex-session-123456': 'active' },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input'] },
        resolveBinding: async () => ({
          path: transcriptPath,
          anchor: 'identity',
          cliSessionId: 'fixture',
          ino: 1,
        }),
        readTranscriptDelta: async (filePath, offset) => {
          offsets.push(offset);
          return { text: 'new output', nextOffset: 720, path: filePath };
        },
      });

      await loop.step();
      await loop.step();

      assert.deepEqual(offsets, [700, 720]);
      assert.equal(deliveries[0].text, 'new output');
      const bindings = await readJson(join(stateDir, 'bindings.json'));
      assert.equal(bindings['session-123456'].offset, 720);
    });
  });

  it('uses the hook-bound transcript path even when sessions share a workDir', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const boundPath = join(stateDir, 'bound.jsonl');
      await writeFile(boundPath, '');
      const loop = buildLoop({
        stateDir,
        sessions: [
          session({ id: 'topic-a', tmuxSession: 'codex-topic-a' }),
          session({ id: 'topic-b', tmuxSession: 'codex-topic-b' }),
        ],
        paneText: { 'codex-topic-a': 'pane a', 'codex-topic-b': 'pane b' },
        hookSessionMetadata: { 'topic-a': { transcriptPath: boundPath } },
        transcriptDeltas: { [boundPath]: { text: 'bound output', nextOffset: 12, path: boundPath } },
        deliveries,
        states: {
          'topic-a': ['working', 'waiting_for_input'],
          'topic-b': ['working', 'waiting_for_input'],
        },
      });

      await loop.step();
      await loop.step();
      assert.deepEqual(deliveries.map((delivery) => [delivery.session_id, delivery.text]), [
        ['topic-a', 'bound output'],
      ]);
    });
  });

  it('passes registry cliSessionId through to the binding resolver for Claude', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const projectsDir = join(stateDir, 'projects');
      const cliSessionId = 'd35f5989-b630-4b26-83d8-a440e071737d';
      const transcriptPath = claudeTranscriptPath(projectsDir, '/tmp/project', cliSessionId);
      await mkdir(dirname(transcriptPath), { recursive: true });
      await writeFile(transcriptPath, '');
      const loop = new TelegramRelayLoop({
        config: { enabled: true, tickIntervalSec: 5, captureLines: 120 },
        sender: {
          async deliver(payload) {
            deliveries.push({ ...(payload.route || {}), text: payload.text });
            return { msgId: 901, threadId: 177, topicKey: payload.route?.key || '' };
          },
        },
        sentStore: buildSentStore({ stateDir }),
        bindingStore: buildBindingStore({ stateDir, now: () => 1000 }),
        listSessions: async () => [
          session({
            id: 'claude-cli',
            runtime: 'claude',
            tmuxSession: 'claude-cli',
            cliSessionId,
          }),
        ],
        listActiveTmuxSessions: null,
        capturePane: async () => 'raw pane',
        classifyState: () => 'active',
        readHookDerivedState: async () => ({ lifecycle: '', activity: '', source: '', ageMs: Infinity }),
        readHookSessionMetadata: async () => ({ transcriptPath: '' }),
        readHookEvents: async () => ({ events: [], cursor: 0, path: '' }),
        readTranscriptDelta: async (filePath) => ({ text: 'cli anchored output', nextOffset: 19, path: filePath }),
        bindingDeps: { projectsDir },
        agentBusStatePaths: [],
        now: () => 1000,
        logger: { warn() {} },
      });

      await loop.step();
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, 'cli anchored output');
      const bindings = await readJson(join(stateDir, 'bindings.json'));
      assert.equal(bindings['claude-cli'].anchor, 'cli_session_id');
      assert.equal(bindings['claude-cli'].cli_session_id, cliSessionId);
      assert.equal(bindings['claude-cli'].transcript_path, transcriptPath);
    });
  });

  it('follows a Claude session to its new transcript after /clear without crossing a co-located session', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const workDir = join(stateDir, 'repo');
      const projectsDir = join(stateDir, 'projects');
      await mkdir(join(workDir, '.git'), { recursive: true });
      const assistant = (text) => `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })}\n`;
      const transcript = (cliSessionId) => claudeTranscriptPath(projectsDir, workDir, cliSessionId);
      const writeClearHook = (id, cliSessionId) => writeFile(
        join(workDir, '.agent_bus/hooks/state', `claude-${id}.json`),
        JSON.stringify({
          session: { provider: 'claude', cliSessionId, duenoSessionId: id, cwd: workDir, transcriptPath: transcript(cliSessionId) },
          hook: { lifecycle: 'running', activity: 'starting', last_event_name: 'SessionStart', source: 'hook' },
        }),
      );
      const [pathA, pathB, pathC] = [transcript('cli-a'), transcript('cli-b'), transcript('cli-c')];
      await mkdir(dirname(pathA), { recursive: true });
      await mkdir(join(workDir, '.agent_bus/hooks/state'), { recursive: true });
      await writeFile(pathA, assistant('before clear'));
      await writeFile(pathC, assistant('neighbour output'));
      const buildRelay = () => new TelegramRelayLoop({
        config: { enabled: true, tickIntervalSec: 5 },
        sender: {
          async deliver(payload) {
            deliveries.push([payload.route?.sessionId, payload.text]);
            return { msgId: 900 + deliveries.length, threadId: 177, topicKey: payload.route?.key || '' };
          },
        },
        sentStore: buildSentStore({ stateDir }),
        bindingStore: buildBindingStore({ stateDir, now: () => 1000 }),
        listSessions: async () => [
          session({ id: 'claude-x', runtime: 'claude', tmuxSession: 'claude-x', workDir, cliSessionId: 'cli-a' }),
          session({ id: 'claude-y', runtime: 'claude', tmuxSession: 'claude-y', workDir, cliSessionId: 'cli-c' }),
        ],
        readHookEvents: async () => ({ events: [], cursor: 0, path: '' }),
        bindingDeps: { projectsDir },
        agentBusStatePaths: [],
        now: () => 1000,
        logger: { warn() {} },
      });

      let loop = buildRelay();
      await loop.step();
      assert.deepEqual(deliveries.splice(0), [['claude-x', 'before clear'], ['claude-y', 'neighbour output']]);
      assert.equal((await readJson(join(stateDir, 'bindings.json')))['claude-x'].anchor, 'cli_session_id');

      // /clear: SessionStart moves the hook state to B, which already holds post-clear output.
      await writeFile(pathB, assistant('after clear'));
      await writeClearHook('claude-x', 'cli-b');
      await writeFile(pathA, assistant('before clear') + assistant('stale old file'));
      await loop.step();
      assert.deepEqual(deliveries.splice(0), [['claude-x', 'after clear']]);
      const bindings = await readJson(join(stateDir, 'bindings.json'));
      assert.equal(bindings['claude-x'].transcript_path, pathB);
      assert.equal(bindings['claude-x'].anchor, 'hook');
      assert.equal(bindings['claude-y'].transcript_path, pathC);

      const later = assistant('later');
      await writeFile(pathB, assistant('after clear') + later.slice(0, 20));
      await loop.step();
      assert.deepEqual(deliveries.splice(0), []);
      await writeFile(pathB, assistant('after clear') + later);
      await loop.step();
      assert.deepEqual(deliveries.splice(0), [['claude-x', 'later']]);

      // A restarted relay keeps B rather than falling back to the registry's cliSessionId A.
      loop = buildRelay();
      await loop.step();
      await writeFile(pathB, assistant('after clear') + later + assistant('after restart'));
      await loop.step();
      assert.deepEqual(deliveries.splice(0), [['claude-x', 'after restart']]);
    });
  });

  it('revalidates a stale hook-bound Codex transcript path before delivery', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const stalePath = join(stateDir, 'stale-hook.jsonl');
      const currentPath = join(stateDir, 'current-hook.jsonl');
      await writeFile(stalePath, '');
      const bindingStore = buildBindingStore({ stateDir, now: () => 1000 });
      await bindingStore.load();
      await bindingStore.bind('session-123456', {
        path: stalePath,
        anchor: 'legacy',
        cliSessionId: 'stale',
        ino: 1,
        runtime: 'codex',
        workDir: '/tmp/project',
      });
      const loop = buildLoop({
        stateDir,
        bindingStore,
        sessions: [session()],
        paneText: { 'codex-session-123456': 'active' },
        transcriptPaths: { 'codex:/tmp/project': currentPath },
        transcriptDeltas: { [currentPath]: { text: 'current hook output', nextOffset: 19, path: currentPath } },
        transcriptMatches: { [stalePath]: false, [currentPath]: true },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input'] },
      });

      await loop.step();
      await loop.step();
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, 'current hook output');
    });
  });

  it('does not use workDir transcript lookup when multiple sessions share a runtime and workDir', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      let transcriptConsulted = false;
      const transcriptPath = join(stateDir, 'shared-rollout.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [
          session({ id: 'topic-a', tmuxSession: 'codex-topic-a', workDir: '/tmp/project', runtime: 'codex' }),
          session({ id: 'topic-b', tmuxSession: 'codex-topic-b', workDir: '/tmp/project', runtime: 'codex' }),
        ],
        paneText: {
          'codex-topic-a': 'pane for topic a',
          'codex-topic-b': 'pane for topic b',
        },
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: {
          [transcriptPath]: () => {
            transcriptConsulted = true;
            return { text: 'wrong shared transcript', nextOffset: 99, path: transcriptPath };
          },
        },
        deliveries,
        states: {
          'topic-a': ['working', 'waiting_for_input'],
          'topic-b': ['working', 'waiting_for_input'],
        },
      });

      await loop.step();
      await loop.step();
      assert.equal(transcriptConsulted, false);
      assert.equal(deliveries.length, 0);
    });
  });

  it('uses session-scoped Codex rollout lookup when shared-workdir sessions have creation hints', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'conformal-rollout.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [
          session({ id: 'octo-a', tmuxSession: 'codex-octo-a', workDir: '/tmp/project', runtime: 'codex', created: 2000 }),
          session({ id: 'conformal', tmuxSession: 'codex-conformal', workDir: '/tmp/project', runtime: 'codex', created: 3000 }),
        ],
        paneText: {
          'codex-octo-a': 'pane a',
          'codex-conformal': 'pane conformal',
        },
        sessionTranscriptPaths: { 'codex:/tmp/project:conformal:3000': transcriptPath },
        transcriptDeltas: {
          [transcriptPath]: { text: 'conformal gravity answer', nextOffset: 99, path: transcriptPath },
        },
        deliveries,
        states: {
          'octo-a': ['working', 'waiting_for_input'],
          conformal: ['working', 'waiting_for_input'],
        },
      });

      await loop.step();
      await loop.step();
      assert.deepEqual(deliveries.map((delivery) => [delivery.session_id, delivery.text]), [
        ['conformal', 'conformal gravity answer'],
      ]);
    });
  });

  it('uses session-scoped Claude transcript lookup when shared-workdir sessions have creation hints', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'claude-target.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [
          session({ id: 'old-claude', tmuxSession: 'claude-old', workDir: '/tmp/project', runtime: 'claude', created: 2000 }),
          session({ id: 'new-claude', tmuxSession: 'claude-new', workDir: '/tmp/project', runtime: 'claude', created: 3000 }),
        ],
        paneText: {
          'claude-old': 'old pane',
          'claude-new': 'new pane',
        },
        sessionTranscriptPaths: { 'claude:/tmp/project:3000': transcriptPath },
        transcriptDeltas: {
          [transcriptPath]: { text: 'claude shared cwd answer', nextOffset: 99, path: transcriptPath },
        },
        deliveries,
        states: {
          'old-claude': ['working', 'waiting_for_input'],
          'new-claude': ['working', 'waiting_for_input'],
        },
      });

      await loop.step();
      await loop.step();
      assert.deepEqual(deliveries.map((delivery) => [delivery.session_id, delivery.text]), [
        ['new-claude', 'claude shared cwd answer'],
      ]);
    });
  });

  it('skips delivery but advances offset when transcript delta has no assistant text', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        paneText: { 'codex-session-123456': 'pane should not send' },
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: { [transcriptPath]: { text: '', nextOffset: 77, path: transcriptPath } },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input'] },
      });

      await loop.step();
      await loop.step();
      assert.equal(deliveries.length, 0);
      const bindings = await readJson(join(stateDir, 'bindings.json'));
      assert.equal(bindings['session-123456'].offset, 77);
    });
  });

  it('rebinds a stale Codex transcript path that does not match the Dueno session id', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const stalePath = join(stateDir, 'stale.jsonl');
      const currentPath = join(stateDir, 'current.jsonl');
      const bindingStore = buildBindingStore({ stateDir });
      await bindingStore.load();
      await bindingStore.bind('session-123456', { path: stalePath, anchor: 'identity', ino: 1, runtime: 'codex', workDir: '/tmp/project' });
      await bindingStore.advance('session-123456', { path: stalePath, offset: 500 });
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        paneText: { 'codex-session-123456': 'active' },
        transcriptPaths: { 'codex:/tmp/project': currentPath },
        transcriptDeltas: { [currentPath]: { text: 'current output', nextOffset: 18, path: currentPath } },
        transcriptMatches: { [stalePath]: false, [currentPath]: true },
        bindingStore,
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input'] },
      });

      await loop.step();
      await loop.step();
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, 'current output');
      const bindings = await readJson(join(stateDir, 'bindings.json'));
      assert.equal(bindings['session-123456'].transcript_path, currentPath);
    });
  });

  it('rebinds a stale Claude transcript path that does not match the Dueno session id', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const stalePath = join(stateDir, 'stale-claude.jsonl');
      const currentPath = join(stateDir, 'current-claude.jsonl');
      const bindingStore = buildBindingStore({ stateDir });
      await bindingStore.load();
      await bindingStore.bind('session-123456', { path: stalePath, anchor: 'identity', ino: 1, runtime: 'claude', workDir: '/tmp/project' });
      await bindingStore.advance('session-123456', { path: stalePath, offset: 500 });
      const loop = buildLoop({
        stateDir,
        sessions: [session({ runtime: 'claude', tmuxSession: 'claude-session-123456' })],
        paneText: { 'claude-session-123456': 'active' },
        transcriptPaths: { 'claude:/tmp/project': currentPath },
        transcriptDeltas: { [currentPath]: { text: 'current Claude output', nextOffset: 21, path: currentPath } },
        transcriptMatches: { [stalePath]: false, [currentPath]: true },
        bindingStore,
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input'] },
      });

      await loop.step();
      await loop.step();
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, 'current Claude output');
      const bindings = await readJson(join(stateDir, 'bindings.json'));
      assert.equal(bindings['session-123456'].transcript_path, currentPath);
    });
  });

  it('binds and advances transcript deltas while a session is working', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        paneText: { 'codex-session-123456': 'active' },
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: { [transcriptPath]: { text: '', nextOffset: 77, path: transcriptPath } },
        deliveries,
        states: { 'session-123456': ['working'] },
      });

      await loop.step();
      assert.equal(deliveries.length, 0);
      const bindings = await readJson(join(stateDir, 'bindings.json'));
      assert.equal(bindings['session-123456'].offset, 77);
    });
  });

  it('does not synthesize output while a working session has no transcript binding', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        paneText: { 'codex-session-123456': 'working output' },
        deliveries,
        states: { 'session-123456': ['working', 'working', 'working'] },
      });

      await loop.step();
      await loop.step();
      await loop.step();
      assert.equal(deliveries.length, 0);
    });
  });

  it('uses canonical working status without consulting pane or hook classifiers', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const loop = buildLoop({
        stateDir,
        sessions: [session({ state: canonicalState('working') })],
        deliveries,
      });

      await loop.step();
      assert.equal(deliveries.length, 0);
      assert.equal(loop.lastCanonicalStateById.get('session-123456').status, 'working');
    });
  });

  it('relays from canonical ready status', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session({ state: canonicalState('waiting_for_input') })],
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: { [transcriptPath]: { text: 'canonical ready message', nextOffset: 18, path: transcriptPath } },
        deliveries,
      });

      await loop.step();
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, 'canonical ready message');
      assert.equal(loop.lastCanonicalStateById.get('session-123456').status, 'ready');
    });
  });

  it('does not synthesize pane fallback when canonical ready has no transcript output', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session({ state: canonicalState('waiting_for_input') })],
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: { [transcriptPath]: { text: '', nextOffset: 0, path: transcriptPath } },
        deliveries,
      });

      await loop.step();
      assert.equal(deliveries.length, 0);
    });
  });

  it('does not read or synthesize content when canonical ready binding is unresolved', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const warnings = [];
      let transcriptReads = 0;
      const loop = buildLoop({
        stateDir,
        sessions: [session({ state: canonicalState('waiting_for_input') })],
        deliveries,
        readTranscriptDelta: async () => {
          transcriptReads += 1;
          return { text: 'should not read', nextOffset: 99, path: 'unproven' };
        },
        logger: { warn: (value) => warnings.push(String(value)) },
      });

      await loop.step();
      assert.equal(deliveries.length, 0);
      assert.equal(transcriptReads, 0);
      assert.equal(loop.status().unresolvedSessions, 1);
      assert.deepEqual(warnings, ['unresolved_transcript session-123456: not_found']);
    });
  });

  it('retries an unresolved binding while the canonical ready snapshot is unchanged', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      let bindingAttempts = 0;
      const loop = buildLoop({
        stateDir,
        sessions: [session({ state: canonicalState('waiting_for_input') })],
        deliveries,
        resolveBinding: async () => {
          bindingAttempts += 1;
          return bindingAttempts === 1
            ? { path: null, reason: 'not_found' }
            : { path: transcriptPath, anchor: 'identity', cliSessionId: 'fixture', ino: 1 };
        },
        transcriptDeltas: {
          [transcriptPath]: { text: 'late-bound output', nextOffset: 17, path: transcriptPath },
        },
      });

      await loop.step();
      await loop.step();

      assert.equal(bindingAttempts, 2);
      assert.deepEqual(deliveries.map((delivery) => delivery.text), ['late-bound output']);
    });
  });

  it('retries delivery failure while the canonical ready snapshot is unchanged', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      let deliveryAttempts = 0;
      const loop = buildLoop({
        stateDir,
        sessions: [session({ state: canonicalState('waiting_for_input') })],
        deliveries,
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: {
          [transcriptPath]: { text: 'retry output', nextOffset: 12, path: transcriptPath },
        },
        beforeDeliver: async () => {
          deliveryAttempts += 1;
          if (deliveryAttempts === 1) throw new Error('temporary sender failure');
        },
      });

      await loop.step();
      await loop.step();

      assert.equal(deliveryAttempts, 2);
      assert.deepEqual(deliveries.map((delivery) => delivery.text), ['retry output']);
    });
  });

  it('tails a registry session even when canonical state is absent', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session({ state: null })],
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: {
          [transcriptPath]: { text: 'state-independent output', nextOffset: 24, path: transcriptPath },
        },
        deliveries,
      });

      await loop.step();
      assert.deepEqual(deliveries.map((delivery) => delivery.text), ['state-independent output']);
      assert.equal(loop.status().sessionsSeen, 1);
    });
  });

  it('delivers unsent output when the first observed state is already waiting_for_input', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        paneText: { 'codex-session-123456': 'raw pane' },
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: { [transcriptPath]: { text: 'idle output', nextOffset: 11, path: transcriptPath } },
        deliveries,
        states: { 'session-123456': ['waiting_for_input', 'waiting_for_input'] },
      });

      await loop.step();
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, 'idle output');
    });
  });

  it('does not redeliver first-observed stopped output already in sent state', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const transcriptDeltas = { [transcriptPath]: { text: 'idle output', nextOffset: 11, path: transcriptPath } };
      const transcriptPaths = { 'codex:/tmp/project': transcriptPath };
      const first = buildLoop({
        stateDir,
        sessions: [session()],
        paneText: { 'codex-session-123456': 'raw pane' },
        transcriptPaths,
        transcriptDeltas,
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input'] },
      });
      await first.step();
      await first.step();
      assert.equal(deliveries.length, 1);

      const restarted = buildLoop({
        stateDir,
        sessions: [session()],
        paneText: { 'codex-session-123456': 'raw pane' },
        transcriptPaths,
        transcriptDeltas,
        deliveries,
        states: { 'session-123456': ['waiting_for_input'] },
      });
      await restarted.step();
      assert.equal(deliveries.length, 1);
    });
  });

  it('delivers transcript output and canonical blocked controls independently', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      let transcriptConsulted = false;
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        deliveries,
        states: { 'session-123456': ['working', canonicalState('blocked', {
          reason: 'Command approval required',
          interaction: {
            kind: 'permission',
            detail: 'Approve command?',
            options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }],
            fingerprint: 'approval-1',
          },
        })] },
        transcriptPaths: { 'codex:/tmp/project': join(stateDir, 'rollout.jsonl') },
        transcriptDeltas: {
          [join(stateDir, 'rollout.jsonl')]: () => {
            transcriptConsulted = true;
            return { text: 'should not read', nextOffset: 1 };
          },
        },
      });

      await loop.step();
      await loop.step();
      assert.equal(deliveries.length, 2);
      assert.equal(deliveries[0].text, 'should not read');
      assert.equal(deliveries[1].text, 'Approve command?\n1. Yes\n2. No');
      assert.deepEqual(deliveries[1].buttons, [
        { text: 'Yes', callback_data: 'answer:1' },
        { text: 'No', callback_data: 'answer:2' },
      ]);
      assert.equal(transcriptConsulted, true);
    });
  });

  it('keeps guardrail delivery text-only even with stale hook question choices', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        deliveries,
        states: { 'session-123456': ['working', canonicalState('blocked', {
          reason: 'Verification guardrail',
          interaction: {
            kind: 'guardrail',
            detail: 'Wait for verification?',
            options: [{ key: '1', label: 'Continue' }, { key: '2', label: 'Wait' }],
            fingerprint: 'guardrail-1',
          },
        })] },
        hookEvents: {
          'codex:session-123456': [{
            eventName: 'Notification',
            payload: {
              subtype: 'ask_user_question',
              text: 'Stale question?',
              options: ['Yes', 'No'],
            },
          }],
        },
      });

      await loop.step();
      await loop.step();
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, 'Wait for verification?\n1. Continue\n2. Wait');
      assert.equal(deliveries[0].buttons, undefined);
    });
  });

  it('delivers Claude AskUserQuestion hook choices as Telegram buttons', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const loop = buildLoop({
        stateDir,
        sessions: [session({ runtime: 'claude', tmuxSession: 'claude-session-123456' })],
        paneText: { 'claude-session-123456': 'waiting' },
        deliveries,
        states: { 'session-123456': ['working', canonicalState('blocked', {
          interaction: {
            kind: 'selection',
            detail: '',
            options: [],
            fingerprint: 'ask-user-1',
          },
        })] },
        transcriptPaths: { 'claude:/tmp/project': join(stateDir, 'claude.jsonl') },
        transcriptDeltas: {
          [join(stateDir, 'claude.jsonl')]: { text: 'transcript fallback', nextOffset: 19 },
        },
        hookEvents: {
          'claude:session-123456': [{
            eventName: 'PreToolUse',
            loggedAt: '2026-06-28T12:00:00.000Z',
            payload: {
              tool_name: 'AskUserQuestion',
              tool_input: {
                questions: [{
                  question: 'Pick deployment target',
                  options: [
                    { label: 'Staging' },
                    { label: 'Production' },
                    { label: 'Cancel' },
                  ],
                }],
              },
            },
          }],
        },
        now: () => Date.parse('2026-06-28T12:01:00.000Z'),
      });

      await loop.step();
      await loop.step();

      assert.equal(deliveries.length, 2);
      assert.equal(deliveries[0].text, 'transcript fallback');
      assert.equal(deliveries[1].text, 'Pick deployment target\n1. Staging\n2. Production\n3. Cancel');
      assert.deepEqual(deliveries[1].buttons, [
        { text: '1. Staging', callback_data: 'answer:1' },
        { text: '2. Production', callback_data: 'answer:2' },
        { text: '3. Cancel', callback_data: 'answer:3' },
      ]);
    });
  });

  it('does not resend an unchanged blocking interaction when only state revision changes', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const interaction = {
        kind: 'confirmation',
        detail: 'Proceed?',
        options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }],
        fingerprint: 'same-confirmation',
      };
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        deliveries,
        states: {
          'session-123456': [
            canonicalState('blocked', { revision: 10, interaction }),
            canonicalState('blocked', { revision: 11, interaction }),
          ],
        },
      });

      await loop.step();
      await loop.step();

      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, 'Proceed?\n1. Yes\n2. No');
    });
  });

  it('does not let transcript Q&A override canonical ready state', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'claude.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session({ runtime: 'claude', tmuxSession: 'claude-session-123456' })],
        paneText: { 'claude-session-123456': 'waiting' },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input'] },
        transcriptPaths: { 'claude:/tmp/project': transcriptPath },
        transcriptDeltas: {
          [transcriptPath]: {
            text: 'canonical ready output',
            operatorQuestion: { text: 'Pick deployment target', choices: ['Staging', 'Production', 'Cancel'] },
            nextOffset: 19,
          },
        },
      });

      await loop.step();
      await loop.step();

      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, 'canonical ready output');
      assert.equal(deliveries[0].buttons, undefined);
    });
  });

  it('does not turn a scraped Claude pane menu into Q&A buttons without an event', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'claude.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session({ runtime: 'claude', tmuxSession: 'claude-session-123456' })],
        paneText: {
          'claude-session-123456': `
☐ Choose option

Telegram Q&A beta final: choose an option

❯ 1. Alpha
     Select Alpha
  2. Beta
     Select Beta
  3. Cancel
     Cancel the operation
  4. Type something.
────────────────────────────────────────────────────────────────────────────────
  5. Chat about this
`,
        },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input'] },
        transcriptPaths: { 'claude:/tmp/project': transcriptPath },
        transcriptDeltas: {
          [transcriptPath]: { text: 'ordinary Claude output', nextOffset: 22 },
        },
      });

      await loop.step();
      await loop.step();

      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, 'ordinary Claude output');
      assert.equal(deliveries[0].buttons, undefined);
    });
  });

  it('delivers hook Q&A choices from a canonical blocked interaction', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const loop = buildLoop({
        stateDir,
        sessions: [session({
          runtime: 'claude',
          tmuxSession: 'claude-session-123456',
          state: canonicalState('blocked', {
            interaction: {
              kind: 'selection',
              detail: 'Pick one',
              options: [{ key: '1', label: 'A' }, { key: '2', label: 'B' }],
              fingerprint: 'pick-one',
            },
          }),
        })],
        deliveries,
        hookEvents: {
          'claude:session-123456': [{
            eventName: 'PreToolUse',
            payload: {
              tool_name: 'AskUserQuestion',
              tool_input: {
                questions: [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
              },
            },
          }],
        },
        now: () => Date.parse('2026-07-06T10:02:00.000Z'),
      });

      await loop.step();

      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, 'Pick one\n1. A\n2. B');
      assert.deepEqual(deliveries[0].buttons, [
        { text: '1. A', callback_data: 'answer:1' },
        { text: '2. B', callback_data: 'answer:2' },
      ]);
    });
  });

  it('ignores a stale Claude operator question after user prompt submit', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'claude.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session({ runtime: 'claude', tmuxSession: 'claude-session-123456' })],
        paneText: { 'claude-session-123456': 'waiting' },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input'] },
        transcriptPaths: { 'claude:/tmp/project': transcriptPath },
        transcriptDeltas: {
          [transcriptPath]: { text: 'transcript answer', nextOffset: 17 },
        },
        hookEvents: {
          'claude:session-123456': [
            {
              eventName: 'PreToolUse',
              payload: {
                tool_name: 'AskUserQuestion',
                tool_input: {
                  questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }],
                },
              },
            },
            { eventName: 'UserPromptSubmit', payload: { prompt: '1' } },
          ],
        },
      });

      await loop.step();
      await loop.step();

      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, 'transcript answer');
      assert.equal(deliveries[0].buttons, undefined);
    });
  });

  it('ignores a Claude operator question after a newer Telegram answer was sent', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'claude.jsonl');
      await writeFile(join(stateDir, 'sent.json'), JSON.stringify({
        'session-123456': {
          session_id: 'session-123456',
          transcript_hash: 'answered',
          recent_transcript_hashes: [],
          recent_transcript_line_hashes: [],
          message_id: 910,
          thread_id: 177,
          topic_key: 'thread:thr_9',
          answer_consumed: true,
          answer_consumed_at_ms: Date.parse('2026-07-06T10:01:00.000Z'),
          ts: Date.parse('2026-07-06T10:01:00.000Z') / 1000,
        },
      }));
      const loop = buildLoop({
        stateDir,
        sessions: [session({ runtime: 'claude', tmuxSession: 'claude-session-123456' })],
        paneText: { 'claude-session-123456': 'waiting' },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input'] },
        transcriptPaths: { 'claude:/tmp/project': transcriptPath },
        transcriptDeltas: {
          [transcriptPath]: (prevOffset) => prevOffset
            ? { text: '', nextOffset: 15 }
            : { text: 'answer accepted', nextOffset: 15 },
        },
        hookEvents: {
          'claude:session-123456': [{
            eventName: 'PreToolUse',
            loggedAt: '2026-07-06T10:00:00.000Z',
            payload: {
              tool_name: 'AskUserQuestion',
              tool_input: {
                questions: [{ question: 'Already answered?', options: [{ label: 'Yes' }, { label: 'No' }] }],
              },
            },
          }],
        },
        now: () => Date.parse('2026-07-06T10:02:00.000Z'),
      });

      await loop.step();
      await loop.step();

      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, 'answer accepted');
      assert.equal(deliveries[0].buttons, undefined);
    });
  });

  it('ignores a stale Claude operator question after runtime work resumes', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'claude.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session({ runtime: 'claude', tmuxSession: 'claude-session-123456' })],
        paneText: { 'claude-session-123456': 'waiting' },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input'] },
        transcriptPaths: { 'claude:/tmp/project': transcriptPath },
        transcriptDeltas: {
          [transcriptPath]: { text: 'normal readiness answer', nextOffset: 23 },
        },
        hookEvents: {
          'claude:session-123456': [
            {
              eventName: 'PreToolUse',
              loggedAt: '2026-07-06T10:00:00.000Z',
              payload: {
                tool_name: 'AskUserQuestion',
                tool_input: {
                  questions: [{ question: 'Stale Q&A?', options: [{ label: 'A' }, { label: 'B' }] }],
                },
              },
            },
            {
              eventName: 'SessionToolStarted',
              source: 'runtime',
              loggedAt: '2026-07-06T10:01:00.000Z',
              data: { sessionState: 'working' },
            },
            {
              eventName: 'SessionPromptReady',
              source: 'runtime',
              loggedAt: '2026-07-06T10:02:00.000Z',
              data: { sessionState: 'waiting_for_input' },
            },
          ],
        },
      });

      await loop.step();
      await loop.step();

      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, 'normal readiness answer');
      assert.equal(deliveries[0].buttons, undefined);
    });
  });

  it('does not treat a numbered-list notification as operator Q&A', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'claude.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session({ runtime: 'claude', tmuxSession: 'claude-session-123456' })],
        paneText: { 'claude-session-123456': 'waiting' },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input'] },
        transcriptPaths: { 'claude:/tmp/project': transcriptPath },
        transcriptDeltas: {
          [transcriptPath]: { text: 'readiness summary with numbered analysis', nextOffset: 41 },
        },
        hookEvents: {
          'claude:session-123456': [{
            eventName: 'Notification',
            payload: {
              subtype: 'idle_prompt',
              text: 'Paper readiness points:\n1. Tighten scope\n2. Add citations\n3. Run spellcheck',
              options: ['Tighten scope', 'Add citations', 'Run spellcheck'],
            },
          }],
        },
      });

      await loop.step();
      await loop.step();

      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, 'readiness summary with numbered analysis');
      assert.equal(deliveries[0].buttons, undefined);
    });
  });

  it('treats explicit question notifications as operator Q&A', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'claude.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session({ runtime: 'claude', tmuxSession: 'claude-session-123456' })],
        deliveries,
        states: { 'session-123456': ['working', canonicalState('blocked', {
          interaction: {
            kind: 'selection',
            detail: '',
            options: [],
            fingerprint: 'ask-user-2',
          },
        })] },
        transcriptPaths: { 'claude:/tmp/project': transcriptPath },
        transcriptDeltas: {
          [transcriptPath]: { text: 'should not replace question', nextOffset: 41 },
        },
        hookEvents: {
          'claude:session-123456': [{
            eventName: 'Notification',
            payload: {
              subtype: 'ask_user_question',
              text: 'Choose next step?',
              options: ['Ship', 'Revise'],
            },
          }],
        },
      });

      await loop.step();
      await loop.step();

      assert.equal(deliveries.length, 2);
      assert.equal(deliveries[0].text, 'should not replace question');
      assert.equal(deliveries[1].text, 'Choose next step?\n1. Ship\n2. Revise');
      assert.deepEqual(deliveries[1].buttons, [
        { text: '1. Ship', callback_data: 'answer:1' },
        { text: '2. Revise', callback_data: 'answer:2' },
      ]);
    });
  });

  it('uses canonical confirmation option keys for answer buttons', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        deliveries,
        states: { 'session-123456': ['working', canonicalState('blocked', {
          interaction: {
            kind: 'confirmation',
            detail: 'Proceed?',
            options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }, { key: '5', label: '5' }],
            fingerprint: 'confirmation-1',
          },
        })] },
      });

      await loop.step();
      await loop.step();
      // A digit key is sent by position, which the bridge resolves back to the key.
      assert.deepEqual(deliveries[0].buttons, [
        { text: 'Yes', callback_data: 'answer:y' },
        { text: 'No', callback_data: 'answer:n' },
        { text: '5', callback_data: 'answer:3' },
      ]);
    });
  });

  it('delivers each new transcript byte range without content reconstruction', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      let delta = { text: 'turn one', nextOffset: 8, path: transcriptPath };
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        paneText: { 'codex-session-123456': 'raw pane' },
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: { [transcriptPath]: () => delta },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input', 'working', 'waiting_for_input'] },
      });

      await loop.step();
      await loop.step();
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, 'turn one');

      delta = { text: 'turn two', nextOffset: 17, path: transcriptPath };
      await loop.step();
      await loop.step();
      assert.equal(deliveries.length, 2);
      assert.equal(deliveries[1].text, 'turn two');
    });
  });

  it('delivers assistant transcript messages while canonical state remains working', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: {
          [transcriptPath]: (offset) => offset < 10
            ? { text: 'first commentary', nextOffset: 10, path: transcriptPath }
            : { text: 'second commentary', nextOffset: 20, path: transcriptPath },
        },
        deliveries,
        states: { 'session-123456': ['working', 'working'] },
      });

      await loop.step();
      await loop.step();

      assert.deepEqual(deliveries.map((delivery) => delivery.text), [
        'first commentary',
        'second commentary',
      ]);
    });
  });

  it('delivers identical text again when it comes from a new transcript range', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session({ state: null })],
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: {
          [transcriptPath]: (offset) => ({
            text: 'Done.',
            nextOffset: offset + 10,
            path: transcriptPath,
          }),
        },
        deliveries,
      });

      await loop.step();
      await loop.step();

      assert.deepEqual(deliveries.map((delivery) => delivery.text), ['Done.', 'Done.']);
    });
  });

  it('uses a delivered byte-range checkpoint if cursor persistence lags', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const bindingStore = buildBindingStore({ stateDir });
      const persistAdvance = bindingStore.advance.bind(bindingStore);
      let dropFirstAdvance = true;
      bindingStore.advance = async (...args) => {
        if (dropFirstAdvance) {
          dropFirstAdvance = false;
          return null;
        }
        return persistAdvance(...args);
      };
      const loop = buildLoop({
        stateDir,
        sessions: [session({ state: null })],
        bindingStore,
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: {
          [transcriptPath]: {
            text: 'send once',
            startOffset: 0,
            nextOffset: 10,
            path: transcriptPath,
          },
        },
        deliveries,
      });

      await loop.step();
      await loop.step();

      assert.deepEqual(deliveries.map((delivery) => delivery.text), ['send once']);
      const bindings = await readJson(join(stateDir, 'bindings.json'));
      assert.equal(bindings['session-123456'].offset, 10);
    });
  });

  it('drains a final transcript range after the session disappears from the registry', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const sessions = [session({ state: canonicalState('working') })];
      const loop = buildLoop({
        stateDir,
        sessions,
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: {
          [transcriptPath]: (offset) => offset < 10
            ? { text: '', nextOffset: 10, path: transcriptPath }
            : { text: 'final after removal', nextOffset: 20, path: transcriptPath },
        },
        deliveries,
      });

      await loop.step();
      sessions.splice(0);
      await loop.step();

      assert.deepEqual(deliveries.map((delivery) => delivery.text), ['final after removal']);
      assert.equal(loop.status().orphanSessionsSeen, 1);
    });
  });

  it('does not duplicate stopped-to-stopped same content', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        paneText: { 'codex-session-123456': 'raw pane' },
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: { [transcriptPath]: { text: 'same output', nextOffset: 11, path: transcriptPath } },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input', 'waiting_for_input'] },
      });

      await loop.step();
      await loop.step();
      await loop.step();
      assert.equal(deliveries.length, 1);
    });
  });

  it('skips overlapping ticks so a slow sweep cannot double-send', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      let releaseBinding;
      const bindingGate = new Promise((resolve) => {
        releaseBinding = resolve;
      });
      const loop = new TelegramRelayLoop({
        config: { enabled: true, tickIntervalSec: 1 },
        sender: {
          async deliver(payload) {
            deliveries.push(payload);
            return { msgId: 901, threadId: 177, topicKey: `session:${payload.session_id}` };
          },
        },
        sentStore: buildSentStore({ stateDir }),
        bindingStore: buildBindingStore({ stateDir }),
        listSessions: async () => [session({ state: canonicalState('waiting_for_input') })],
        readHookSessionMetadata: async () => ({ transcriptPath: '' }),
        readHookEvents: async () => ({ events: [], cursor: 0, path: '' }),
        resolveBinding: async () => {
          await bindingGate;
          return { path: transcriptPath, anchor: 'identity', cliSessionId: 'fixture', ino: 1 };
        },
        readTranscriptDelta: async () => ({ text: 'slow output', nextOffset: 11, path: transcriptPath }),
        logger: { warn() {} },
      });

      const first = loop.step();
      assert.equal(await loop.step(), false);
      releaseBinding();
      assert.equal(await first, true);
      assert.equal(deliveries.length, 1);
      assert.equal(loop.status().skippedOverlappingTicks, 1);
    });
  });

  it('does not synthesize message content from an unchanged canonical ready snapshot', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input', 'waiting_for_input', 'waiting_for_input'] },
      });

      await loop.step();
      await loop.step();
      await loop.step();
      await loop.step();

      assert.equal(deliveries.length, 0);
    });
  });

  it('delivers new transcript text while a session remains stopped', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const transcriptDeltas = [
        { text: 'first stopped message', nextOffset: 10, path: transcriptPath },
        { text: 'second stopped message', nextOffset: 20, path: transcriptPath },
        { text: 'second stopped message', nextOffset: 20, path: transcriptPath },
      ];
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        paneText: { 'codex-session-123456': 'pane fallback' },
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: {
          [transcriptPath]: () => transcriptDeltas.shift() || { text: '', nextOffset: 20, path: transcriptPath },
        },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input', 'waiting_for_input', 'waiting_for_input'] },
      });

      await loop.step();
      await loop.step();
      await loop.step();
      await loop.step();

      assert.equal(deliveries.length, 2);
      assert.equal(deliveries[0].text, 'first stopped message');
      assert.equal(deliveries[1].text, 'second stopped message');
    });
  });

  it('writes sent.json entries with bridge-compatible fields', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'rollout.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        paneText: { 'codex-session-123456': 'raw pane' },
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: { [transcriptPath]: { text: 'hello', nextOffset: 5, path: transcriptPath } },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input'] },
        now: () => 2000,
      });

      await loop.step();
      await loop.step();
      const sent = await readJson(join(stateDir, 'sent.json'));
      assert.equal(sent['session-123456'].session_id, 'session-123456');
      assert.equal(sent['session-123456'].message_id, 901);
      assert.equal(sent['session-123456'].thread_id, 177);
      assert.equal(sent['session-123456'].topic_key, 'session:session-123456');
      assert.equal(sent['session-123456'].ts, 2);
      assert.equal(sent['session-123456'].transcript_hash.length, 64);
      assert.equal(sent['session-123456'].transcript_start_offset, 0);
      assert.equal(sent['session-123456'].transcript_end_offset, 5);
      assert.ok(sent['session-123456'].transcript_delivery_key);
    });
  });

  it('refreshes bus thread metadata immediately before delivery', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'claude.jsonl');
      const agentBusStatePath = join(stateDir, 'agent-bus-state.json');
      await writeFile(agentBusStatePath, JSON.stringify({
        threads: [{
          id: 'thr_fresh',
          title: 'Fresh thread',
          status: 'open',
          updatedAt: 2000,
          participants: [{ kind: 'claude', sessionId: 'session-123456' }],
        }],
      }));
      const loop = buildLoop({
        stateDir,
        sessions: [session({ runtime: 'claude', tmuxSession: 'claude-session-123456' })],
        paneText: { 'claude-session-123456': 'raw pane' },
        transcriptPaths: { 'claude:/tmp/project': transcriptPath },
        transcriptDeltas: { [transcriptPath]: { text: 'fresh thread output', nextOffset: 19, path: transcriptPath } },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input'] },
        agentBusStatePaths: [agentBusStatePath],
      });

      await loop.step();
      await loop.step();

      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].bus_thread_id, 'thr_fresh');
      assert.equal(deliveries[0].bus_thread_title, 'Fresh thread');
    });
  });

  it('routes every active bus-thread participant to the shared thread topic', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const claudePath = join(stateDir, 'claude.jsonl');
      const codexPath = join(stateDir, 'codex.jsonl');
      const agentBusStatePath = join(stateDir, 'agent-bus-state.json');
      await writeFile(agentBusStatePath, JSON.stringify({
        threads: [{
          id: 'thr_shared',
          title: 'Shared Thread',
          status: 'open',
          updatedAt: 2000,
          participants: [
            { kind: 'claude', sessionId: 'claude-a' },
            { kind: 'codex', sessionId: 'codex-b' },
          ],
        }],
      }));
      const loop = buildLoop({
        stateDir,
        sessions: [
          session({ id: 'claude-a', runtime: 'claude', tmuxSession: 'claude-a', workDir: '/tmp/shared' }),
          session({ id: 'codex-b', runtime: 'codex', tmuxSession: 'codex-b', workDir: '/tmp/shared' }),
        ],
        paneText: { 'claude-a': 'raw claude', 'codex-b': 'raw codex' },
        transcriptPaths: {
          'claude:/tmp/shared': claudePath,
          'codex:/tmp/shared': codexPath,
        },
        transcriptDeltas: {
          [claudePath]: { text: 'claude output', nextOffset: 13, path: claudePath },
          [codexPath]: { text: 'codex output', nextOffset: 12, path: codexPath },
        },
        deliveries,
        states: {
          'claude-a': ['working', 'waiting_for_input'],
          'codex-b': ['working', 'waiting_for_input'],
        },
        agentBusStatePaths: [agentBusStatePath],
      });

      await loop.step();
      await loop.step();

      assert.equal(deliveries.length, 2);
      assert.deepEqual(deliveries.map((delivery) => delivery.key), ['thread:thr_shared', 'thread:thr_shared']);
      assert.ok(deliveries.every((delivery) => !delivery.key.startsWith('session:')));
      assert.ok(deliveries.every((delivery) => delivery.name === 'Shared Thread'));
    });
  });

  it('keeps routing to the last-good thread index when bus-state read misses', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const transcriptPath = join(stateDir, 'codex.jsonl');
      const agentBusStatePath = join(stateDir, 'agent-bus-state.json');
      await writeFile(agentBusStatePath, JSON.stringify({
        threads: [{
          id: 'thr_cached',
          title: 'Cached Thread',
          status: 'open',
          updatedAt: 2000,
          participants: [{ kind: 'codex', sessionId: 'session-123456' }],
        }],
      }));
      const loop = buildLoop({
        stateDir,
        sessions: [session()],
        paneText: { 'codex-session-123456': 'raw pane' },
        transcriptPaths: { 'codex:/tmp/project': transcriptPath },
        transcriptDeltas: {
          [transcriptPath]: (offset) => offset > 0
            ? { text: 'second output', nextOffset: 12, path: transcriptPath }
            : { text: 'first output', nextOffset: 5, path: transcriptPath },
        },
        deliveries,
        states: { 'session-123456': ['working', 'waiting_for_input', 'working', 'waiting_for_input'] },
        agentBusStatePaths: [agentBusStatePath],
      });

      await loop.step();
      await loop.step();
      await rm(agentBusStatePath, { force: true });
      await loop.step();
      await loop.step();

      assert.equal(deliveries.length, 2);
      assert.equal(deliveries[0].key, 'thread:thr_cached');
      assert.equal(deliveries[1].key, 'thread:thr_cached');
      assert.ok(deliveries.every((delivery) => !delivery.key.startsWith('session:')));
    });
  });

  it('isolates per-session errors and continues delivering other sessions', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const warnings = [];
      const transcriptPath = join(stateDir, 'good-rollout.jsonl');
      const loop = buildLoop({
        stateDir,
        sessions: [
          session({ id: 'bad', tmuxSession: 'bad-tmux' }),
          session({ id: 'good', tmuxSession: 'good-tmux', workDir: '/tmp/good' }),
        ],
        transcriptPaths: {
          'codex:/tmp/project': join(stateDir, 'bad-rollout.jsonl'),
          'codex:/tmp/good': transcriptPath,
        },
        transcriptDeltas: {
          [join(stateDir, 'bad-rollout.jsonl')]: () => { throw new Error('transcript failed'); },
          [transcriptPath]: { text: 'good output', nextOffset: 11, path: transcriptPath },
        },
        deliveries,
        states: { bad: ['working', 'waiting_for_input'], good: ['working', 'waiting_for_input'] },
        logger: { warn: (value) => warnings.push(String(value)) },
      });

      await loop.step();
      await loop.step();
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].session_id, 'good');
      assert.equal(loop.status().sessionsSeen, 2);
      assert.match(loop.status().lastError, /transcript failed/);
      assert.equal(warnings.length, 2);
    });
  });

  it('does not start a timer when disabled', () => {
    const loop = new TelegramRelayLoop({
      config: { enabled: false },
      sender: { deliver() {} },
      sentStore: { async load() {}, get() {}, async set() {} },
      listSessions: async () => [],
    });

    assert.equal(loop.start(), false);
    assert.equal(loop.status().running, false);
  });

  it('drains sessions whose canonical lifecycle is terminal', async () => {
    await withTempDir(async (stateDir) => {
      const deliveries = [];
      const loop = new TelegramRelayLoop({
        config: { enabled: true },
        sender: {
          async deliver(payload) {
            deliveries.push({ ...(payload.route || {}), session_id: payload.route?.sessionId || '', text: payload.text });
            return { msgId: 901, threadId: 177, topicKey: payload.route?.key || '' };
          },
        },
        sentStore: buildSentStore({ stateDir }),
        bindingStore: buildBindingStore({ stateDir }),
        listSessions: async () => [
          session({ id: 'stale', tmuxSession: 'codex-stale', state: canonicalState('ended') }),
          session({ id: 'live', tmuxSession: 'codex-live', state: canonicalState('waiting_for_input') }),
        ],
        readHookSessionMetadata: async () => ({ transcriptPath: '' }),
        readHookEvents: async () => ({ events: [], cursor: 0, path: '' }),
        resolveBinding: async () => ({
          path: join(stateDir, 'live-rollout.jsonl'),
          anchor: 'identity',
          cliSessionId: 'fixture',
          ino: 1,
        }),
        readTranscriptDelta: async (filePath) => ({ text: 'live output', nextOffset: 11, path: filePath }),
      });

      await loop.step();
      assert.equal(loop.status().sessionsSeen, 2);
      assert.equal(loop.status().terminalSessionsSeen, 1);
      assert.equal(deliveries.length, 2);
      assert.deepEqual(deliveries.map((delivery) => delivery.session_id).sort(), ['live', 'stale']);
    });
  });
});

describe('telegram relay registry session listing', () => {
  it('reads claude, codex, and Pi registry files from the sessions directory', async () => {
    await withTempDir(async (sessionsDir) => {
      await writeFile(join(sessionsDir, '.claude_sessions.json'), JSON.stringify([
        { id: 'claude-1', tmuxSession: 'dm-agent-1', workDir: '/tmp/claude', runtime: 'claude', displayName: 'Lead Implementer' },
      ]));
      await writeFile(join(sessionsDir, '.codex_sessions.json'), JSON.stringify([
        { id: 'codex-1', tmuxSession: 'codex-1', workDir: '/tmp/codex', runtime: 'codex', name: 'GitHub PR #8' },
      ]));
      await writeFile(join(sessionsDir, '.pi_sessions.json'), JSON.stringify([
        {
          id: 'pi-1',
          tmuxSession: 'pi-1',
          workDir: '/tmp/pi',
          runtime: 'pi',
          provider: 'opencode-go',
          cliSessionId: 'pi-cli-1',
        },
      ]));

      assert.deepEqual(await listSessionsFromRegistry({ sessionsDir, agentBusStatePaths: [] }), [
        { id: 'claude-1', tmuxSession: 'dm-agent-1', workDir: '/tmp/claude', runtime: 'claude', state: null, name: 'Lead Implementer', created: 0, cliSessionId: '' },
        { id: 'codex-1', tmuxSession: 'codex-1', workDir: '/tmp/codex', runtime: 'codex', state: null, name: 'GitHub PR #8', created: 0, cliSessionId: '' },
        { id: 'pi-1', tmuxSession: 'pi-1', workDir: '/tmp/pi', runtime: 'pi', state: null, name: '', created: 0, cliSessionId: 'pi-cli-1' },
      ]);
    });
  });

  it('reads registry files from multiple monitor roots and keeps newest duplicate', async () => {
    await withTempDir(async (leftRoot) => {
      await withTempDir(async (rightRoot) => {
        await writeFile(join(leftRoot, '.codex_sessions.json'), JSON.stringify([
          { id: 'dup', tmuxSession: 'codex-old', workDir: '/tmp/old', runtime: 'codex', created: 1 },
          { id: 'left', tmuxSession: 'codex-left', workDir: '/tmp/left', runtime: 'codex', created: 3 },
        ]));
        await writeFile(join(rightRoot, '.codex_sessions.json'), JSON.stringify([
          { id: 'dup', tmuxSession: 'codex-new', workDir: '/tmp/new', runtime: 'codex', created: 2, cliSessionId: 'cli-new' },
        ]));

        assert.deepEqual(await listSessionsFromRegistry({ roots: [leftRoot, rightRoot], agentBusStatePaths: [] }), [
          { id: 'dup', tmuxSession: 'codex-new', workDir: '/tmp/new', runtime: 'codex', state: null, name: '', created: 2, cliSessionId: 'cli-new' },
          { id: 'left', tmuxSession: 'codex-left', workDir: '/tmp/left', runtime: 'codex', state: null, name: '', created: 3, cliSessionId: '' },
        ]);
      });
    });
  });

  it('attaches bus thread metadata from agent-bus state for Telegram topic routing', async () => {
    await withTempDir(async (sessionsDir) => {
      const agentBusStatePath = join(sessionsDir, 'agent-bus-state.json');
      await writeFile(join(sessionsDir, '.codex_sessions.json'), JSON.stringify([
        { id: 'codex-1', tmuxSession: 'codex-1', workDir: '/tmp/codex', runtime: 'codex', name: 'Lead Implementer' },
      ]));
      await writeFile(agentBusStatePath, JSON.stringify({
        threads: [
          {
            id: 'thr_old',
            title: 'Old closed thread',
            status: 'closed',
            updatedAt: 99,
            participants: [{ kind: 'codex', sessionId: 'codex-1' }],
          },
          {
            id: 'thr_live',
            title: 'Live bus topic',
            status: 'open',
            updatedAt: 1,
            participants: [{ kind: 'codex', sessionId: 'codex-1' }],
          },
        ],
      }));

      assert.deepEqual(await listSessionsFromRegistry({ sessionsDir, agentBusStatePaths: [agentBusStatePath] }), [
        {
          id: 'codex-1',
          tmuxSession: 'codex-1',
          workDir: '/tmp/codex',
          runtime: 'codex',
          state: null,
          name: 'Lead Implementer',
          created: 0,
          cliSessionId: '',
          busThreadId: 'thr_live',
          busThreadTitle: 'Live bus topic',
        },
      ]);
    });
  });

  it('does not attach DM rooms as the session Telegram topic', async () => {
    await withTempDir(async (sessionsDir) => {
      const agentBusStatePath = join(sessionsDir, 'agent-bus-state.json');
      await writeFile(join(sessionsDir, '.codex_sessions.json'), JSON.stringify([
        { id: 'codex-1', tmuxSession: 'codex-1', workDir: '/tmp/codex', runtime: 'codex', name: 'Lead Implementer' },
      ]));
      await writeFile(agentBusStatePath, JSON.stringify({
        threads: [
          {
            id: 'thr_room',
            title: 'Release room',
            status: 'open',
            updatedAt: 1,
            participants: [{ kind: 'codex', sessionId: 'codex-1' }],
          },
          {
            id: 'thr_dm',
            title: 'DM: claude:aaaa|codex:codex-1',
            status: 'open',
            updatedAt: 9,
            metadata: { dm: true, dmKey: 'claude:aaaa|codex:codex-1' },
            participants: [{ kind: 'codex', sessionId: 'codex-1' }],
          },
        ],
      }));

      const sessions = await listSessionsFromRegistry({
        sessionsDir,
        agentBusStatePaths: [agentBusStatePath],
      });
      assert.equal(sessions[0].busThreadId, 'thr_room');
      assert.equal(sessions[0].busThreadTitle, 'Release room');
    });
  });

  it('uses the legacy .agent_bus state path as the migration fallback', async () => {
    await withTempDir(async (sessionsDir) => {
      const previousCwd = process.cwd();
      try {
        process.chdir(sessionsDir);
        await mkdir(join(sessionsDir, '.agent_bus'), { recursive: true });
        await writeFile(join(sessionsDir, '.codex_sessions.json'), JSON.stringify([
          { id: 'codex-1', tmuxSession: 'codex-1', workDir: '/tmp/codex', runtime: 'codex' },
        ]));
        await writeFile(join(sessionsDir, '.agent_bus', 'state.json'), JSON.stringify({
          threads: [{
            id: 'thr_legacy',
            title: 'Legacy bus topic',
            status: 'open',
            updatedAt: 1,
            participants: [{ kind: 'codex', sessionId: 'codex-1' }],
          }],
        }));

        const sessions = await listSessionsFromRegistry({
          sessionsDir,
          agentBusStatePaths: [
            join(sessionsDir, '.dueno/state/agent_bus/state.json'),
            join(sessionsDir, '.agent_bus/state.json'),
          ],
        });
        assert.equal(sessions[0].busThreadId, 'thr_legacy');
        assert.equal(sessions[0].busThreadTitle, 'Legacy bus topic');
      } finally {
        process.chdir(previousCwd);
      }
    });
  });

  it('reads migrated runtime session registries from .dueno/state', async () => {
    await withTempDir(async (sessionsDir) => {
      await mkdir(join(sessionsDir, '.dueno', 'state'), { recursive: true });
      await writeFile(join(sessionsDir, '.dueno', 'state', 'claude_sessions.json'), JSON.stringify([
        {
          id: 'api-claude',
          tmuxSession: 'claude-api-claude',
          workDir: '/tmp/runtime-claude',
          runtime: 'claude',
          created: 100,
        },
      ]));
      await writeFile(join(sessionsDir, '.dueno', 'state', 'codex_sessions.json'), JSON.stringify([
        {
          id: 'api-codex',
          tmuxSession: 'codex-api-codex',
          workDir: '/tmp/runtime-codex',
          runtime: 'codex',
          created: 101,
        },
      ]));

      const sessions = await listSessionsFromRegistry({ sessionsDir, agentBusStatePaths: [] });
      assert.deepEqual(
        sessions.map((entry) => [entry.id, entry.runtime, entry.tmuxSession]).sort(),
        [
          ['api-claude', 'claude', 'claude-api-claude'],
          ['api-codex', 'codex', 'codex-api-codex'],
        ]
      );
    });
  });
});
