import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFleetDeploymentNotifier,
  buildReleaseNotePrompt,
  sanitizeReleaseNoteDraft,
} from '../modules/fleet/deployment-notifier.mjs';

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
    current() {
      return state;
    },
  };
}

function deployment(overrides = {}) {
  return {
    deploymentId: 'example-client',
    baseUrl: 'https://ops.example.com',
    token: 'secret-token',
    ...overrides,
  };
}

function snapshot(buildSha) {
  return {
    deploymentId: 'example-client',
    buildSha,
  };
}

function jsonResponse(status, body = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
  };
}

describe('fleet deployment notifier', () => {
  it('skips notification with an explicit reason when the source repository is missing', async () => {
    const notifier = buildFleetDeploymentNotifier({
      enabled: true,
      stateStore: memoryStateStore({ deployments: { 'example-client': { lastBuildSha: 'aaa1111' } } }),
      agentTaskRunner: async () => { throw new Error('agent must not run'); },
      fetchImpl: async () => { throw new Error('network must not run'); },
    });
    const result = await notifier.observeDeploymentBuild({ deployment: deployment(), snapshot: snapshot('bbb2222') });
    assert.deepEqual(result, { action: 'skipped', reason: 'DM_FLEET_DEPLOYMENT_NOTIFY_BUSINESSOS_REPO_PATH_missing' });
  });
  it('records first observation without running an agent or posting', async () => {
    const store = memoryStateStore();
    let agentCalls = 0;
    let fetchCalls = 0;
    const notifier = buildFleetDeploymentNotifier({
      enabled: true,
      stateStore: store,
      agentTaskRunner: async () => {
        agentCalls += 1;
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse(202);
      },
    });

    const result = await notifier.observeDeploymentBuild({
      deployment: deployment(),
      snapshot: snapshot('aaa1111'),
    });

    assert.equal(result.action, 'recorded_first_observation');
    assert.equal(agentCalls, 0);
    assert.equal(fetchCalls, 0);
    assert.equal(store.current().deployments['example-client'].lastBuildSha, 'aaa1111');
  });

  it('records transitions but skips notification while the default-off flag is false', async () => {
    const store = memoryStateStore({
      deployments: {
        'example-client': { lastBuildSha: 'aaa1111' },
      },
    });
    const notifier = buildFleetDeploymentNotifier({
      enabled: false,
      stateStore: store,
      agentTaskRunner: async () => {
        throw new Error('agent must not run');
      },
      fetchImpl: async () => {
        throw new Error('network must not run');
      },
    });

    const result = await notifier.observeDeploymentBuild({
      deployment: deployment(),
      snapshot: snapshot('bbb2222'),
    });

    assert.equal(result.action, 'recorded_transition_notify_disabled');
    assert.equal(result.previousBuildSha, 'aaa1111');
    assert.equal(result.buildSha, 'bbb2222');
    assert.equal(store.current().deployments['example-client'].lastBuildSha, 'bbb2222');
  });

  it('runs structured agent output, scrubs jargon, and posts with build sha idempotency', async () => {
    const store = memoryStateStore({
      deployments: {
        'example-client': { lastBuildSha: 'aaa1111' },
      },
    });
    const agentBodies = [];
    const fetchCalls = [];
    const notifier = buildFleetDeploymentNotifier({
      enabled: true,
      stateStore: store,
      repoPath: '/repo/BusinessOS',
      provider: 'openai',
      model: 'gpt-test',
      thinkingLevel: 'low',
      webhookPath: '/api/webhooks/release-notes',
      execImpl: async (cmd, args) => {
        assert.equal(cmd, 'git');
        assert.deepEqual(args.slice(0, 5), ['-C', '/repo/BusinessOS', 'log', 'aaa1111..bbb2222', '--no-merges']);
        return { code: 0, stdout: 'Home dashboard polish\n---END-COMMIT---\n', stderr: '' };
      },
      agentTaskRunner: async (body) => {
        agentBodies.push(body);
        return {
          task: {
            output: JSON.stringify({
              title: 'What\'s new abcdef1',
              summary: 'The home dashboard is easier to scan after BOS_INTERNAL_FLAG shipped.',
              body: '- Better daily work grouping\n- DM_FLEET_DEBUG_TOGGLE removed from view',
            }),
          },
        };
      },
      fetchImpl: async (url, options = {}) => {
        fetchCalls.push({ url, options });
        return jsonResponse(202, { accepted: true });
      },
    });

    const result = await notifier.observeDeploymentBuild({
      deployment: deployment(),
      snapshot: snapshot('bbb2222'),
    });

    assert.equal(result.action, 'posted');
    assert.equal(agentBodies.length, 1);
    assert.equal(agentBodies[0].provider, 'openai');
    assert.equal(agentBodies[0].model, 'gpt-test');
    assert.equal(agentBodies[0].thinkingLevel, 'low');
    assert.equal(agentBodies[0].workDir, '/repo/BusinessOS');
    assert.match(agentBodies[0].prompt, /git -C/);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'https://ops.example.com/api/webhooks/release-notes');
    assert.equal(fetchCalls[0].options.headers.authorization, 'Bearer secret-token');
    const posted = JSON.parse(fetchCalls[0].options.body);
    assert.equal(posted.release_note_id, 'bbb2222');
    assert.equal(posted.idempotency_key, 'bbb2222');
    assert.equal(posted.build_sha, 'bbb2222');
    assert.equal(posted.title, 'What\'s new');
    assert.equal(posted.summary.includes('BOS_'), false);
    assert.equal(posted.summary.includes('abcdef1'), false);
    assert.equal(posted.body.includes('DM_'), false);
    assert.equal(store.current().deployments['example-client'].lastNotifiedBuildSha, 'bbb2222');
  });

  it('does not retry a failed post for the same build', async () => {
    const store = memoryStateStore({
      deployments: {
        'example-client': {
          lastBuildSha: 'aaa1111',
          lastNotificationCheckpointBuildSha: 'aaa1111',
        },
      },
    });
    let agentCalls = 0;
    let fetchCalls = 0;
    let clock = 1_000_000;
    const notifier = buildFleetDeploymentNotifier({
      enabled: true,
      stateStore: store,
      repoPath: '/repo/BusinessOS',
      now: () => clock,
      execImpl: async () => ({ code: 0, stdout: 'Better deployment notes\n---END-COMMIT---\n', stderr: '' }),
      agentTaskRunner: async () => {
        agentCalls += 1;
        return {
          task: {
            output: JSON.stringify({
              title: 'What\'s new',
              summary: 'Operators can now see clearer deployment updates after releases.',
              body: '',
            }),
          },
        };
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse(fetchCalls === 1 ? 500 : 202);
      },
      log: { warn() {} },
    });

    const failed = await notifier.observeDeploymentBuild({
      deployment: deployment(),
      snapshot: snapshot('bbb2222'),
    });
    assert.equal(failed.action, 'notify_failed');
    assert.equal(agentCalls, 1);
    assert.equal(store.current().deployments['example-client'].lastBuildSha, 'bbb2222');
    assert.equal(store.current().deployments['example-client'].lastObservedBuildSha, 'bbb2222');
    assert.equal(store.current().deployments['example-client'].lastNotificationCheckpointBuildSha, 'bbb2222');
    assert.equal(store.current().deployments['example-client'].lastFailedNotify.reason, 'http_500');
    assert.equal(store.current().deployments['example-client'].failedNotify, undefined);

    const second = await notifier.observeDeploymentBuild({
      deployment: deployment(),
      snapshot: snapshot('bbb2222'),
    });
    assert.equal(second.action, 'unchanged');
    assert.equal(agentCalls, 1);
    assert.equal(fetchCalls, 1);
  });

  it('reads the note from the file the agent writes, ignoring unusable terminal output', async () => {
    const noteDir = await mkdtemp(join(tmpdir(), 'dueno-note-test-'));
    try {
      const store = memoryStateStore({
        deployments: { 'example-client': { lastBuildSha: 'aaa1111' } },
      });
      const expectedPath = join(noteDir, 'example-client-bbb2222.json');
      const fetchCalls = [];
      const notifier = buildFleetDeploymentNotifier({
        enabled: true,
        stateStore: store,
        repoPath: '/repo/BusinessOS',
        noteDir,
        execImpl: async () => ({ code: 0, stdout: 'note\n---END-COMMIT---\n', stderr: '' }),
        agentTaskRunner: async (body) => {
          // The agent is told the exact path; it writes the file and prints only TUI noise.
          assert.ok(body.prompt.includes(expectedPath));
          await writeFile(
            expectedPath,
            JSON.stringify({
              title: 'What\'s new',
              summary: 'The dashboard groups your day more clearly now for operators.',
              body: '',
            }),
          );
          return { task: { output: '[2J tui repaint, no usable json here' } };
        },
        fetchImpl: async (url, options = {}) => {
          fetchCalls.push({ url, options });
          return jsonResponse(202);
        },
      });

      const result = await notifier.observeDeploymentBuild({
        deployment: deployment(),
        snapshot: snapshot('bbb2222'),
      });
      assert.equal(result.action, 'posted');
      assert.equal(fetchCalls.length, 1);
      const posted = JSON.parse(fetchCalls[0].options.body);
      assert.equal(posted.title, 'What\'s new');
      assert.match(posted.summary, /dashboard groups your day/);
    } finally {
      await rm(noteDir, { recursive: true, force: true });
    }
  });

  it('uses a configurable webhook path while the BusinessOS endpoint rolls out', async () => {
    const calls = [];
    const notifier = buildFleetDeploymentNotifier({
      enabled: true,
      stateStore: memoryStateStore({
        deployments: {
          'example-client': { lastBuildSha: 'aaa1111' },
        },
      }),
      webhookPath: 'internal/release-notes',
      repoPath: '/repo/BusinessOS',
      execImpl: async () => ({ code: 0, stdout: 'Dashboard note\n---END-COMMIT---\n', stderr: '' }),
      agentTaskRunner: async () => ({
        task: {
          output: JSON.stringify({
            title: 'What\'s new',
            summary: 'The dashboard now explains release changes more clearly.',
            body: '',
          }),
        },
      }),
      fetchImpl: async (url) => {
        calls.push(url);
        return jsonResponse(202);
      },
    });

    const result = await notifier.observeDeploymentBuild({
      deployment: deployment(),
      snapshot: snapshot('bbb2222'),
    });

    assert.equal(result.action, 'posted');
    assert.deepEqual(calls, ['https://ops.example.com/internal/release-notes']);
  });

  it('treats an explicit empty note as no operator-facing change', async () => {
    const noteDir = await mkdtemp(join(tmpdir(), 'dueno-note-empty-'));
    try {
      const store = memoryStateStore({
        deployments: { 'example-client': { lastBuildSha: 'aaa1111' } },
      });
      let agentCalls = 0;
      const notifier = buildFleetDeploymentNotifier({
        enabled: true,
        stateStore: store,
        noteDir,
        repoPath: '/repo/BusinessOS',
        execImpl: async () => ({ code: 0, stdout: 'internal only\n---END-COMMIT---\n', stderr: '' }),
        agentTaskRunner: async (body) => {
          agentCalls += 1;
          const match = String(body.prompt).match(/file path using your file-writing tool: (.+)$/m);
          await writeFile(match[1], JSON.stringify({ title: "What's new", summary: '', body: '' }));
          return { task: { output: '' } };
        },
        fetchImpl: async () => {
          throw new Error('network must not run');
        },
      });

      const result = await notifier.observeDeploymentBuild({
        deployment: deployment(),
        snapshot: snapshot('bbb2222'),
      });

      assert.equal(result.action, 'skipped');
      assert.equal(result.reason, 'no_operator_facing_change');
      assert.equal(agentCalls, 1);
      assert.equal(store.current().deployments['example-client'].lastBuildSha, 'bbb2222');
      assert.equal(store.current().deployments['example-client'].lastNotificationCheckpointBuildSha, 'bbb2222');
      assert.equal(store.current().deployments['example-client'].failedNotify, undefined);
    } finally {
      await rm(noteDir, { recursive: true, force: true });
    }
  });

  it('does not start another agent after a failed note run', async () => {
    const store = memoryStateStore({
      deployments: {
        'example-client': {
          lastBuildSha: 'aaa1111',
          lastNotificationCheckpointBuildSha: 'aaa1111',
        },
      },
    });
    let agentCalls = 0;
    const notifier = buildFleetDeploymentNotifier({
      enabled: true,
      stateStore: store,
      repoPath: '/repo/BusinessOS',
      execImpl: async () => ({ code: 0, stdout: 'note\n---END-COMMIT---\n', stderr: '' }),
      agentTaskRunner: async () => {
        agentCalls += 1;
        return { task: { output: '' } };
      },
      fetchImpl: async () => {
        throw new Error('network must not run');
      },
      log: { warn() {} },
    });

    const failed = await notifier.observeDeploymentBuild({
      deployment: deployment(),
      snapshot: snapshot('bbb2222'),
    });
    assert.equal(failed.action, 'notify_failed');
    assert.equal(failed.reason, 'empty_or_invalid_agent_note');
    assert.equal(agentCalls, 1);
    assert.equal(store.current().deployments['example-client'].lastBuildSha, 'bbb2222');
    assert.equal(store.current().deployments['example-client'].lastFailedNotify.reason, 'empty_or_invalid_agent_note');

    const second = await notifier.observeDeploymentBuild({
      deployment: deployment(),
      snapshot: snapshot('bbb2222'),
    });
    assert.equal(second.action, 'unchanged');
    assert.equal(agentCalls, 1);
  });

  it('skips missing or empty commit ranges before running agent or network', async () => {
    const store = memoryStateStore({
      deployments: {
        'example-client': { lastBuildSha: 'aaa1111' },
      },
    });
    const notifier = buildFleetDeploymentNotifier({
      enabled: true,
      stateStore: store,
      repoPath: '/repo/BusinessOS',
      execImpl: async () => ({ code: 128, stdout: '', stderr: 'bad revision' }),
      agentTaskRunner: async () => {
        throw new Error('agent must not run');
      },
      fetchImpl: async () => {
        throw new Error('network must not run');
      },
      log: { warn() {} },
    });

    const result = await notifier.observeDeploymentBuild({
      deployment: deployment(),
      snapshot: snapshot('bbb2222'),
    });

    assert.deepEqual(result, {
      action: 'skipped',
      reason: 'empty_or_missing_commit_range',
    });
    assert.equal(store.current().deployments['example-client'].lastBuildSha, 'aaa1111');
    assert.equal(store.current().deployments['example-client'].lastObservedBuildSha, 'bbb2222');
  });

  it('rejects empty or scrubbed garbage notes', () => {
    // Must not throw on null/non-object (a failed agent parse yields null).
    assert.equal(sanitizeReleaseNoteDraft(null), null);
    assert.equal(sanitizeReleaseNoteDraft(undefined), null);
    assert.equal(sanitizeReleaseNoteDraft('not an object'), null);
    assert.equal(sanitizeReleaseNoteDraft(['array']), null);
    assert.equal(sanitizeReleaseNoteDraft({ summary: 'abc1234 BOS_FLAG' }), null);
    assert.deepEqual(
      sanitizeReleaseNoteDraft({
        title: 'What\'s new',
        summary: 'The queue is easier for operators to scan this week.',
        body: 'DM_INTERNAL_FLAG',
      }),
      {
        title: 'What\'s new',
        summary: 'The queue is easier for operators to scan this week.',
        body: null,
      }
    );
  });

  it('builds a prompt that demands the JSON file and the exact git range', () => {
    const noteFilePath = '/tmp/dueno-release-notes/example-client-bbb2222.json';
    const prompt = buildReleaseNotePrompt({
      repoPath: '/repo/BusinessOS',
      previousBuildSha: 'aaa1111',
      newBuildSha: 'bbb2222',
      noteFilePath,
    });
    assert.match(prompt, /aaa1111\.\.bbb2222/);
    assert.match(prompt, /Write ONLY that JSON object to this exact file path/);
    assert.ok(prompt.includes(noteFilePath));
    assert.match(prompt, /plain business language/);
  });
});
