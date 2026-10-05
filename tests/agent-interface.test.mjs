import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentInterface } from '../modules/agent/interface.mjs';

function canonicalSessionState(status, { state = status, detail = null, interaction = 'none' } = {}) {
  const sendMessage = status === 'ready';
  return {
    state,
    detail,
    status,
    reason: detail || status,
    revision: 1,
    capabilities: {
      sendMessage,
      clear: sendMessage,
      interrupt: status === 'working' || status === 'thinking',
      autoClose: status === 'ended',
      needsAttention: status === 'blocked',
    },
    interaction: { kind: interaction, detail: detail || '', options: [], fingerprint: '' },
  };
}

function bosParsedIds(value = {}) {
  const sessionId = value.result?.session?.id
    || value.session?.id
    || value.result?.sessionId
    || null;
  const threadId = value.result?.threadId
    || value.result?.thread?.id
    || value.thread?.id
    || value.threadId
    || value.session?.threadId
    || null;
  return { sessionId, threadId };
}

function makeMemoryIdempotencyStore(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    setCalls: [],
    async get(key) {
      const value = entries.get(key);
      return value ? JSON.parse(JSON.stringify(value)) : null;
    },
    async set(key, value) {
      this.setCalls.push({ key, value });
      entries.set(key, JSON.parse(JSON.stringify(value)));
      return value;
    },
  };
}

function makeInteractiveRequestMock({
  sessionIds = ['codex_dmr'],
  delaySessionCreateMs = 0,
} = {}) {
  const requests = [];
  let createCount = 0;
  return {
    requests,
    get createCount() {
      return createCount;
    },
    async requestImpl(path, opts = {}) {
      requests.push({ path, opts });
      if (path === '/api/codex/sessions' && opts.method === 'POST') {
        const index = createCount;
        createCount += 1;
        if (delaySessionCreateMs) await new Promise((resolve) => setTimeout(resolve, delaySessionCreateMs));
        return { id: sessionIds[index] || `codex_dmr_${index}`, sessionName: `codex-dmr-${index}` };
      }
      if (/^\/api\/codex\/sessions\/[^/]+\?lines=200$/.test(path)) {
        return {
          id: decodeURIComponent(path.split('/')[4].split('?')[0]),
          content: 'Ready',
          state: canonicalSessionState('ready', { state: 'waiting_for_input', interaction: 'free_text' }),
        };
      }
      if (/^\/api\/codex\/sessions\/[^/]+\/startup-input$/.test(path) && opts.method === 'POST') {
        return { ok: true };
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  };
}

describe('agent interface', () => {
  it('lists enabled providers from backend preferences', async () => {
    const api = buildAgentInterface({
      requestImpl: async () => {
        throw new Error('requestImpl should not be called');
      },
      getPreferences: async () => ({
        claudeEnabled: true,
        codexEnabled: false,
        collabEnabled: false,
        preferredSingleProvider: 'claude',
      }),
    });

    const result = await api.listProviders();
    assert.equal(result.preferredProvider, 'claude');
    assert.equal(result.providers.find((entry) => entry.id === 'claude')?.enabled, true);
    assert.equal(result.providers.find((entry) => entry.id === 'codex')?.enabled, false);
    assert.equal(result.providers.some((entry) => entry.id === 'gsd'), false);
    assert.equal(result.providers.find((entry) => entry.id === 'xai')?.backendType, 'pi');
    assert.equal(result.providers.some((entry) => entry.id === 'openai'), false);
  });

  it('runs one-off tasks through ephemeral session fallback and deletes the session afterward', async () => {
    const requests = [];
    let pollCount = 0;
    const api = buildAgentInterface({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/codex/sessions' && opts.method === 'POST') {
          return { id: 'codex_1', sessionName: 'codex-1', initialPromptInjected: true };
        }
        if (path.startsWith('/api/codex/sessions/codex_1?lines=')) {
          pollCount += 1;
          if (pollCount < 2) {
            return {
              id: 'codex_1',
              content: 'Working...',
              state: canonicalSessionState('working', { detail: 'Running task' }),
            };
          }
          return {
            id: 'codex_1',
            content: 'Final answer',
            state: canonicalSessionState('ready', { state: 'waiting_for_input', interaction: 'free_text' }),
          };
        }
        if (path === '/api/codex/sessions/codex_1' && opts.method === 'DELETE') {
          return { ok: true };
        }
        throw new Error(`Unexpected request: ${path}`);
      },
      getPreferences: async () => ({
        claudeEnabled: true,
        codexEnabled: true,
        preferredSingleProvider: 'codex',
      }),
    });

    const result = await api.runOneOffTask({
      provider: 'codex',
      prompt: 'Run the audit',
      workDir: '/tmp/project',
      mcpProfile: 'dueno',
      mcpServers: { add: ['seodata'], remove: [] },
      timeoutMs: 5000,
      pollIntervalMs: 1,
    });

    assert.deepEqual(result, {
      status: 'completed',
      provider: 'codex',
      backendType: 'codex',
      runtime: 'codex',
      executionMode: 'ephemeral_session_fallback',
      session: {
        id: 'codex_1',
        sessionName: 'codex-1',
        initialPromptInjected: true,
      },
      task: {
        state: 'waiting_for_input',
        status: 'ready',
        reason: 'ready',
        revision: 1,
        detail: 'ready',
        output: 'Final answer',
        timedOut: false,
      },
    });
    assert.equal(requests[0].opts.body.mcpProfile, 'dueno');
    assert.deepEqual(requests[0].opts.body.mcpServers, { add: ['seodata'], remove: [] });
    assert.deepEqual(requests.at(-1), {
      path: '/api/codex/sessions/codex_1',
      opts: { method: 'DELETE' },
    });
  });

  it('does not finish a one-off task on the initial ready snapshot', async () => {
    const requests = [];
    let pollCount = 0;
    const api = buildAgentInterface({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/codex/sessions' && opts.method === 'POST') {
          return { id: 'codex_ready', sessionName: 'codex-ready', initialPromptInjected: true };
        }
        if (path.startsWith('/api/codex/sessions/codex_ready?lines=')) {
          pollCount += 1;
          if (pollCount === 1) {
            return {
              id: 'codex_ready',
              content: '',
              state: canonicalSessionState('ready', { state: 'waiting_for_input', interaction: 'free_text' }),
            };
          }
          if (pollCount === 2) {
            return {
              id: 'codex_ready',
              content: 'Working...',
              state: canonicalSessionState('working', { detail: 'Writing note' }),
            };
          }
          return {
            id: 'codex_ready',
            content: 'Wrote the note',
            state: canonicalSessionState('ready', { state: 'waiting_for_input', interaction: 'free_text' }),
          };
        }
        if (path === '/api/codex/sessions/codex_ready' && opts.method === 'DELETE') {
          return { ok: true };
        }
        throw new Error(`Unexpected request: ${path}`);
      },
      getPreferences: async () => ({
        claudeEnabled: true,
        codexEnabled: true,
        preferredSingleProvider: 'codex',
      }),
    });

    const result = await api.runOneOffTask({
      provider: 'codex',
      prompt: 'Write the release note',
      timeoutMs: 5000,
      pollIntervalMs: 1,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.task.output, 'Wrote the note');
    assert.ok(pollCount >= 3);
    assert.deepEqual(requests.at(-1), {
      path: '/api/codex/sessions/codex_ready',
      opts: { method: 'DELETE' },
    });
  });

  it('cleans up fallback sessions after blocking approval states', async () => {
    const requests = [];
    const api = buildAgentInterface({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/claude/sessions' && opts.method === 'POST') {
          return { id: 'claude_1', sessionName: 'claude-1', initialPromptInjected: true };
        }
        if (path.startsWith('/api/claude/sessions/claude_1?lines=')) {
          return {
            id: 'claude_1',
            content: 'Need approval',
            state: canonicalSessionState('blocked', { state: 'needs_approval', detail: 'Approve file write', interaction: 'permission' }),
          };
        }
        if (path === '/api/claude/sessions/claude_1' && opts.method === 'DELETE') {
          return { ok: true };
        }
        throw new Error(`Unexpected request: ${path}`);
      },
      getPreferences: async () => ({
        claudeEnabled: true,
        codexEnabled: true,
        preferredSingleProvider: 'claude',
      }),
    });

    await assert.rejects(
      () => api.runOneOffTask({
        provider: 'claude',
        model: 'claude-opus-4-8',
        prompt: 'Write a patch',
        timeoutMs: 5000,
        pollIntervalMs: 1,
      }),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.taskExecution.provider, 'claude');
        assert.equal(error.taskExecution.backendType, 'claude');
        assert.equal(error.taskExecution.task.state, 'needs_approval');
        return true;
      },
    );
    assert.deepEqual(requests.at(-1), {
      path: '/api/claude/sessions/claude_1',
      opts: { method: 'DELETE' },
    });
  });

  it('rejects removed provider aliases', async () => {
    const api = buildAgentInterface({
      async requestImpl() {
        throw new Error('requestImpl should not be called');
      },
      getPreferences: async () => ({
        claudeEnabled: true,
        codexEnabled: true,
        preferredSingleProvider: 'codex',
      }),
    });

    await assert.rejects(
      () => api.runOneOffTask({
        provider: 'gsd',
        model: 'gpt-5.5',
        prompt: 'Alias check',
      }),
      /provider must be claude, codex, codex-app-server, deepseek, xai, google, opencode-go, or openrouter/,
    );
  });

  it('creates a standalone session with the initial task at launch without creating a room', async () => {
    const requests = [];
    const api = buildAgentInterface({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/codex/sessions' && opts.method === 'POST') {
          return { id: 'codex_solo', sessionName: 'codex-solo', initialPromptInjected: true };
        }
        if (path === '/api/codex/sessions/codex_solo?lines=200') {
          return {
            id: 'codex_solo',
            content: 'Ready',
            state: canonicalSessionState('ready', { state: 'waiting_for_input', interaction: 'free_text' }),
          };
        }
        if (path === '/api/codex/sessions/codex_solo/startup-input' && opts.method === 'POST') {
          return { ok: true };
        }
        throw new Error(`Unexpected request: ${path}`);
      },
      getPreferences: async () => ({
        claudeEnabled: true,
        codexEnabled: true,
        preferredSingleProvider: 'codex',
      }),
    });

    const result = await api.createInteractiveSession({
      provider: 'codex',
      workDir: '/tmp/project',
      displayName: 'Solo agent',
      initialPrompt: 'Review the failing tests and report back.',
    });

    assert.equal(result.id, 'codex_solo');
    assert.equal(result.provider, 'codex');
    assert.equal(result.backendType, 'codex');
    assert.equal(result.executionMode, 'interactive_session');
    assert.equal(result.initialPromptInjected, true);
    assert.equal(result.session.initialPromptInjected, true);
    assert.equal(result.thread, null);
    assert.equal(result.session?.id, 'codex_solo');
    assert.equal(result.session?.threadId, '');
    assert.equal(result.workspaceDir, '/tmp/project');
    assert.equal(requests[0].path, '/api/codex/sessions');
    assert.equal(requests[0].opts.method, 'POST');
    assert.equal(requests[0].opts.body.workDir, '/tmp/project');
    assert.equal(requests[0].opts.body.displayName, 'Solo agent');
    assert.equal(requests[0].opts.body.provider, 'codex');
    assert.equal(typeof requests[0].opts.body.model, 'string');
    assert.ok(requests[0].opts.body.model.length > 0);
    assert.equal(requests.some((request) => request.path === '/api/agent-bus/threads'), false);
    assert.equal(requests[0].opts.body.initialPrompt, 'Review the failing tests and report back.');
    assert.equal(requests.length, 1);
  });

  it('routes xAI models through Pi without merging provider and model', async () => {
    const requests = [];
    const api = buildAgentInterface({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/pi/sessions' && opts.method === 'POST') {
          return { id: 'pi_xai', sessionName: 'pi-pi_xai' };
        }
        throw new Error(`Unexpected request: ${path}`);
      },
      getPreferences: async () => ({
        claudeEnabled: true,
        codexEnabled: true,
        preferredSingleProvider: 'codex',
      }),
    });

    const result = await api.createInteractiveSession({
      provider: 'xai',
      model: 'grok-4.6',
      workDir: '/tmp/project',
    });

    assert.equal(result.provider, 'xai');
    assert.equal(result.backendType, 'pi');
    assert.equal(result.runtime, 'pi');
    assert.equal(requests[0].path, '/api/pi/sessions');
    assert.equal(requests[0].opts.body.provider, 'xai');
    assert.equal(requests[0].opts.body.model, 'grok-4.6');
    assert.equal(requests.length, 1);
  });

  it('creates interactive sessions inside an isolated worktree when requested', async () => {
    const requests = [];
    const worktreeCalls = [];
    const api = buildAgentInterface({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/codex/sessions' && opts.method === 'POST') {
          return { id: 'codex_wt', sessionName: 'codex-wt' };
        }
        if (path === '/api/codex/sessions/codex_wt?lines=200') {
          return {
            id: 'codex_wt',
            content: 'Ready',
            state: canonicalSessionState('ready', { state: 'waiting_for_input', interaction: 'free_text' }),
          };
        }
        if (path === '/api/codex/sessions/codex_wt/startup-input' && opts.method === 'POST') {
          return { ok: true };
        }
        throw new Error(`Unexpected request: ${path}`);
      },
      getPreferences: async () => ({
        claudeEnabled: true,
        codexEnabled: true,
        preferredSingleProvider: 'codex',
      }),
      now: () => 1234,
      worktreeBaseDir: '/tmp/agent-worktrees',
      worktreeCreator: async (input) => {
        worktreeCalls.push(input);
        return {
          repoPath: '/tmp/project',
          worktreePath: '/tmp/agent-worktrees/worktrees/agents/Worktree-agent/Project',
          branch: 'dueno-fleet/agent/Worktree-agent',
          baseRef: 'origin/main',
        };
      },
    });

    const result = await api.createInteractiveSession({
      provider: 'codex',
      workDir: '/tmp/project',
      displayName: 'Worktree agent',
      isolatedWorktree: true,
    });

    assert.equal(worktreeCalls.length, 1);
    assert.deepEqual(worktreeCalls[0], {
      repoPath: '/tmp/project',
      baseDir: '/tmp/agent-worktrees',
      displayName: 'Worktree agent',
      nowMs: 1234,
    });
    assert.equal(requests[0].opts.body.workDir, '/tmp/agent-worktrees/worktrees/agents/Worktree-agent/Project');
    assert.equal(requests[0].opts.body.metadata.isolatedWorktree, true);
    assert.equal(requests[0].opts.body.metadata.requestedWorkDir, '/tmp/project');
    assert.equal(requests[0].opts.body.metadata.worktreeBaseRef, 'origin/main');
    assert.equal(result.workspaceDir, '/tmp/agent-worktrees/worktrees/agents/Worktree-agent/Project');
    assert.equal(result.requestedWorkspaceDir, '/tmp/project');
    assert.equal(result.isolatedWorktree, true);
    assert.equal(result.worktree.branch, 'dueno-fleet/agent/Worktree-agent');
  });

  it('does not inject startup text into interactive sessions without an initial task', async () => {
    const requests = [];
    const api = buildAgentInterface({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/codex/sessions' && opts.method === 'POST') {
          return { id: 'codex_wait', sessionName: 'codex-wait' };
        }
        throw new Error(`Unexpected request: ${path}`);
      },
      getPreferences: async () => ({
        claudeEnabled: true,
        codexEnabled: true,
        preferredSingleProvider: 'codex',
      }),
    });

    const result = await api.createInteractiveSession({
      provider: 'codex',
      workDir: '/tmp/project',
      displayName: 'Waiting agent',
    });

    assert.equal(result.initialPromptInjected, false);
    assert.equal(requests.some((request) => request.path.includes('/startup-input')), false);
  });

  it('does not replay an initial prompt that reached the composer unconfirmed', async () => {
    const requests = [];
    const api = buildAgentInterface({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/codex/sessions' && opts.method === 'POST') {
          return {
            id: 'codex_unconfirmed',
            sessionName: 'codex-unconfirmed',
            initialPromptInjected: false,
            initialPromptError: 'Initial prompt was delivered to the composer but submission was not confirmed',
            initialPromptDelivery: { submission: 'unconfirmed' },
          };
        }
        throw new Error(`Unexpected request: ${path}`);
      },
      getPreferences: async () => ({
        claudeEnabled: true,
        codexEnabled: true,
        preferredSingleProvider: 'codex',
      }),
    });

    const result = await api.createInteractiveSession({
      provider: 'codex',
      workDir: '/tmp/project',
      displayName: 'Unconfirmed agent',
      initialPrompt: 'Do the work.',
    });

    assert.equal(result.initialPromptInjected, false);
    assert.equal(result.session.initialPromptInjected, false);
    assert.match(result.initialPromptError, /submission was not confirmed/);
    assert.equal(result.session.initialPromptError, result.initialPromptError);
    assert.equal(requests.some((request) => request.path.includes('/startup-input')), false);
    assert.equal(requests.some((request) => request.opts.method === 'DELETE'), false);
  });

  it('does not replay an unconfirmed initial prompt reported only by error text', async () => {
    const requests = [];
    const api = buildAgentInterface({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/codex/sessions' && opts.method === 'POST') {
          return {
            id: 'codex_unconfirmed_error',
            sessionName: 'codex-unconfirmed-error',
            initialPromptInjected: false,
            initialPromptError: 'Initial prompt was delivered to the composer but submission was not confirmed',
          };
        }
        throw new Error(`Unexpected request: ${path}`);
      },
      getPreferences: async () => ({
        claudeEnabled: true,
        codexEnabled: true,
        preferredSingleProvider: 'codex',
      }),
    });

    const result = await api.createInteractiveSession({
      provider: 'codex',
      workDir: '/tmp/project',
      displayName: 'Unconfirmed error agent',
      initialPrompt: 'Do the work.',
    });

    assert.equal(result.initialPromptInjected, false);
    assert.equal(requests.some((request) => request.path.includes('/startup-input')), false);
    assert.equal(requests.some((request) => request.opts.method === 'DELETE'), false);
  });

  it('propagates an initial prompt launch failure without pasting a fallback', async () => {
    const requests = [];
    const api = buildAgentInterface({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        throw new Error('Initial prompt exceeds launch limit');
      },
      getPreferences: async () => ({ claudeEnabled: true, preferredSingleProvider: 'claude' }),
    });
    await assert.rejects(() => api.createInteractiveSession({
      provider: 'claude', initialPrompt: 'Start work',
    }), /Initial prompt exceeds launch limit/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/api/claude/sessions');
  });

  it('passes BusinessOS MCP selection to session creation without putting secrets in prompts or thread metadata', async () => {
    const secret = 'bos-secret-not-in-prompt';
    const requests = [];
    const api = buildAgentInterface({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/codex/sessions' && opts.method === 'POST') {
          return { id: 'codex_bos', sessionName: 'codex-bos' };
        }
        if (/^\/api\/codex\/sessions\/codex_bos\?lines=200$/.test(path)) {
          return {
            id: 'codex_bos',
            content: 'Ready',
            state: canonicalSessionState('ready', { state: 'waiting_for_input', interaction: 'free_text' }),
          };
        }
        if (path === '/api/codex/sessions/codex_bos/startup-input' && opts.method === 'POST') {
          return { ok: true };
        }
        throw new Error(`Unexpected request: ${path}`);
      },
      getPreferences: async () => ({
        claudeEnabled: true,
        codexEnabled: true,
        preferredSingleProvider: 'codex',
      }),
    });

    await api.createInteractiveSession({
      provider: 'codex',
      displayName: 'BOS work',
      initialPrompt: 'Use available context.',
      mcpServers: {
        add: ['businessos'],
      },
    });

    const sessionCreate = requests.find((entry) => entry.path === '/api/codex/sessions');
    assert.deepEqual(sessionCreate.opts.body.mcpServers, { add: ['businessos'] });
    assert.equal(Object.hasOwn(sessionCreate.opts.body, 'selectedMcpServers'), false);
    const serializedRequests = JSON.stringify(requests);
    assert.equal(serializedRequests.includes(secret), false);
    assert.equal(sessionCreate.opts.body.initialPrompt.includes('businessos'), false);
    assert.equal(requests.some((entry) => entry.path.endsWith('/startup-input')), false);
    assert.equal(requests.some((entry) => entry.path === '/api/agent-bus/threads'), false);
  });
  it('returns a BusinessOS-compatible standalone session pointer while preserving fleet fields', async () => {
    const mock = makeInteractiveRequestMock();
    const api = buildAgentInterface({
      requestImpl: mock.requestImpl,
      getPreferences: async () => ({
        claudeEnabled: true,
        codexEnabled: true,
        preferredSingleProvider: 'codex',
      }),
    });

    const result = await api.createInteractiveSessionIdempotent({
      provider: 'codex',
      executor: 'tmux',
      workDir: '/tmp/bos',
      displayName: 'BusinessOS debug',
      initialPrompt: 'Inspect this diagnostic.',
      idempotencyKey: '',
    });

    assert.equal(result.id, 'codex_dmr');
    assert.equal(result.thread, null);
    assert.equal(result.session.id, 'codex_dmr');
    assert.equal(result.session.threadId, '');
    assert.deepEqual(bosParsedIds(result), { sessionId: 'codex_dmr', threadId: null });
    assert.equal(result.provider, 'codex');
    assert.equal(result.backendType, 'codex');
    assert.equal(result.executionMode, 'interactive_session');
    assert.equal(result.workspaceDir, '/tmp/bos');
  });

  it('replays the same idempotencyKey without spawning twice when the session still exists', async () => {
    const store = makeMemoryIdempotencyStore();
    const mock = makeInteractiveRequestMock();
    const api = buildAgentInterface({
      requestImpl: mock.requestImpl,
      idempotencyStore: store,
      idempotencyTtlMs: 3_600_000,
      now: () => 10_000,
      sessionExistsImpl: async () => true,
      getPreferences: async () => ({
        claudeEnabled: true,
        codexEnabled: true,
        preferredSingleProvider: 'codex',
      }),
    });

    const first = await api.createInteractiveSessionIdempotent({
      provider: 'codex',
      workDir: '/tmp/bos',
      displayName: 'BusinessOS debug',
      initialPrompt: 'One',
      idempotencyKey: 'bos-key-1',
    });
    const second = await api.createInteractiveSessionIdempotent({
      provider: 'codex',
      workDir: '/tmp/bos',
      displayName: 'BusinessOS debug',
      initialPrompt: 'One retry',
      idempotencyKey: 'bos-key-1',
    });

    assert.equal(mock.createCount, 1);
    assert.equal(first.id, 'codex_dmr');
    assert.equal(second.id, 'codex_dmr');
    assert.equal(second.session.id, 'codex_dmr');
    assert.equal(second.session.threadId, '');
    assert.equal(second.idempotencyReplay, true);
  });

  it('recreates when the idempotency ledger hit is fresh but the tmux-backed session is gone', async () => {
    const store = makeMemoryIdempotencyStore({
      'bos-key-stale': {
        sessionId: 'codex_old',
        threadId: 'thr_old',
        backendType: 'codex',
        provider: 'codex',
        runtime: 'codex',
        createdAtMs: 10_000,
      },
    });
    const mock = makeInteractiveRequestMock({ sessionIds: ['codex_new'] });
    const api = buildAgentInterface({
      requestImpl: mock.requestImpl,
      idempotencyStore: store,
      idempotencyTtlMs: 3_600_000,
      now: () => 11_000,
      sessionExistsImpl: async () => false,
      getPreferences: async () => ({
        claudeEnabled: true,
        codexEnabled: true,
        preferredSingleProvider: 'codex',
      }),
    });

    const result = await api.createInteractiveSessionIdempotent({
      provider: 'codex',
      workDir: '/tmp/bos',
      displayName: 'BusinessOS debug',
      initialPrompt: 'Recreate',
      idempotencyKey: 'bos-key-stale',
    });

    assert.equal(mock.createCount, 1);
    assert.equal(result.id, 'codex_new');
    assert.equal(result.session.threadId, '');
    assert.equal(store.setCalls.at(-1).value.threadId, '');
    assert.equal(store.setCalls.at(-1).value.sessionId, 'codex_new');
  });

  it('creates normally without an idempotencyKey', async () => {
    const store = makeMemoryIdempotencyStore();
    const mock = makeInteractiveRequestMock({ sessionIds: ['codex_a', 'codex_b'] });
    const api = buildAgentInterface({
      requestImpl: mock.requestImpl,
      idempotencyStore: store,
      sessionExistsImpl: async () => true,
      getPreferences: async () => ({
        claudeEnabled: true,
        codexEnabled: true,
        preferredSingleProvider: 'codex',
      }),
    });

    const first = await api.createInteractiveSessionIdempotent({ provider: 'codex', initialPrompt: 'A' });
    const second = await api.createInteractiveSessionIdempotent({ provider: 'codex', initialPrompt: 'B' });

    assert.equal(mock.createCount, 2);
    assert.equal(first.id, 'codex_a');
    assert.equal(second.id, 'codex_b');
    assert.equal(store.setCalls.length, 0);
  });

  it('coalesces concurrent same-key creates behind one spawn', async () => {
    const store = makeMemoryIdempotencyStore();
    const mock = makeInteractiveRequestMock({ delaySessionCreateMs: 20 });
    const api = buildAgentInterface({
      requestImpl: mock.requestImpl,
      idempotencyStore: store,
      idempotencyTtlMs: 3_600_000,
      now: () => 10_000,
      sessionExistsImpl: async () => false,
      getPreferences: async () => ({
        claudeEnabled: true,
        codexEnabled: true,
        preferredSingleProvider: 'codex',
      }),
    });

    const [first, second] = await Promise.all([
      api.createInteractiveSessionIdempotent({ provider: 'codex', initialPrompt: 'A', idempotencyKey: 'same-key' }),
      api.createInteractiveSessionIdempotent({ provider: 'codex', initialPrompt: 'A', idempotencyKey: 'same-key' }),
    ]);

    assert.equal(mock.createCount, 1);
    assert.equal(first.id, 'codex_dmr');
    assert.equal(second.id, 'codex_dmr');
    assert.equal(store.setCalls.length, 1);
  });

});
