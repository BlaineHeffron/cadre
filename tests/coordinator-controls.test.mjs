import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  AGENT_BUS_AGENT_TOOL_SCOPES,
  AgentBusCredentialStore,
} from '../modules/agent-bus/mcp-auth.mjs';
import { buildMonitorMcpServer } from '../modules/platform/monitor-mcp.mjs';
import { buildAgentBusMcpServer } from '../modules/agent-bus/mcp.mjs';
import {
  COORDINATOR_CONTROL_TOOL_SCOPES,
  COORDINATOR_POLICY_METADATA_KEY,
  coordinatorSessionMetadata,
  LOOP_REGISTRATION_METADATA_KEY,
  operatorLoopRegistrationPolicy,
  operatorResumeLoopRegistrationPolicy,
  resolveScheduledCoordinatorPolicy,
  sessionControlProvenance,
  stripReservedCoordinatorMetadata,
  storedCoordinatorPolicy,
} from '../modules/agent-bus/coordinator-policy.mjs';
import { prepareAgentBusCredentialLaunch } from '../modules/integrations/mcp-launch-preflight.mjs';
import { stepDue } from '../modules/integrations/scheduled-agents.mjs';

const temporaryPaths = [];

afterEach(async () => {
  while (temporaryPaths.length) await rm(temporaryPaths.pop(), { recursive: true, force: true });
});

function memoryCredentialStore() {
  let persisted = null;
  return new AgentBusCredentialStore({
    mode: 'enforce',
    auditPersistEvery: 1,
    auditPersistIntervalMs: 0,
    store: {
      mode: 'memory',
      async load() { return persisted; },
      async save(next) { persisted = structuredClone(next); },
      async close() {},
    },
  });
}

function ordinaryContext(scopes = AGENT_BUS_AGENT_TOOL_SCOPES) {
  return {
    authenticated: true,
    legacyUntrusted: false,
    principal: { type: 'agent', kind: 'codex', sessionId: 'ordinary' },
    toolScopes: [...scopes],
    threadAllowlist: ['@member'],
    serverAllowlist: ['dueno'],
  };
}

function rpc(server, name, args, authContext) {
  return server.handleRequest({
    jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args },
  }, { authContext });
}

function owned(policy, id, state = { execution: 'idle', interaction: { kind: 'free_text' } }) {
  return {
    id,
    ...(id === 'owned-finished' ? { sessionEnded: true } : {}),
    workDir: policy.projectRoots[0],
    state,
    controlProvenance: {
      protected: false,
      coordinatorOwner: {
        policyId: policy.policyId,
        scheduleId: policy.scheduleId,
        repository: policy.repository,
        repositories: policy.repositories,
      },
      github: null,
    },
  };
}

async function fixture({ catalogAvailable = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dueno-coordinator-controls-'));
  temporaryPaths.push(root);
  const worktree = join(root, 'worktree');
  const outside = await mkdtemp(join(tmpdir(), 'dueno-coordinator-outside-'));
  temporaryPaths.push(outside);
  await mkdir(worktree);
  const policy = resolveScheduledCoordinatorPolicy({
    [COORDINATOR_POLICY_METADATA_KEY]: {
      policyId: 'protocol-first-v1',
      repositories: ['octocat/dueno-fleet', 'octocat/BusinessOS'],
      projectRoots: [root],
      protectedSessionIds: ['protected-extra', 'e0275de9'],
    },
  }, { scheduleId: 'sched_protocol', workDir: root });
  const codexSessions = [
    owned(policy, 'owned-finished'),
    owned(policy, 'owned-blocked', { execution: 'blocked', interaction: { kind: 'permission' } }),
    {
      ...owned(policy, 'foreign-owned'),
      controlProvenance: {
        protected: false,
        coordinatorOwner: { policyId: policy.policyId, scheduleId: 'sched_foreign', repository: policy.repository },
        github: null,
      },
    },
    {
      ...owned(policy, 'owned-repository-mismatch'),
      controlProvenance: {
        protected: false,
        coordinatorOwner: {
          policyId: policy.policyId,
          scheduleId: policy.scheduleId,
          repository: policy.repository,
          repositories: [policy.repository],
        },
        github: null,
      },
    },
    { id: 'e0275de9', state: { execution: 'idle', interaction: { kind: 'free_text' } }, controlProvenance: { protected: false } },
    { id: 'forged-name', displayName: 'GitHub PR #1', state: { interaction: { kind: 'free_text' } }, controlProvenance: {} },
    owned(policy, 'ambiguous'),
  ];
  const piSessions = [
    {
      id: 'github-match', state: { interaction: { kind: 'free_text' } },
      controlProvenance: { github: { repository: policy.repository, kind: 'pr', number: 42 } },
    },
    {
      id: 'github-other', state: { interaction: { kind: 'free_text' } },
      controlProvenance: { github: { repository: 'other/repo', kind: 'issue', number: 7 } },
    },
    {
      id: 'github-secondary', state: { interaction: { kind: 'free_text' } },
      controlProvenance: { github: { repository: 'octocat/businessos', kind: 'pr', number: 365 } },
    },
    {
      id: 'ambiguous', state: { interaction: { kind: 'free_text' } },
      controlProvenance: { github: { repository: policy.repository, kind: 'pr', number: 99 } },
    },
  ];
  const threadPayload = {
  threads: [
    { id: 'owned-thread', projectKey: worktree },
    {
      id: 'owner-provenance-thread',
      projectKey: outside,
      metadata: {
        duenoCoordinatorOwner: {
          version: 1,
          policyId: policy.policyId,
          scheduleId: policy.scheduleId,
          repositories: [...policy.repositories].reverse(),
          issuedBy: 'coordinator-control',
        },
      },
    },
    {
      id: 'mismatched-owner-thread',
      projectKey: outside,
      metadata: {
        duenoCoordinatorOwner: {
          version: 1,
          policyId: policy.policyId,
          scheduleId: policy.scheduleId,
          repositories: [policy.repository],
          issuedBy: 'coordinator-control',
        },
      },
    },
    { id: 'foreign-thread', projectKey: outside },
  ],
};
  const calls = [];
  const requestImpl = async (path, options = {}) => {
    calls.push(path);
    if (path === '/api/agent-bus/participants') {
      if (!catalogAvailable) throw new Error('Participant catalog unavailable');
      return { supportedKinds: ['codex', 'pi'], sessions: { codex: codexSessions, pi: piSessions } };
    }
    if (path === '/api/claude/sessions') return { sessions: [] };
    if (options.method === 'DELETE') return { ok: true, status: 'terminated' };
    if (path.endsWith('/input')) return { accepted: true, transactionId: 'input-1' };
    if (/\/sessions\/[^/]+\?lines=/.test(path)) return { content: 'captured output' };
    if (path.startsWith('/api/codex/sessions')) return { sessions: codexSessions };
    if (path.startsWith('/api/pi/sessions')) return { sessions: piSessions };
    if (path === '/api/agents/scheduled') return { tasks: [{ id: policy.scheduleId }, { id: 'sched_foreign' }] };
    if (path === `/api/agents/scheduled/${policy.scheduleId}/cancel`) return { id: policy.scheduleId, status: 'cancelled' };
    if (path === '/api/agents/scheduled/sched_foreign/cancel') return { id: 'sched_foreign', status: 'cancelled' };
    if (path.startsWith('/api/agent-bus/threads/')) {
      const id = path.split('/').pop().split('?')[0];
      return { thread: threadPayload.threads.find((thread) => thread.id === id), messages: [] };
    }
    if (path.startsWith('/api/agent-bus/threads')) return threadPayload;
    throw new Error(`Unexpected request ${path}`);
  };
  const credentialStore = memoryCredentialStore();
  const extraNames = [
    ...COORDINATOR_CONTROL_TOOL_SCOPES,
    'monitor_answer_human_queue_item',
    'monitor_scheduled_send',
    'spawn_session',
    'spawn_collab_session',
    'spawn_conference_session',
    'register_scheduled_agent',
    'monitor_step_scheduled_agents',
  ];
  const monitor = buildMonitorMcpServer({ requestImpl });
  const server = buildAgentBusMcpServer({
    requestImpl,
    credentialStore,
    extraTools: extraNames.map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object' },
      async handler(args, context) {
        if (COORDINATOR_CONTROL_TOOL_SCOPES.includes(name)) return monitor.handleToolCall(name, args, context);
        return { ok: true, name, args };
      },
    })),
  });
  const credential = await prepareAgentBusCredentialLaunch({
    backendType: 'codex', sessionId: 'coordinator', attemptGeneration: 1, credentialStore, coordinatorPolicy: policy,
  });
  const context = await credentialStore.authenticate(credential.token);
  return { root, worktree, outside, policy, context, server, credentialStore, calls };
}

describe('scheduled coordinator control policy', () => {
  it('selects policy only from complete trusted scheduled metadata and propagates it to the due launch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-coordinator-scheduled-'));
    temporaryPaths.push(root);
    assert.equal(resolveScheduledCoordinatorPolicy({}, { scheduleId: 'sched_1', workDir: root }), null);
    assert.throws(() => resolveScheduledCoordinatorPolicy({
      [COORDINATOR_POLICY_METADATA_KEY]: { policyId: 'bad', projectRoots: [root] },
    }, { scheduleId: 'sched_1', workDir: root }), /repository/);
    assert.throws(() => resolveScheduledCoordinatorPolicy({
      [COORDINATOR_POLICY_METADATA_KEY]: {
        policyId: 'bad', repository: 'owner/repo', repositories: ['other/repo'], projectRoots: [root],
      },
    }, { scheduleId: 'sched_1', workDir: root }), /included/);

    const metadata = {
      [COORDINATOR_POLICY_METADATA_KEY]: {
        policyId: 'policy-1', repository: 'owner/repo', projectRoots: [root], protectedSessionIds: [],
      },
      unrelated: 'not-forwarded',
    };
    const task = {
      id: 'sched_1', workDir: root, prompt: 'coordinate', provider: 'codex', model: null,
      intervalSeconds: 15, maxIterations: 1, parentThreadId: null, status: 'active',
      currentIteration: 0, nextRunAtEpochMs: 1000, lastSessionId: null,
      lastSpawnAtEpochMs: 0, consecutiveSkips: 0, metadata,
    };
    let stored = structuredClone(task);
    let launch = null;
    await stepDue(1000, {
      store: {
        async list() { return [structuredClone(stored)]; },
        async claimRun() { return { task: structuredClone(stored), leaseId: 'claim', original: structuredClone(stored) }; },
        async update(_id, patch) { stored = { ...stored, ...patch }; return structuredClone(stored); },
      },
      sessionLauncher: async (input) => {
        launch = input;
        return {
          id: 'coordinator-session',
          metadata: {
            [COORDINATOR_POLICY_METADATA_KEY]: {
              policyId: 'forged', repository: 'evil/repo', projectRoots: [root],
            },
            launcherNote: 'preserved',
          },
        };
      },
      lookupSessionState: async () => null,
    });
    assert.deepEqual(launch.trustedCoordinatorMetadata, {
      [COORDINATOR_POLICY_METADATA_KEY]: metadata[COORDINATOR_POLICY_METADATA_KEY],
    });
    assert.equal(launch.taskId, 'sched_1');
    assert.equal(launch.trustedCoordinatorMetadata.unrelated, undefined);
    assert.equal(stored.metadata[COORDINATOR_POLICY_METADATA_KEY].policyId, 'policy-1');
    assert.equal(stored.metadata.launcherNote, 'preserved');
  });

  it('normalizes a bounded repository allowlist while preserving legacy single-repository policies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-coordinator-repositories-'));
    temporaryPaths.push(root);
    const legacy = resolveScheduledCoordinatorPolicy({
      [COORDINATOR_POLICY_METADATA_KEY]: {
        policyId: 'legacy', repository: 'Owner/Repo', projectRoots: [root],
      },
    }, { scheduleId: 'sched_legacy', workDir: root });
    assert.equal(legacy.repository, 'owner/repo');
    assert.deepEqual(legacy.repositories, ['owner/repo']);

    const multi = resolveScheduledCoordinatorPolicy({
      [COORDINATOR_POLICY_METADATA_KEY]: {
        policyId: 'multi', repositories: ['Owner/Repo', 'owner/repo', 'Other/Repo'], projectRoots: [root],
      },
    }, { scheduleId: 'sched_multi', workDir: root });
    assert.equal(multi.repository, 'owner/repo');
    assert.deepEqual(multi.repositories, ['owner/repo', 'other/repo']);

    const dual = resolveScheduledCoordinatorPolicy({
      [COORDINATOR_POLICY_METADATA_KEY]: {
        policyId: 'dual',
        repository: 'Other/Repo',
        repositories: ['Owner/Repo', 'Other/Repo'],
        projectRoots: [root],
      },
    }, { scheduleId: 'sched_dual', workDir: root });
    assert.equal(dual.repository, 'other/repo');
    assert.deepEqual(dual.repositories, ['owner/repo', 'other/repo']);

    assert.throws(() => resolveScheduledCoordinatorPolicy({
      [COORDINATOR_POLICY_METADATA_KEY]: {
        policyId: 'too-many',
        repositories: Array.from({ length: 9 }, (_, index) => `owner/repo-${index}`),
        projectRoots: [root],
      },
    }, { scheduleId: 'sched_too_many', workDir: root }), /one to eight/);
  });

  it('issues expanded scopes only when a valid coordinator policy is explicitly supplied', async () => {
    const { policy } = await fixture();
    const credentialStore = memoryCredentialStore();
    const ordinary = await prepareAgentBusCredentialLaunch({
      backendType: 'codex', sessionId: 'ordinary', attemptGeneration: 1, credentialStore,
    });
    const ordinaryAuth = await credentialStore.authenticate(ordinary.token);
    assert.equal(ordinaryAuth.principal.type, 'agent');
    assert.equal(ordinaryAuth.coordinatorPolicy, null);
    assert.equal(ordinaryAuth.toolScopes.includes('spawn_collab_session'), true);

    const malformed = await prepareAgentBusCredentialLaunch({
      backendType: 'codex', sessionId: 'malformed', attemptGeneration: 1, credentialStore, coordinatorPolicy: {},
    });
    const malformedAuth = await credentialStore.authenticate(malformed.token);
    assert.equal(malformedAuth.coordinatorPolicy, null);
    assert.equal(malformedAuth.toolScopes.includes('spawn_collab_session'), true);

    const coordinator = await prepareAgentBusCredentialLaunch({
      backendType: 'codex', sessionId: 'coordinator', attemptGeneration: 1, credentialStore, coordinatorPolicy: policy,
    });
    const coordinatorAuth = await credentialStore.authenticate(coordinator.token);
    assert.equal(coordinatorAuth.principal.type, 'agent');
    assert.equal(coordinatorAuth.coordinatorPolicy.scheduleId, 'sched_protocol');
    assert.deepEqual(
      COORDINATOR_CONTROL_TOOL_SCOPES.filter((scope) => !coordinatorAuth.toolScopes.includes(scope)),
      [],
    );
    const rotated = await prepareAgentBusCredentialLaunch({
      backendType: 'codex',
      sessionId: 'coordinator',
      attemptGeneration: 2,
      credentialStore,
      coordinatorPolicy: storedCoordinatorPolicy(coordinatorSessionMetadata(policy)),
      rotation: true,
    });
    assert.equal((await credentialStore.authenticate(coordinator.token)).reason, 'revoked');
    const rotatedAuth = await credentialStore.authenticate(rotated.token);
    assert.deepEqual(rotatedAuth.coordinatorPolicy, coordinatorAuth.coordinatorPolicy);
    assert.deepEqual(rotatedAuth.toolScopes, coordinatorAuth.toolScopes);

    const delegated = await prepareAgentBusCredentialLaunch({
      backendType: 'codex',
      sessionId: 'operator-directed',
      attemptGeneration: 1,
      credentialStore,
      loopRegistrationPolicy: operatorLoopRegistrationPolicy({
        type: 'ui', kind: 'dashboard', sessionId: 'browser',
      }),
    });
    const delegatedAuth = await credentialStore.authenticate(delegated.token);
    assert.equal(delegatedAuth.toolScopes.includes('register_scheduled_agent'), true);
    assert.equal(delegatedAuth.toolScopes.includes('spawn_session'), true);
    assert.equal(delegatedAuth.loopRegistrationPolicy.issuedBy, 'authenticated-operator');
  });

  it('does not re-issue loop registration when an operator resumes an undelegated session', () => {
    const operator = { type: 'ui', kind: 'dashboard', sessionId: 'browser' };
    assert.equal(operatorResumeLoopRegistrationPolicy(operator, {}), null);
    assert.equal(operatorResumeLoopRegistrationPolicy(operator, {
      [LOOP_REGISTRATION_METADATA_KEY]: { version: 1, issuedBy: 'agent' },
    }), null);
    assert.equal(operatorResumeLoopRegistrationPolicy(operator, {
      [LOOP_REGISTRATION_METADATA_KEY]: operatorLoopRegistrationPolicy(operator),
    }).issuedBy, 'authenticated-operator');
  });

  it('does not derive trusted ownership from caller-controlled metadata or display names', () => {
    const forged = sessionControlProvenance({
      source: 'dashboard',
      displayName: 'GitHub PR #1',
      metadata: {
        github_repo: 'owner/repo', github_kind: 'pr', github_number: 1,
        duenoCoordinatorOwner: {
          version: 1, policyId: 'policy', scheduleId: 'sched', repository: 'owner/repo',
        },
      },
    });
    assert.equal(forged.github, null);
    assert.equal(forged.coordinatorOwner, null);

    const trusted = sessionControlProvenance({
      source: 'github-agent',
      protected: true,
      metadata: {
        github_repo: 'Owner/Repo', github_kind: 'PR', github_number: '42',
        duenoCoordinatorOwner: {
          version: 1,
          policyId: 'policy',
          scheduleId: 'sched',
          repositories: ['Owner/Repo', 'Other/Repo'],
          issuedBy: 'coordinator-control',
        },
      },
    });
    assert.equal(trusted.protected, true);
    assert.deepEqual(trusted.github, { repository: 'owner/repo', kind: 'pr', number: 42 });
    assert.deepEqual(trusted.coordinatorOwner, {
      policyId: 'policy',
      scheduleId: 'sched',
      repository: 'owner/repo',
      repositories: ['owner/repo', 'other/repo'],
    });

    const malformedOwner = sessionControlProvenance({
      metadata: {
        duenoCoordinatorOwner: {
          version: 1,
          policyId: 'policy',
          scheduleId: 'sched',
          repositories: 'owner/repo',
          issuedBy: 'coordinator-control',
        },
      },
    });
    assert.equal(malformedOwner.coordinatorOwner, null);
    assert.deepEqual(stripReservedCoordinatorMetadata({
      keep: true,
      coordinatorControlPolicy: { policyId: 'forged' },
      duenoCoordinatorControl: { policyId: 'forged' },
      duenoCoordinatorOwner: { policyId: 'forged' },
    }), { keep: true });
  });
});

describe('coordinator MCP authorization fences', () => {
  it('refuses foreign schedule cancellation with a coordinator credential while allowing owner and operator cancels', async () => {
    const { server, policy, credentialStore, calls } = await fixture();
    const credential = await prepareAgentBusCredentialLaunch({
      backendType: 'codex', sessionId: 'coordinator', attemptGeneration: 1, credentialStore, coordinatorPolicy: policy,
    });
    const context = await credentialStore.authenticate(credential.token);
    const denied = await rpc(server, 'cancel_scheduled_agent', { id: 'sched_foreign' }, context);
    assert.equal(denied.error?.data?.reason, 'coordinator_foreign_schedule_denied');
    assert.deepEqual(calls, []);
    const audit = credentialStore.auditEvents().filter((event) => event.event === 'coordinator_control');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].outcome, 'denied');
    assert.equal(audit[0].denialReason, 'coordinator_foreign_schedule_denied');

    const owner = await rpc(server, 'cancel_scheduled_agent', { id: policy.scheduleId }, context);
    assert.equal(owner.error, undefined);
    assert.deepEqual(owner.result.structuredContent, { id: policy.scheduleId, status: 'cancelled' });
    const operator = await rpc(server, 'cancel_scheduled_agent', { id: 'sched_foreign' }, {
      ...ordinaryContext(['*']), principal: { type: 'ui', kind: 'dashboard', sessionId: 'operator' },
    });
    assert.equal(operator.error, undefined);
    assert.deepEqual(operator.result.structuredContent, { id: 'sched_foreign', status: 'cancelled' });
    assert.deepEqual(calls, [
      `/api/agents/scheduled/${policy.scheduleId}/cancel`,
      '/api/agents/scheduled/sched_foreign/cancel',
    ]);
  });

  it('keeps coordinator tools undiscoverable and unusable by ordinary or legacy agents', async () => {
    const { server } = await fixture();
    const listed = await server.handleRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { authContext: ordinaryContext() },
    );
    assert.deepEqual(
      listed.result.tools.filter((tool) => COORDINATOR_CONTROL_TOOL_SCOPES.includes(tool.name)),
      [],
    );
    for (const tool of COORDINATOR_CONTROL_TOOL_SCOPES) {
      const result = await rpc(server, tool, {}, ordinaryContext([tool]));
      assert.equal(result.error?.data?.reason === 'principal_type_denied', false, tool);
    }
    const legacy = {
      authenticated: false, legacyUntrusted: true,
      principal: { type: 'legacy', kind: 'legacy', sessionId: 'untrusted' },
      toolScopes: ['*'], threadAllowlist: ['*'], serverAllowlist: ['*'],
    };
    const legacyList = await server.handleRequest(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { authContext: legacy },
    );
    assert.deepEqual(
      legacyList.result.tools.filter((tool) => COORDINATOR_CONTROL_TOOL_SCOPES.includes(tool.name)),
      [],
    );
  });

  it('allows the exact coordinator workflow and audits successful privileged actions', async () => {
    const { server, context, policy, credentialStore } = await fixture();
    const calls = [
      ['list_scheduled_agents', {}],
      ['monitor_list_codex_sessions', {}],
      ['monitor_list_pi_sessions', {}],
      ['monitor_list_threads', {}],
      ['monitor_get_session_output', { type: 'codex', sessionId: 'owned-finished' }],
      ['monitor_get_session_output', { type: 'pi', sessionId: 'github-match' }],
      ['monitor_get_session_output', { type: 'codex', sessionId: 'ambiguous' }],
      ['monitor_get_session_output', { type: 'pi', sessionId: 'github-secondary' }],
      ['monitor_get_session_output', { type: 'xai', sessionId: 'github-secondary' }],
      ['monitor_send_to_session', { type: 'pi', sessionId: 'github-match', text: 'Review current SHA' }],
      ['monitor_terminate_session', { session_id: 'owned-finished' }],
      ['cancel_scheduled_agent', { id: policy.scheduleId }],
    ];
    for (const [tool, args] of calls) {
      const result = await rpc(server, tool, args, context);
      assert.equal(result.error, undefined, `${tool}: ${result.error?.message || ''}`);
      if (tool === 'monitor_terminate_session') assert.equal(result.result.structuredContent.status, 'terminated');
    }
    const audit = credentialStore.auditEvents().filter((event) => (
      event.event === 'coordinator_control' && event.outcome === 'succeeded'
    ));
    assert.equal(audit.length, calls.length);
    assert.equal(audit.every((event) => (
      event.policyId === policy.policyId
      && event.scheduleId === policy.scheduleId
      && event.outcome === 'succeeded'
      && event.denialReason === null
    )), true);
    const listedCodex = await rpc(server, 'monitor_list_codex_sessions', {}, context);
    const listedPi = await rpc(server, 'monitor_list_pi_sessions', {}, context);
    const listedSchedules = await rpc(server, 'list_scheduled_agents', {}, context);
    const listedThreads = await rpc(server, 'monitor_list_threads', {}, context);
    assert.deepEqual(
      listedCodex.result.structuredContent.sessions.map((session) => session.id).sort(),
      ['ambiguous', 'owned-blocked', 'owned-finished'],
    );
    assert.deepEqual(
      listedPi.result.structuredContent.sessions.map((session) => session.id).sort(),
      ['ambiguous', 'github-match', 'github-secondary'],
    );
    assert.deepEqual(listedSchedules.result.structuredContent.tasks.map((task) => task.id), [policy.scheduleId]);
    assert.deepEqual(
      listedThreads.result.structuredContent.threads.map((thread) => thread.id),
      ['owned-thread', 'owner-provenance-thread'],
    );
    const spawned = await rpc(server, 'spawn_collab_session', {
      title: 'next lane',
      mcpProfile: 'businessos',
      participants: [{ provider: 'codex' }, { provider: 'xai', sessionId: 'foreign-owned' }],
    }, context);
    assert.equal(spawned.error, undefined, spawned.error?.message);
  });

  it('resolves termination through session lists when the participant catalog is unavailable', async () => {
    const { server, context, calls } = await fixture({ catalogAvailable: false });
    const allowed = await rpc(server, 'monitor_terminate_session', { session_id: 'owned-finished' }, context);
    assert.equal(allowed.error, undefined);
    assert.equal(allowed.result.structuredContent.status, 'terminated');
    assert.equal(calls.includes('/api/codex/sessions/owned-finished'), true);
    const ambiguous = await rpc(server, 'monitor_terminate_session', { session_id: 'ambiguous' }, context);
    assert.equal(ambiguous.error?.data?.reason, 'coordinator_target_identity_ambiguous');
    assert.equal(calls.some((path) => path.endsWith('/sessions/ambiguous')), false);
  });

  for (const type of ['agent', 'ui']) {
    it(`preserves session actions and thread messages for an issued non-coordinator ${type} credential`, async () => {
      const { server, credentialStore, calls } = await fixture();
      const issued = await credentialStore.issue({
        principal: { type, kind: type === 'agent' ? 'codex' : 'dashboard', sessionId: 'ordinary' },
        attemptGeneration: 1,
        toolScopes: COORDINATOR_CONTROL_TOOL_SCOPES,
      });
      const context = await credentialStore.authenticate(issued.token);
      assert.equal(context.coordinatorPolicy, null);
      const output = await rpc(server, 'monitor_get_session_output', { type: 'pi', sessionId: 'github-other' }, context);
      assert.equal(output.error, undefined);
      assert.equal(output.result.structuredContent.content, 'captured output');
      const send = await rpc(server, 'monitor_send_to_session', { type: 'codex', sessionId: 'owned-blocked', text: 'yes' }, context);
      assert.equal(send.error, undefined);
      assert.equal(send.result.structuredContent.status, 'queued');
      const terminate = await rpc(server, 'monitor_terminate_session', { session_id: 'foreign-owned' }, context);
      assert.equal(terminate.error, undefined);
      assert.equal(terminate.result.structuredContent.status, 'terminated');
      const threads = await rpc(server, 'monitor_list_threads', { include_messages: true }, context);
      assert.equal(threads.error, undefined);
      assert.equal(threads.result.structuredContent.threads.length, 4);
      assert.equal(calls.filter((path) => path.endsWith('/sessions')).length, 0);
      assert.equal(calls.some((path) => path.includes('messageLimit=10')), true);
    });
  }

  const deniedCases = [
    ['cancel_scheduled_agent', { id: 'sched_foreign' }, 'coordinator_foreign_schedule_denied'],
    ['monitor_get_session_output', { type: 'pi', sessionId: 'github-other' }, 'coordinator_session_not_owned'],
    ['monitor_send_to_session', { type: 'codex', sessionId: 'owned-blocked', text: 'yes' }, 'coordinator_interaction_authority_denied'],
    ['monitor_send_to_session', { type: 'codex', sessionId: 'e0275de9', text: 'stop' }, 'coordinator_protected_session_denied'],
    ['monitor_terminate_session', { session_id: 'owned-blocked' }, 'coordinator_session_not_finished_owned'],
    ['monitor_terminate_session', { session_id: 'github-match' }, 'coordinator_session_not_finished_owned'],
    ['monitor_terminate_session', { session_id: 'foreign-owned' }, 'coordinator_session_not_owned'],
    ['monitor_get_session_output', { type: 'codex', sessionId: 'owned-repository-mismatch' }, 'coordinator_session_not_owned'],
    ['monitor_get_session_output', { type: 'codex', sessionId: 'forged-name' }, 'coordinator_session_not_owned'],
    ['monitor_get_session_output', { type: 'codex', sessionId: 'missing' }, 'coordinator_target_identity_missing'],
    ['monitor_terminate_session', { session_id: 'ambiguous' }, 'coordinator_target_identity_ambiguous'],
    ['monitor_list_threads', { include_messages: true }, 'coordinator_thread_messages_denied'],
  ];
  for (const [tool, args, reason] of deniedCases) {
    it(`denies ${tool} ${JSON.stringify(args)} with ${reason}`, async () => {
      const { server, context, credentialStore, calls } = await fixture();
      const result = await rpc(server, tool, args, context);
      assert.equal(result.error?.data?.reason, reason);
      assert.equal(calls.some((path) => path.endsWith('/input') || /\/sessions\/[^/]+(?:\?lines=|$)/.test(path)), false);
      const audit = credentialStore.auditEvents().filter((event) => event.event === 'coordinator_control');
      assert.equal(audit.length, 1);
      assert.equal(audit[0].outcome, 'denied');
      assert.equal(audit[0].denialReason, reason);
    });
  }
});
