import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMonitorMcpServer } from '../modules/platform/monitor-mcp.mjs';
import { config } from '../config.mjs';

describe('Monitor MCP server', () => {
  it('exposes command center human queue tools and routes them to API endpoints', async () => {
    const calls = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        calls.push({ path, opts });
        if (path === '/api/command-center/work-queue?status=open') {
          return { items: [{ id: 'ccq_1' }], openCount: 1 };
        }
        if (path === '/api/command-center/work-queue') {
          return { id: 'ccq_2', question: opts.body.question };
        }
        if (path === '/api/command-center/work-queue/ccq_2/answer') {
          return { id: 'ccq_2', status: 'answered' };
        }
        if (path === '/api/command-center/work-queue/ccq_2/acknowledge') {
          return { id: 'ccq_2', status: 'acknowledged' };
        }
        if (path === '/api/command-center/work-queue/ccq_3/dismiss') {
          return { id: 'ccq_3', status: 'dismissed' };
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    const toolNames = server.listTools().map((tool) => tool.name);
    assert.ok(toolNames.includes('monitor_list_human_queue'));
    assert.ok(toolNames.includes('monitor_add_human_queue_item'));
    assert.ok(toolNames.includes('monitor_answer_human_queue_item'));
    assert.ok(toolNames.includes('monitor_dismiss_human_queue_item'));
    assert.ok(toolNames.includes('monitor_list_pi_sessions'));
    assert.deepEqual(
      server.listTools().find((tool) => tool.name === 'monitor_list_human_queue').inputSchema.properties.status.enum,
      ['open', 'answered', 'routed', 'delivery_failed', 'acknowledged', 'dismissed', 'all'],
    );

    assert.deepEqual(await server.handleToolCall('monitor_list_human_queue', {}), {
      items: [{ id: 'ccq_1' }],
      openCount: 1,
    });
    assert.deepEqual(await server.handleToolCall('monitor_add_human_queue_item', {
      question: 'Need judgment?',
      passThrough: true,
      options: [{ id: 'yes', label: 'Yes' }],
    }), {
      id: 'ccq_2',
      question: 'Need judgment?',
    });
    assert.deepEqual(await server.handleToolCall('monitor_answer_human_queue_item', {
      id: 'ccq_2',
      optionId: 'yes',
    }), {
      id: 'ccq_2',
      status: 'answered',
    });
    assert.deepEqual(await server.handleToolCall('monitor_acknowledge_human_queue_item', {
      id: 'ccq_2',
      note: 'Session acted',
    }), {
      id: 'ccq_2',
      status: 'acknowledged',
    });
    assert.deepEqual(await server.handleToolCall('monitor_dismiss_human_queue_item', { id: 'ccq_3' }), {
      id: 'ccq_3',
      status: 'dismissed',
    });

    assert.deepEqual(calls, [
      { path: '/api/command-center/work-queue?status=open', opts: {} },
      {
        path: '/api/command-center/work-queue',
        opts: {
          method: 'POST',
          body: {
            question: 'Need judgment?',
            passThrough: true,
            options: [{ id: 'yes', label: 'Yes' }],
          },
        },
      },
      {
        path: '/api/command-center/work-queue/ccq_2/answer',
        opts: {
          method: 'POST',
          body: { answer: undefined, optionId: 'yes', optionValue: undefined },
        },
      },
      {
        path: '/api/command-center/work-queue/ccq_2/acknowledge',
        opts: {
          method: 'POST',
          body: { note: 'Session acted' },
        },
      },
      {
        path: '/api/command-center/work-queue/ccq_3/dismiss',
        opts: { method: 'POST', body: {} },
      },
    ]);
  });

  it('returns compact paginated open thread summaries by default', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path) {
        requests.push(path);
        if (path === '/api/agent-bus/threads?status=open') {
          return {
            threads: [
              { id: 'thr_open_1', title: 'Open 1', status: 'open', participants: [{}, {}], createdAt: 1, updatedAt: 2, projectKey: '/a' },
              { id: 'thr_open_2', title: 'Open 2', status: 'open', participants: [{}], createdAt: 3, updatedAt: 4, projectKey: '/b' },
            ],
          };
        }
        if (path === '/api/agent-bus/threads/thr_open_1?messageLimit=0&deliveryLimit=0') {
          return { messageCount: 7, deliveryCount: 8, latestMessageAt: 11, latestDeliveryAt: 12, messages: [], deliveries: [] };
        }
        if (path === '/api/agent-bus/threads/thr_open_2?messageLimit=0&deliveryLimit=0') {
          return { messageCount: 3, deliveryCount: 4, latestMessageAt: 13, latestDeliveryAt: 14, messages: [], deliveries: [] };
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    const result = await server.handleToolCall('monitor_list_threads', {});

    assert.deepEqual(requests, [
      '/api/agent-bus/threads?status=open',
      '/api/agent-bus/threads/thr_open_1?messageLimit=0&deliveryLimit=0',
      '/api/agent-bus/threads/thr_open_2?messageLimit=0&deliveryLimit=0',
    ]);
    assert.deepEqual(result, {
      status: 'open',
      threadCount: 2,
      total: 2,
      limit: 25,
      offset: 0,
      hasMore: false,
      compact: true,
      includeMessages: false,
      threads: [
        {
          id: 'thr_open_1',
          title: 'Open 1',
          status: 'open',
          health: 'ok',
          live_process_count: 0,
          projectKey: '/a',
          participantCount: 2,
          messageCount: 7,
          deliveryCount: 8,
          createdAt: 1,
          updatedAt: 2,
          latestMessageAt: 11,
          latestDeliveryAt: 12,
        },
        {
          id: 'thr_open_2',
          title: 'Open 2',
          status: 'open',
          health: 'ok',
          live_process_count: 0,
          projectKey: '/b',
          participantCount: 1,
          messageCount: 3,
          deliveryCount: 4,
          createdAt: 3,
          updatedAt: 4,
          latestMessageAt: 13,
          latestDeliveryAt: 14,
        },
      ],
    });
  });

  it('supports thread pagination, status=all, fields filtering, and optional messages', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path) {
        requests.push(path);
        if (path === '/api/agent-bus/threads') {
          return {
            threads: [
              { id: 'thr_1', title: 'One', status: 'open', participants: [] },
              { id: 'thr_2', title: 'Two', status: 'stale', participants: [{}] },
              { id: 'thr_3', title: 'Three', status: 'closed', participants: [{}, {}] },
            ],
          };
        }
        if (path === '/api/agent-bus/threads/thr_2?messageLimit=2&deliveryLimit=0') {
          return {
            messageCount: 9,
            deliveryCount: 1,
            latestMessageAt: 20,
            latestDeliveryAt: 21,
            messagesTruncated: true,
            messages: [{ id: 'msg_1' }, { id: 'msg_2' }],
            deliveries: [],
          };
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    const result = await server.handleToolCall('monitor_list_threads', {
      status: 'all',
      limit: 1,
      offset: 1,
      include_messages: true,
      message_limit: 2,
      fields: ['id', 'messageCount', 'messages'],
    });

    assert.deepEqual(requests, [
      '/api/agent-bus/threads',
      '/api/agent-bus/threads/thr_2?messageLimit=2&deliveryLimit=0',
    ]);
    assert.deepEqual(result, {
      status: 'all',
      threadCount: 1,
      total: 3,
      limit: 1,
      offset: 1,
      hasMore: true,
      compact: true,
      includeMessages: true,
      threads: [
        {
          id: 'thr_2',
          messageCount: 9,
          messages: [{ id: 'msg_1' }, { id: 'msg_2' }],
        },
      ],
    });
  });

  it('returns compact paginated session summaries by default', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path) {
        requests.push(path);
        if (path === '/api/claude/sessions') {
          return {
            sessions: [
              {
                id: 'claude_1',
                name: 'claude-1',
                displayName: 'Coordinator',
                workDir: '/tmp/project',
                source: 'dashboard',
                created: 100,
                state: { state: 'working', detail: 'Running task', needsInput: false },
                attention: { active: true, kind: 'prompt_ready', label: 'Prompt Ready', createdAt: 101 },
              },
              {
                id: 'claude_2',
                name: 'claude-2',
                displayName: '',
                workDir: '/tmp/project-2',
                source: 'tmux-external',
                created: 200,
                state: { state: 'active', detail: null, needsInput: false },
                attention: null,
              },
            ],
          };
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    const result = await server.handleToolCall('monitor_list_claude_sessions', {
      limit: 1,
      fields: ['id', 'displayName', 'state'],
    });

    assert.deepEqual(requests, ['/api/claude/sessions']);
    assert.deepEqual(result, {
      sessionCount: 1,
      total: 2,
      limit: 1,
      offset: 0,
      hasMore: true,
      compact: true,
      sessions: [
        {
          id: 'claude_1',
          displayName: 'Coordinator',
          state: 'working',
        },
      ],
    });
  });

  it('lists Pi sessions through the Pi backend route', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path) {
        requests.push(path);
        if (path === '/api/pi/sessions') {
          return { sessions: [{ id: 'pi_1', provider: 'xai', model: 'grok-4.3' }] };
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    const result = await server.handleToolCall('monitor_list_pi_sessions', { compact: false });
    assert.deepEqual(requests, ['/api/pi/sessions']);
    assert.deepEqual(result.sessions, [{ id: 'pi_1', provider: 'xai', model: 'grok-4.3' }]);
  });

  it('sends session text via a single input request with enter=true', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/claude/sessions/claude_1/input') {
          return { ok: true, accepted: true, transactionId: 'cmd_1', state: 'queued' };
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    const result = await server.handleToolCall('monitor_send_to_session', {
      type: 'claude',
      sessionId: 'claude_1',
      text: 'Ping',
    });

    assert.deepEqual(requests, [{
      path: '/api/claude/sessions/claude_1/input',
      opts: { method: 'POST', body: { text: 'Ping', enter: true, source: 'monitor_send_to_session' } },
    }]);
    assert.deepEqual(result, {
      ok: true,
      accepted: true,
      transactionId: 'cmd_1',
      state: 'queued',
    });
  });

  it('lists direct session delivery audit records', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/session-deliveries?kind=codex&sessionId=codex_1&source=monitor_send_to_session&status=sent&limit=5') {
          return {
            deliveries: [{
              id: 'sdel_1',
              source: 'monitor_send_to_session',
              status: 'sent',
              target: { kind: 'codex', sessionId: 'codex_1' },
            }],
          };
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    const result = await server.handleToolCall('monitor_list_session_deliveries', {
      type: 'codex',
      sessionId: 'codex_1',
      source: 'monitor_send_to_session',
      status: 'sent',
      limit: 5,
    });

    assert.deepEqual(requests, [{
      path: '/api/session-deliveries?kind=codex&sessionId=codex_1&source=monitor_send_to_session&status=sent&limit=5',
      opts: {},
    }]);
    assert.equal(result.deliveries.length, 1);
    assert.equal(result.deliveries[0].id, 'sdel_1');
  });

  it('exposes session delivery status in listTools and describes send as queue acceptance', () => {
    const server = buildMonitorMcpServer({
      async requestImpl() { throw new Error('unused'); },
    });
    const tools = server.listTools();
    assert.equal(tools.some((tool) => tool.name === 'monitor_list_session_deliveries'), true);
    const send = tools.find((tool) => tool.name === 'monitor_send_to_session');
    assert.match(send.description, /queue acceptance only/i);
    assert.match(send.description, /monitor_list_session_deliveries/);
    assert.match(send.description, /keystrokes/i);
    assert.match(send.description, /room_send\/agent_dm/);
    const deliveries = tools.find((tool) => tool.name === 'monitor_list_session_deliveries');
    assert.match(deliveries.description, /append-only/i);
    assert.match(deliveries.description, /newest first/i);
    assert.match(deliveries.description, /metadata\.confirmation/);
  });

  it('shows pending sent prompts as non-actionable in compact session lists', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/codex/sessions/codex_1/input') return { ok: true, sentAt: 1234 };
        if (path === '/api/codex/sessions') {
          return {
            sessions: [{
              id: 'codex_1',
              name: 'codex-1',
              state: {
                state: 'active',
                detail: 'Prompt sent; awaiting response',
                needsInput: false,
                status: 'awaiting_response',
                reason: 'Awaiting post-send progress',
                revision: 7,
                capabilities: { sendMessage: false, clear: false, interrupt: true, autoClose: false, needsAttention: false },
                interaction: { kind: 'none', detail: '', options: [], fingerprint: '' },
                runtime: { requestedModel: 'gpt-test', requestedThinkingLevel: 'high', effectiveModel: 'gpt-test', effectiveThinkingLevel: 'high' },
                pendingResponse: true,
                sentAt: 1234,
              },
              pendingResponse: { sentAt: 1234 },
              attention: { active: true, kind: 'prompt_ready', label: 'Prompt Ready', createdAt: 1000 },
            }],
          };
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    await server.handleToolCall('monitor_send_to_session', {
      type: 'codex',
      sessionId: 'codex_1',
      text: 'Proceed',
    });
    const result = await server.handleToolCall('monitor_list_codex_sessions', {});

    assert.deepEqual(requests.map((entry) => entry.path), [
      '/api/codex/sessions/codex_1/input',
      '/api/codex/sessions',
    ]);
    assert.equal(result.sessions[0].pendingResponse, true);
    assert.equal(result.sessions[0].sentAt, 1234);
    assert.equal(result.sessions[0].needsInput, false);
    assert.equal(result.sessions[0].status, 'awaiting_response');
    assert.equal(result.sessions[0].capabilities.sendMessage, false);
    assert.equal(result.sessions[0].reason, 'Awaiting post-send progress');
    assert.equal(result.sessions[0].revision, 7);
    assert.equal(result.sessions[0].interaction.kind, 'none');
    assert.equal(result.sessions[0].runtime.effectiveModel, 'gpt-test');
    assert.equal(result.sessions[0].attention, null);
  });

  it('fetches captured output for a direct backend session', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path) {
        requests.push(path);
        if (path === '/api/codex/sessions/codex_1?lines=120') {
          return {
            id: 'codex_1',
            sessionName: 'codex-1',
            content: 'latest output',
            state: { state: 'waiting_for_input', detail: null, needsInput: true },
          };
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    const result = await server.handleToolCall('monitor_get_session_output', {
      type: 'codex',
      sessionId: 'codex_1',
      lines: 120,
    });

    assert.deepEqual(requests, ['/api/codex/sessions/codex_1?lines=120']);
    assert.deepEqual(result, {
      id: 'codex_1',
      sessionName: 'codex-1',
      content: 'latest output',
      state: { state: 'waiting_for_input', detail: null, needsInput: true },
    });
  });

  it('rejects unknown providers when fetching output', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path) {
        requests.push(path);
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    await assert.rejects(
      () => server.handleToolCall('monitor_get_session_output', {
        type: 'gsd',
        sessionId: 'agent_1',
      }),
      /provider must be claude, codex, codex-app-server, deepseek, xai, google, opencode-go, or openrouter/,
    );
    assert.deepEqual(requests, []);
  });

  it('forwards initialPrompt when spawning a single session', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/claude/sessions') {
          return { id: 'claude_9', sessionName: 'claude-9', initialPromptInjected: true, initialPromptError: null };
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    const result = await server.handleToolCall('monitor_spawn_claude', {
      workDir: '/tmp/project',
      displayName: 'Coordinator',
      model: 'claude-opus-4-8',
      initialPrompt: '/skill-name',
    });

    assert.deepEqual(requests, [{
      path: '/api/claude/sessions',
      opts: {
        method: 'POST',
        body: {
          workDir: '/tmp/project',
          displayName: 'Coordinator',
          model: 'claude-opus-4-8',
          initialPrompt: '/skill-name',
          mcpProfile: 'dueno',
        },
      },
    }]);
    assert.deepEqual(result, { id: 'claude_9', sessionName: 'claude-9', initialPromptInjected: true, initialPromptError: null });
  });

  it('passes Codex plugin opt-in through legacy and unified single-session entry points', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        return { id: `codex_${requests.length}`, provider: 'codex', backendType: 'codex', runtime: 'codex' };
      },
    });
    const codexPlugins = { add: ['browser@openai-bundled'] };

    await server.handleToolCall('monitor_spawn_codex', { codexPlugins });
    await server.handleToolCall('spawn_session', { provider: 'codex', codexPlugins });

    assert.deepEqual(requests.map(({ path, opts }) => ({ path, codexPlugins: opts.body.codexPlugins })), [
      { path: '/api/codex/sessions', codexPlugins },
      { path: '/api/agents/sessions', codexPlugins },
    ]);
    for (const name of ['monitor_spawn_codex', 'spawn_session']) {
      const schema = server.listTools().find((tool) => tool.name === name).inputSchema.properties.codexPlugins;
      assert.equal(schema.additionalProperties, false);
      assert.match(schema.description, /Separate from Fleet skills and mcpServers/);
    }

    await server.handleToolCall('spawn_session', { provider: 'claude', codexPlugins });
    assert.equal(Object.hasOwn(requests[2].opts.body, 'codexPlugins'), false);
  });

  it('routes spawn_session through the Claude backend', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/agents/sessions') {
          return { id: 'claude_10', sessionName: 'claude-10', provider: 'claude', backendType: 'claude', runtime: 'claude' };
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    const result = await server.handleToolCall('spawn_session', {
      provider: 'claude',
      workDir: '/tmp/project',
      displayName: 'General session',
      model: 'claude-opus-4-8',
      thinkingLevel: 'high',
      initialPrompt: 'Start here',
      skills: ['tdd'],
    });

    assert.deepEqual(requests, [{
      path: '/api/agents/sessions',
      opts: {
        method: 'POST',
        body: {
          workDir: '/tmp/project',
          displayName: 'General session',
            model: 'claude-opus-4-8',
            provider: 'claude',
          thinkingLevel: 'high',
          initialPrompt: 'Start here',
          skills: ['tdd'],
          mcpProfile: 'dueno',
          structured: true,
        },
      },
    }]);
    assert.deepEqual(result, {
      id: 'claude_10',
      sessionName: 'claude-10',
      provider: 'claude',
      backendType: 'claude',
      runtime: 'claude',
    });
  });

  it('accepts parentThreadId on spawn_session and attaches the participant best-effort', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/agents/sessions') {
          return {
            id: 'codex_parent',
            session: { id: 'codex_parent', threadId: 'thr_new' },
            thread: { id: 'thr_new' },
            provider: 'codex',
            backendType: 'codex',
          };
        }
        if (path === '/api/agent-bus/threads/thr_existing/participants') {
          return { thread: { id: 'thr_existing' }, participant: opts.body.participant };
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    const spawnTool = server.listTools().find((tool) => tool.name === 'spawn_session');
    assert.ok(spawnTool.inputSchema.properties.parentThreadId);

    const result = await server.handleToolCall('spawn_session', {
      provider: 'codex',
      workDir: '/tmp/project',
      parentThreadId: 'thr_existing',
    });

    assert.deepEqual(requests, [
      {
        path: '/api/agents/sessions',
        opts: {
          method: 'POST',
          body: {
            workDir: '/tmp/project',
            displayName: undefined,
            model: undefined,
            provider: 'codex',
            thinkingLevel: undefined,
            initialPrompt: undefined,
            mcpProfile: 'dueno',
            structured: true,
          },
        },
      },
      {
        path: '/api/agent-bus/threads/thr_existing/participants',
        opts: {
          method: 'POST',
          body: { participant: { kind: 'codex', sessionId: 'codex_parent' } },
        },
      },
    ]);
    assert.equal(result.session.id, 'codex_parent');
    assert.equal(result.session.threadId, 'thr_new');
    assert.equal(result.parentThread.attached, true);
  });

  it('tolerates unknown parentThreadId without failing spawn_session', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/agents/sessions') {
          return {
            id: 'claude_parent',
            session: { id: 'claude_parent', threadId: 'thr_new' },
            thread: { id: 'thr_new' },
            provider: 'claude',
            backendType: 'claude',
          };
        }
        if (path === '/api/agent-bus/threads/missing/participants') {
          throw new Error('Thread not found: missing');
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    const result = await server.handleToolCall('spawn_session', {
      provider: 'claude',
      parentThreadId: 'missing',
    });

    assert.equal(result.session.id, 'claude_parent');
    assert.equal(result.parentThread.attached, false);
    assert.equal(result.parentThread.threadId, 'missing');
    assert.match(result.parentThread.error, /Thread not found/);
  });

  it('rejects removed spawn providers before calling the backend', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    await assert.rejects(
      () => server.handleToolCall('spawn_session', {
        provider: 'gsd',
        model: 'gpt-5.5',
      }),
      /Unsupported agent provider "gsd"/,
    );
    assert.deepEqual(requests, []);
  });

  it('terminates a known session and no-ops missing sessions', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/agent-bus/participants') return {
          supportedKinds: ['claude', 'codex', 'pi'],
          sessions: { claude: [{ id: 'claude_dead' }], codex: [], pi: [] },
        };
        if (path === '/api/claude/sessions/claude_dead') return {
          ok: true,
          status: 'terminated',
          kind: 'claude',
          sessionId: 'claude_dead',
          residual: [],
          reason: '',
        };
        if (path === '/api/codex/sessions') return { sessions: [] };
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    const terminated = await server.handleToolCall('monitor_terminate_session', { session_id: 'claude_dead' });
    const missing = await server.handleToolCall('monitor_terminate_session', { session_id: 'missing' });

    assert.deepEqual(requests, [
      { path: '/api/agent-bus/participants', opts: {} },
      { path: '/api/claude/sessions/claude_dead', opts: { method: 'DELETE' } },
      { path: '/api/agent-bus/participants', opts: {} },
    ]);
    assert.deepEqual(terminated, {
      ok: true,
      status: 'terminated',
      kind: 'claude',
      sessionId: 'claude_dead',
      residual: [],
      reason: '',
    });
    assert.deepEqual(missing, { ok: false, status: 'not_found', sessionId: 'missing' });
  });

  it('reports refused and failed deletes instead of mapping them to not_found', async () => {
    const server = buildMonitorMcpServer({
      async requestImpl(path) {
        if (path === '/api/agent-bus/participants') return {
          supportedKinds: ['codex'],
          sessions: { codex: [{ id: 'foreign' }, { id: 'survivor' }] },
        };
        if (path === '/api/codex/sessions/foreign') {
          const error = new Error('foreign owned');
          error.payload = { status: 'refused', reason: 'foreign_owned', residual: [] };
          throw error;
        }
        if (path === '/api/codex/sessions/survivor') {
          const error = new Error('process survived');
          error.payload = {
            status: 'failed',
            reason: 'processes_survived',
            residual: [{ type: 'process', pid: 4242 }],
          };
          throw error;
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    const refused = await server.handleToolCall('monitor_terminate_session', { session_id: 'foreign' });
    const failed = await server.handleToolCall('monitor_terminate_session', { session_id: 'survivor' });

    assert.equal(refused.status, 'refused');
    assert.equal(refused.reason, 'foreign_owned');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.reason, 'processes_survived');
    assert.deepEqual(failed.residual, [{ type: 'process', pid: 4242 }]);
  });

  it('lists unified agent providers and runs one-off tasks through the agent surface', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/agents/providers') {
          return {
            preferredProvider: 'codex',
            providers: [
              { id: 'codex', enabled: true, runtime: 'codex' },
              { id: 'claude', enabled: true, runtime: 'claude' },
            ],
          };
        }
        if (path === '/api/agents/tasks') {
          return {
            status: 'completed',
            provider: 'codex',
            backendType: 'codex',
            runtime: 'codex',
            executionMode: 'ephemeral_session_fallback',
            task: { state: 'waiting_for_input', output: 'Done.' },
          };
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    const providers = await server.handleToolCall('monitor_list_agent_providers', {});
    const task = await server.handleToolCall('monitor_run_agent_task', {
      provider: 'codex',
      prompt: 'Summarize the repo status.',
      workDir: '/tmp/project',
      timeoutMs: 10000,
      mcpProfile: 'dueno',
      mcpServers: { add: ['seodata'], remove: [] },
    });

    assert.deepEqual(providers, {
      preferredProvider: 'codex',
      providers: [
        { id: 'codex', enabled: true, runtime: 'codex' },
        { id: 'claude', enabled: true, runtime: 'claude' },
      ],
    });
    assert.deepEqual(task, {
      status: 'completed',
      provider: 'codex',
      backendType: 'codex',
      runtime: 'codex',
      executionMode: 'ephemeral_session_fallback',
      task: { state: 'waiting_for_input', output: 'Done.' },
    });
    assert.deepEqual(requests, [
      { path: '/api/agents/providers', opts: {} },
      {
        path: '/api/agents/tasks',
        opts: {
          method: 'POST',
          body: {
            provider: 'codex',
            prompt: 'Summarize the repo status.',
            workDir: '/tmp/project',
            displayName: undefined,
            model: undefined,
            thinkingLevel: undefined,
            timeoutMs: 10000,
            mcpProfile: 'dueno',
            mcpServers: { add: ['seodata'], remove: [] },
          },
        },
      },
    ]);
  });

  it('lists the sanitized MCP server catalog through the unified agent surface', async () => {
    const requests = [];
    const catalog = {
      catalogVersion: 1,
      catalogDigest: `sha256:${'a'.repeat(64)}`,
      defaultProfileId: 'default',
      profiles: [{ id: 'default', serverIds: ['dueno'] }],
      servers: [{ id: 'dueno', availability: { state: 'configured' } }],
    };
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/agents/mcp-servers') return catalog;
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    assert.deepEqual(await server.handleToolCall('monitor_list_mcp_servers', {}), catalog);
    assert.equal(server.listTools().some((tool) => tool.name === 'monitor_list_mcp_servers'), true);
    assert.equal(server.listTools().some((tool) => tool.name === 'monitor_list_prompt_profiles'), true);
    const spawnTool = server.listTools().find((tool) => tool.name === 'spawn_session');
    assert.deepEqual(spawnTool.inputSchema.properties.promptProfile.enum.slice(0, 3), ['none', 'command-center', 'fleet-supervisor']);
    assert.match(spawnTool.inputSchema.properties.promptProfile.description, /caveman/);
    assert.doesNotMatch(JSON.stringify(spawnTool.inputSchema), /Reply in caveman mode/);
  });

  it('lists public prompt profiles without bodies', async () => {
    const requests = [];
    const catalog = {
      catalogVersion: 1,
      defaultProfileId: 'none',
      profiles: [{ id: 'none', description: 'No Fleet style prompt.', hasBody: false }],
    };
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/agents/prompt-profiles') return catalog;
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    assert.deepEqual(await server.handleToolCall('monitor_list_prompt_profiles', {}), catalog);
    assert.deepEqual(requests, [{ path: '/api/agents/prompt-profiles', opts: {} }]);
  });

  it('spawns a two-participant collab session through agent-bus bootstrap', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/agents/providers') {
          return {
            providers: [
              { id: 'codex', enabled: true },
              { id: 'claude', enabled: true },
            ],
          };
        }
        if (path === '/api/agent-bus/bootstrap') {
          return {
            thread: { id: 'thr_collab', title: 'Pair task', status: 'open' },
            participants: [
              { kind: 'codex', sessionId: 'codex-1' },
              { kind: 'claude', sessionId: 'claude-1' },
            ],
          };
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    const result = await server.handleToolCall('spawn_collab_session', {
      title: 'Pair task',
      workDir: '/tmp/project',
      initialTask: 'Work together',
      codexPlugins: { add: ['browser@openai-bundled'] },
      participants: [
        { provider: 'codex', model: 'gpt-5.4', initial_task: 'Implement' },
        { provider: 'claude', model: 'claude-opus-4-8', initial_task: 'Review' },
      ],
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].path, '/api/agents/providers');
    assert.equal(requests[1].path, '/api/agent-bus/bootstrap');
    assert.deepEqual(requests[1].opts.body.participants, [
      {
        kind: 'codex',
        sessionId: '',
        create: true,
        initialTask: 'Implement',
        provider: 'codex',
        model: 'gpt-5.4',
        thinkingLevel: '',
        displayName: 'Pair task',
        workDir: '/tmp/project',
        mcpProfile: 'dueno',
        codexPlugins: { add: ['browser@openai-bundled'] },
      },
      {
        kind: 'claude',
        sessionId: '',
        create: true,
        initialTask: 'Review',
        provider: 'claude',
        model: 'claude-opus-4-8',
        thinkingLevel: '',
        displayName: 'Pair task',
        workDir: '/tmp/project',
        mcpProfile: 'dueno',
      },
    ]);
    assert.deepEqual(requests[1].opts.body.codexPlugins, { add: ['browser@openai-bundled'] });
    assert.equal(requests[1].opts.body.structured, true);
    assert.equal(result.threadType, 'collab');
  });

  it('rejects collab spawn when bootstrap reports failed participants', async () => {
    const server = buildMonitorMcpServer({
      async requestImpl(path) {
        if (path === '/api/agents/providers') {
          return {
            providers: [
              { id: 'codex', enabled: true },
              { id: 'claude', enabled: true },
            ],
          };
        }
        if (path === '/api/agent-bus/bootstrap') {
          return {
            thread: { id: 'thr_partial', title: 'Partial', status: 'open' },
            participants: [{ kind: 'claude', sessionId: 'claude-new' }],
            bootstrapOk: false,
            failedParticipants: [{
              participant: { kind: 'claude', sessionId: 'claude-new' },
              phase: 'startup_injection',
              attempts: 4,
              error: 'Agent prompt was not ready',
            }],
          };
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    await assert.rejects(
      () => server.handleToolCall('spawn_collab_session', {
        title: 'Partial',
        participants: [
          { provider: 'codex' },
          { provider: 'claude' },
        ],
      }),
      /Bootstrap incomplete: claude:claude-new startup_injection: Agent prompt was not ready/,
    );
  });

  it('rejects collab spawn when a participant provider is disabled', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/agents/providers') {
          return {
            providers: [
              { id: 'codex', enabled: true },
              { id: 'claude', enabled: false },
            ],
          };
        }
        if (path === '/api/agent-bus/bootstrap') return { thread: { id: 'should_not_happen' } };
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    await assert.rejects(
      () => server.handleToolCall('spawn_collab_session', {
        title: 'Pair task',
        workDir: '/tmp/project',
        initialTask: 'Work together',
        participants: [
          { provider: 'codex', model: 'gpt-5.4', initial_task: 'Implement' },
          { provider: 'claude', model: 'claude-opus-4-8', initial_task: 'Review' },
        ],
      }),
      (error) => {
        assert.match(error.message, /Provider "claude" is disabled/);
        return true;
      },
    );

    assert.deepEqual(requests.map((entry) => entry.path), ['/api/agents/providers']);
  });

  it('spawns a conference session with multiple participants', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/agents/providers') {
          return {
            providers: [
              { id: 'codex', enabled: true },
              { id: 'claude', enabled: true },
            ],
          };
        }
        if (path === '/api/agent-bus/bootstrap') {
          return {
            thread: { id: 'thr_conf', title: 'Conference', status: 'open' },
            participants: [
              { kind: 'codex', sessionId: 'codex-1' },
              { kind: 'claude', sessionId: 'claude-1' },
              { kind: 'codex', sessionId: 'codex-2' },
            ],
          };
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    });

    const result = await server.handleToolCall('spawn_conference_session', {
      title: 'Conference',
      model: 'gpt-5.4',
      thinkingLevel: 'medium',
      codexPlugins: { add: ['browser@openai-bundled'] },
      participants: [
        { provider: 'codex', initial_task: 'Lead' },
        { provider: 'claude', model: 'claude-opus-4-8', initial_task: 'Challenge assumptions' },
        { provider: 'codex', initial_task: 'Take notes' },
      ],
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].path, '/api/agents/providers');
    assert.equal(requests[1].path, '/api/agent-bus/bootstrap');
    assert.equal(Object.hasOwn(requests[1].opts.body, 'model'), false);
    assert.equal(requests[1].opts.body.participants.length, 3);
    assert.equal(requests[1].opts.body.participants[0].kind, 'codex');
    assert.equal(requests[1].opts.body.participants[1].kind, 'claude');
    assert.equal(requests[1].opts.body.participants[2].kind, 'codex');
    assert.equal(requests[1].opts.body.participants[0].model, 'gpt-5.4');
    assert.equal(requests[1].opts.body.participants[1].model, 'claude-opus-4-8');
    assert.equal(requests[1].opts.body.participants[2].model, 'gpt-5.4');
    assert.equal(requests[1].opts.body.participants[1].provider, 'claude');
    assert.equal(requests[1].opts.body.participants[2].provider, 'codex');
    assert.deepEqual(requests[1].opts.body.participants[0].codexPlugins, { add: ['browser@openai-bundled'] });
    assert.equal(Object.hasOwn(requests[1].opts.body.participants[1], 'codexPlugins'), false);
    assert.deepEqual(requests[1].opts.body.participants[2].codexPlugins, { add: ['browser@openai-bundled'] });
    assert.equal(requests[1].opts.body.structured, true);
    assert.equal(result.threadType, 'conference');
  });

  it('deletes legacy loop and raw bootstrap tools', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({ async requestImpl(path, opts = {}) {
      requests.push({ path, opts }); throw new Error(`Unexpected path: ${path}`);
    } });
    for (const name of ['spawn_manager_loop_session', 'monitor_bootstrap_thread']) {
      assert.equal(server.listTools().some((tool) => tool.name === name), false);
      await assert.rejects(() => server.handleToolCall(name, {}), /Unknown tool/);
    }
    assert.deepEqual(requests, []);
  });

});
