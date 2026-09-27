import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { businessOsHealthFixture } from './helpers/fleet-fixtures.mjs';

const TEST_TOKEN = 'fleet-route-token';
const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

function registry() {
  return {
    schemaVersion: 1,
    deployments: [
      {
        deploymentId: 'example-client',
        profile: 'businessos-client',
        environment: 'production',
        baseUrl: 'https://ops.example.com',
        token: 'secret-token-never-route',
        authRef: 'EXAMPLE_CLIENT_FLEET_AUTH_REF',
        publicBaseUrlRef: 'EXAMPLE_CLIENT_PUBLIC_BASE_URL_REF',
        authMode: 'bearer_ref',
        healthContract: 'businessos_diagnostics',
        enabledModules: ['work_queue', 'instance_diagnostics'],
        pollingIntervalSeconds: 15,
        debugFetchOnDegraded: true,
      },
    ],
  };
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
  };
}

function routeFetch(routes) {
  return async (url) => {
    const handler = routes[url];
    if (!handler) return jsonResponse(404, { code: 'route_not_found' });
    return jsonResponse(handler.status || 200, handler.body);
  };
}

function memoryStateStore(initial = null) {
  let state = initial;
  return {
    loadSync() {
      return state;
    },
    async load() {
      return state;
    },
    async save(next) {
      state = JSON.parse(JSON.stringify(next));
    },
    async close() {},
  };
}

async function eventually(fn, { attempts = 20 } = {}) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

async function buildApp({
  livePollingEnabled = false,
  fetchImpl = async () => jsonResponse(404, {}),
  wsManager = null,
  sessionLauncher = null,
  createWorktree = null,
  deploymentNotifier = null,
  configOverrides = {},
} = {}) {
  process.env.AUTH_TOKEN = TEST_TOKEN;
  process.env.INTERNAL_BYPASS_TOKEN = TEST_TOKEN;
  const { authPlugin } = await import('../modules/platform/auth.mjs');
  const { fleetPlugin } = await import('../modules/fleet/index.mjs');
  const { buildFleetIncidentStore } = await import('../modules/fleet/incidents.mjs');
  const app = Fastify({ logger: false });
  await app.register(authPlugin);
  await app.register(fleetPlugin, {
    registry: registry(),
    fetchImpl,
    wsManager,
    incidentStore: buildFleetIncidentStore({
      stateStore: memoryStateStore(),
      healthyPollsToResolve: 2,
    }),
    ...(sessionLauncher ? { sessionLauncher } : {}),
    ...(createWorktree ? { createWorktree } : {}),
    ...(deploymentNotifier ? { deploymentNotifier } : {}),
    config: {
      livePollingEnabled,
      healthyPollsToResolve: 2,
      investigationWorkDir: '/tmp/dueno-fleet-test-investigations',
      investigationProvider: 'codex',
      ...configOverrides,
    },
  });
  await app.ready();
  return app;
}

function authHeaders() {
  return { authorization: `Bearer ${TEST_TOKEN}` };
}

function degradedFetch() {
  return routeFetch({
    'https://ops.example.com/api/diagnostics/health': {
      body: businessOsHealthFixture({
        status: 'degraded',
        outbox: { pending_jobs: 0, terminal_jobs: 2, last_terminal_error: 'raw terminal secret' },
      }),
    },
    'https://ops.example.com/api/debug': {
      body: { rows: [] },
    },
  });
}

async function openIncident(app) {
  let incident = null;
  await eventually(async () => {
    const incidentsRes = await app.inject({
      method: 'GET',
      url: '/api/fleet/incidents?status=open',
      headers: authHeaders(),
    });
    const incidents = JSON.parse(incidentsRes.body).incidents;
    assert.equal(incidents.length, 1);
    incident = incidents[0];
  });
  return incident;
}

describe('fleet routes', () => {
  it('requires existing API auth', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/fleet/deployments' });

    assert.equal(res.statusCode, 401);
    await app.close();
  });

  it('returns safe deployment payloads without token refs or raw registry secrets', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/fleet/deployments',
      headers: authHeaders(),
    });

    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.deployments.length, 1);
    assert.deepEqual(payload.deployments[0], {
      deploymentId: 'example-client',
      profile: 'businessos-client',
      environment: 'production',
      baseUrl: 'https://ops.example.com',
      healthContract: 'businessos_diagnostics',
      enabledModules: ['work_queue', 'instance_diagnostics'],
      pollingIntervalSeconds: 15,
      debugFetchOnDegraded: true,
      latestSnapshot: null,
    });
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes('secret-token-never-route'), false);
    assert.equal(serialized.includes('FLEET_AUTH_REF'), false);
    await app.close();
  });

  it('polls immediately when live polling is enabled, stores incidents, and broadcasts safe snapshots', async () => {
    const broadcasts = [];
    const app = await buildApp({
      livePollingEnabled: true,
      wsManager: {
        broadcast(channel, type, data) {
          broadcasts.push({ channel, type, data });
        },
      },
      fetchImpl: routeFetch({
        'https://ops.example.com/api/diagnostics/health': {
          body: businessOsHealthFixture({
            status: 'degraded',
            outbox: { pending_jobs: 0, terminal_jobs: 2, last_terminal_error: 'raw terminal secret' },
          }),
        },
        'https://ops.example.com/api/debug': {
          body: {
            rows: [
              {
                source: 'panic',
                severity: 'error',
                category: 'panic',
                error_code: 'panic',
                error_message: 'raw backtrace secret',
              },
            ],
          },
        },
      }),
    });

    await eventually(async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/fleet/deployments',
        headers: authHeaders(),
      });
      const deployments = JSON.parse(res.body).deployments;
      assert.deepEqual(deployments[0].latestSnapshot?.markers, ['degraded', 'dead_letter_growth']);
      assert.equal(broadcasts.length > 0, true);
    });

    const deploymentsRes = await app.inject({
      method: 'GET',
      url: '/api/fleet/deployments',
      headers: authHeaders(),
    });
    const deployments = JSON.parse(deploymentsRes.body).deployments;
    assert.deepEqual(deployments[0].latestSnapshot.markers, ['degraded', 'dead_letter_growth']);

    const incidentsRes = await app.inject({
      method: 'GET',
      url: '/api/fleet/incidents?status=open',
      headers: authHeaders(),
    });
    assert.equal(incidentsRes.statusCode, 200);
    const incidents = JSON.parse(incidentsRes.body).incidents;
    assert.equal(incidents.length, 1);
    assert.deepEqual(incidents[0].markers, ['dead_letter_growth', 'degraded']);

    const evidenceRes = await app.inject({
      method: 'GET',
      url: `/api/fleet/incidents/${incidents[0].id}/evidence`,
      headers: authHeaders(),
    });
    const evidence = JSON.parse(evidenceRes.body).evidence;
    assert.equal(evidence.debugCounts.bySource.panic, 1);
    assert.deepEqual(evidence.healthSnapshot.markers, ['dead_letter_growth', 'degraded']);

    const ackRes = await app.inject({
      method: 'POST',
      url: `/api/fleet/incidents/${incidents[0].id}/ack`,
      headers: authHeaders(),
      payload: { actor: 'dev' },
    });
    assert.equal(ackRes.statusCode, 200);
    assert.equal(JSON.parse(ackRes.body).incident.status, 'ack');

    const serialized = JSON.stringify({
      deployments,
      incidents,
      evidence,
      broadcasts,
    });
    assert.equal(serialized.includes('secret-token-never-route'), false);
    assert.equal(serialized.includes('raw backtrace secret'), false);
    assert.equal(serialized.includes('raw terminal secret'), false);
    await app.close();
  });

  it('does not block fleet snapshots on release note notification work', async () => {
    let notifierCalls = 0;
    const { fleetPlugin } = await import('../modules/fleet/index.mjs');
    const { buildFleetIncidentStore } = await import('../modules/fleet/incidents.mjs');
    const app = {
      log: { warn() {}, info() {}, error() {} },
      inject: async () => ({ statusCode: 500, body: '{}' }),
      decorate(name, value) {
        this[name] = value;
      },
      addHook() {},
      get() {},
      post() {},
      async close() {},
    };

    await fleetPlugin(app, {
      registry: registry(),
      incidentStore: buildFleetIncidentStore({
        stateStore: memoryStateStore(),
        healthyPollsToResolve: 2,
      }),
      config: {
        livePollingEnabled: false,
        deploymentNotifyEnabled: true,
        healthyPollsToResolve: 2,
      },
      deploymentNotifier: {
        observeDeploymentBuild() {
          notifierCalls += 1;
          return new Promise(() => {});
        },
        async close() {},
      },
    });

    const result = await Promise.race([
      app.fleet.handleSnapshot({
        deploymentId: 'example-client',
        buildSha: 'bbb2222',
        status: 'ok',
        markers: [],
        reachable: true,
        lastPollMs: Date.now(),
      }),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 50)),
    ]);

    assert.notEqual(result, 'blocked');
    assert.equal(result.snapshot.buildSha, 'bbb2222');
    assert.equal(notifierCalls, 1);
    await app.close();
  });

  it('launches a scoped investigation session with safe prompt fields and annotates the incident', async () => {
    const launches = [];
    const app = await buildApp({
      livePollingEnabled: true,
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: 'codex-investigate-1', sessionName: 'codex-test', backendType: 'codex' };
      },
      fetchImpl: routeFetch({
        'https://ops.example.com/api/diagnostics/health': {
          body: businessOsHealthFixture({
            status: 'degraded',
            outbox: { pending_jobs: 0, terminal_jobs: 2, last_terminal_error: 'raw terminal secret' },
            pumps: [
              { pump: 'drive_sync', last_outcome: 'error raw provider secret' },
            ],
          }),
        },
        'https://ops.example.com/api/debug': {
          body: {
            rows: [
              {
                source: 'panic',
                severity: 'error',
                category: 'panic',
                error_code: 'panic',
                error_message: 'raw backtrace secret',
              },
            ],
          },
        },
      }),
    });

    let incident = null;
    await eventually(async () => {
      const incidentsRes = await app.inject({
        method: 'GET',
        url: '/api/fleet/incidents?status=open',
        headers: authHeaders(),
      });
      const incidents = JSON.parse(incidentsRes.body).incidents;
      assert.equal(incidents.length, 1);
      incident = incidents[0];
    });

    const noAuth = await app.inject({
      method: 'POST',
      url: `/api/fleet/incidents/${incident.id}/investigate`,
    });
    assert.equal(noAuth.statusCode, 401);

    const launchRes = await app.inject({
      method: 'POST',
      url: `/api/fleet/incidents/${incident.id}/investigate`,
      headers: authHeaders(),
      payload: {
        mcpProfile: 'default',
        mcpServers: { add: ['businessos'], remove: [] },
      },
    });
    assert.equal(launchRes.statusCode, 200);
    const body = JSON.parse(launchRes.body);
    assert.equal(body.sessionId, 'codex-investigate-1');
    assert.equal(body.backendType, 'codex');
    assert.equal(body.incident.lastInvestigationSessionId, 'codex-investigate-1');
    assert.deepEqual(body.incident.investigationSessionIds, ['codex-investigate-1']);
    assert.equal(body.incident.status, 'open');

    assert.equal(launches.length, 1);
    const launch = launches[0];
    assert.equal(launch.metadata.fleet_incident_id, incident.id);
    assert.equal(launch.metadata.deployment_id, 'example-client');
    assert.equal(launch.mcpProfile, 'default');
    assert.deepEqual(launch.mcpServers, { add: ['businessos'], remove: [] });
    assert.deepEqual(launch.metadata.fleet_marker_set, [
      'connector_degraded:drive_sync',
      'dead_letter_growth',
      'degraded',
    ]);
    assert.equal(launch.prompt.includes('dead_letter_growth'), true);
    assert.equal(launch.prompt.includes('connector_degraded:drive_sync'), true);
    assert.equal(launch.prompt.includes('bySource'), true);
    assert.equal(launch.prompt.includes('panic: 1'), true);
    assert.equal(launch.prompt.includes('raw backtrace secret'), false);
    assert.equal(launch.prompt.includes('raw terminal secret'), false);
    assert.equal(launch.prompt.includes('raw provider secret'), false);
    assert.equal(launch.prompt.includes('BusinessOS, provider, or system mutation requires explicit human approval'), true);

    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('secret-token-never-route'), false);
    assert.equal(serialized.includes('raw backtrace secret'), false);
    await app.close();
  });

  it('uses a configured repo worktree as the investigation workDir and names related repos', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'dueno-fleet-investigate-'));
    tempDirs.push(baseDir);
    const launches = [];
    const worktrees = [];
    const app = await buildApp({
      livePollingEnabled: true,
      fetchImpl: degradedFetch(),
      configOverrides: {
        investigationWorkDir: baseDir,
        repoPaths: {
          'example-client': {
            primary: '/repo/businessos',
            companions: ['/repo/example-clients'],
          },
        },
      },
      createWorktree: async (input) => {
        worktrees.push(input);
        return {
          repoPath: '/repo/businessos',
          worktreePath: `${baseDir}/worktrees/${input.incidentId}/BusinessOS`,
          branch: `dueno-fleet/${input.incidentId}`,
          sourceBranch: 'main',
          sourceHead: 'abc123',
          repoName: 'BusinessOS',
        };
      },
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: 'codex-worktree-1', sessionName: 'codex-test', backendType: 'codex' };
      },
    });

    const incident = await openIncident(app);
    const launchRes = await app.inject({
      method: 'POST',
      url: `/api/fleet/incidents/${incident.id}/investigate`,
      headers: authHeaders(),
    });

    assert.equal(launchRes.statusCode, 200);
    assert.equal(worktrees.length, 1);
    assert.equal(worktrees[0].repoPath, '/repo/businessos');
    assert.equal(worktrees[0].baseDir, baseDir);
    assert.equal(launches[0].workDir, `${baseDir}/worktrees/${incident.id}/BusinessOS`);
    assert.equal(launches[0].metadata.fleet_repo_worktree_path, `${baseDir}/worktrees/${incident.id}/BusinessOS`);
    assert.equal(launches[0].metadata.fleet_repo_worktree_branch, `dueno-fleet/${incident.id}`);
    assert.deepEqual(launches[0].metadata.fleet_repo_companions, ['/repo/example-clients']);
    assert.equal(launches[0].metadata.fleet_repo_fallback_reason, null);
    assert.match(launches[0].prompt, new RegExp(`repoWorktree: ${baseDir}/worktrees/${incident.id}/BusinessOS`));
    assert.match(launches[0].prompt, /sourceRepo: \/repo\/businessos/);
    assert.match(launches[0].prompt, /sourceBranch: main/);
    assert.match(launches[0].prompt, /sourceHead: abc123/);
    assert.match(launches[0].prompt, /relatedReposReadOnly: \/repo\/example-clients/);
    assert.match(launches[0].prompt, new RegExp(`/api/fleet/incidents/${incident.id}/evidence`));
    assert.match(launches[0].prompt, /Do not auto-commit, push, open PRs, or deploy/);
    await app.close();
  });

  it('falls back to scratch investigation workDir when no repo is configured', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'dueno-fleet-investigate-'));
    tempDirs.push(baseDir);
    const launches = [];
    const app = await buildApp({
      livePollingEnabled: true,
      fetchImpl: degradedFetch(),
      configOverrides: { investigationWorkDir: baseDir, repoPaths: {} },
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: 'codex-scratch-1', sessionName: 'codex-test', backendType: 'codex' };
      },
    });

    const incident = await openIncident(app);
    await app.inject({
      method: 'POST',
      url: `/api/fleet/incidents/${incident.id}/investigate`,
      headers: authHeaders(),
    });

    assert.equal(launches[0].workDir, join(baseDir, incident.id));
    assert.equal(launches[0].metadata.fleet_repo_worktree_path, null);
    assert.equal(launches[0].metadata.fleet_repo_fallback_reason, 'repo_not_configured');
    assert.match(launches[0].prompt, /repoWorktree: scratch\/no configured repository/);
    assert.match(launches[0].prompt, /repoFallbackReason: repo_not_configured/);
    await app.close();
  });

  it('falls back to scratch investigation workDir when worktree creation fails', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'dueno-fleet-investigate-'));
    tempDirs.push(baseDir);
    const launches = [];
    const app = await buildApp({
      livePollingEnabled: true,
      fetchImpl: degradedFetch(),
      configOverrides: {
        investigationWorkDir: baseDir,
        repoPaths: { 'example-client': { primary: '/repo/businessos', companions: ['/repo/example-clients'] } },
      },
      createWorktree: async () => {
        const error = new Error('boom');
        error.code = 'worktree_create_failed';
        throw error;
      },
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: 'codex-fallback-1', sessionName: 'codex-test', backendType: 'codex' };
      },
    });

    const incident = await openIncident(app);
    await app.inject({
      method: 'POST',
      url: `/api/fleet/incidents/${incident.id}/investigate`,
      headers: authHeaders(),
    });

    assert.equal(launches[0].workDir, join(baseDir, incident.id));
    assert.equal(launches[0].metadata.fleet_repo_source_path, '/repo/businessos');
    assert.equal(launches[0].metadata.fleet_repo_fallback_reason, 'worktree_create_failed');
    assert.deepEqual(launches[0].metadata.fleet_repo_companions, ['/repo/example-clients']);
    assert.match(launches[0].prompt, /repoFallbackReason: worktree_create_failed/);
    assert.match(launches[0].prompt, /relatedReposReadOnly: \/repo\/example-clients/);
    await app.close();
  });

  it('launches fleet investigation prompts through the Codex runtime args instead of tmux paste', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'dueno-fleet-default-launch-'));
    tempDirs.push(baseDir);
    const binDir = join(baseDir, 'bin');
    const tmuxArgsFile = join(baseDir, 'tmux-args.txt');
    const tmuxPasteFile = join(baseDir, 'tmux-paste.txt');
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n');
    await writeFile(join(binDir, 'tmux'), [
      '#!/bin/sh',
      'cmd="$1"',
      'shift',
      'case "$cmd" in',
      '  has-session)',
      '    exit 0',
      '    ;;',
      '  new-session)',
      '    printf "%s\\n" "$@" > "$TMUX_TEST_ARGS"',
      '    exit 0',
      '    ;;',
      '  load-buffer|paste-buffer|send-keys)',
      '    printf "%s\\n" "$cmd $*" >> "$TMUX_TEST_PASTE"',
      '    exit 0',
      '    ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'));
    await chmod(join(binDir, 'codex'), 0o755);
    await chmod(join(binDir, 'tmux'), 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath || '/usr/local/bin:/usr/bin:/bin'}`;
    process.env.TMUX_TEST_ARGS = tmuxArgsFile;
    process.env.TMUX_TEST_PASTE = tmuxPasteFile;
    try {
      const app = await buildApp({
        livePollingEnabled: true,
        fetchImpl: degradedFetch(),
        configOverrides: {
          investigationWorkDir: baseDir,
          repoPaths: {},
        },
      });
      const incident = await openIncident(app);
      const launchRes = await app.inject({
        method: 'POST',
        url: `/api/fleet/incidents/${incident.id}/investigate`,
        headers: authHeaders(),
      });
      assert.equal(launchRes.statusCode, 200);
      await app.close();

      const tmuxArgs = await readFile(tmuxArgsFile, 'utf8');
      assert.match(tmuxArgs, /Fleet incident investigation request\./);
      assert.match(tmuxArgs, /\/api\/fleet\/incidents\/fleetinc_/);
      await assert.rejects(readFile(tmuxPasteFile, 'utf8'), /ENOENT/);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      delete process.env.TMUX_TEST_ARGS;
      delete process.env.TMUX_TEST_PASTE;
    }
  });

  it('boots with an empty registry when the registry path is missing', async () => {
    process.env.AUTH_TOKEN = TEST_TOKEN;
    process.env.INTERNAL_BYPASS_TOKEN = TEST_TOKEN;
    const { authPlugin } = await import('../modules/platform/auth.mjs');
    const { fleetPlugin } = await import('../modules/fleet/index.mjs');
    const app = Fastify({ logger: false });
    await app.register(authPlugin);
    await app.register(fleetPlugin, {
      config: {
        registryPath: '/path/that/does/not/exist/fleet.json',
        livePollingEnabled: false,
      },
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/fleet/deployments',
      headers: authHeaders(),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { deployments: [] });
    await app.close();
  });
});
