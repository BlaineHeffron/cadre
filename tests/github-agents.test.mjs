import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGithubAgentRepoStore,
  GithubAgentPoller,
  normalizeGithubAgentRepo,
  pollGithubRepo,
  spawnGithubAgentsForPollResult,
  validateGithubAuthRef,
} from '../modules/integrations/github-agents.mjs';
import { assertValidCodexModel } from '../modules/sessions/codex-models.mjs';

const BASE_REPO = {
  owner: 'octo',
  repo: 'demo',
  authRef: 'GITHUB_TOKEN_REF',
  prEnabled: true,
  issueEnabled: true,
  enabled: true,
};

describe('GitHub agents poller', () => {
  it('baselines on the first poll without emitting sessions to spawn', async () => {
    const calls = [];
    const result = await pollGithubRepo(BASE_REPO, {
      env: { GITHUB_TOKEN_REF: 'secret-token' },
      now: () => 1000,
      fetchImpl: mockGithubFetch(calls, {
        pulls: [githubItem(7, 'PR 7'), githubItem(2, 'PR 2')],
        issues: [githubItem(3, 'Issue 3')],
      }),
    });

    assert.equal(result.baselined, true);
    assert.deepEqual(result.newPullRequests, []);
    assert.deepEqual(result.newIssues, []);
    assert.equal(result.updatedRepo.lastSeenPrNumber, 7);
    assert.equal(result.updatedRepo.lastSeenIssueNumber, 3);
    assert.equal(result.updatedRepo.lastEvent, 'baseline');
    assert.equal(result.updatedRepo.authRef, 'GITHUB_TOKEN_REF');
    assert.equal(JSON.stringify(result).includes('secret-token'), false);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers.Authorization, 'Bearer secret-token');
    assert.equal(calls[0].headers.Accept, 'application/vnd.github+json');
    assert.equal(calls[0].headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(calls[0].headers['User-Agent'], 'dueno-fleet');
  });

  it('emits only new PRs and issues above high-water marks and advances cursors once', async () => {
    const first = await pollGithubRepo({
      ...BASE_REPO,
      lastSeenPrNumber: 7,
      lastSeenIssueNumber: 3,
    }, {
      env: { GITHUB_TOKEN_REF: 'secret-token' },
      now: () => 2000,
      fetchImpl: mockGithubFetch([], {
        pulls: [githubItem(8, 'PR 8'), githubItem(7, 'PR 7')],
        issues: [githubItem(4, 'Issue 4'), githubItem(3, 'Issue 3')],
      }),
    });

    assert.equal(first.baselined, false);
    assert.deepEqual(first.newPullRequests.map((item) => item.number), [8]);
    assert.deepEqual(first.newIssues.map((item) => item.number), [4]);
    assert.equal(first.updatedRepo.lastSeenPrNumber, 8);
    assert.equal(first.updatedRepo.lastSeenIssueNumber, 4);
    assert.equal(first.updatedRepo.lastEvent, 'new_items');

    const second = await pollGithubRepo(first.updatedRepo, {
      env: { GITHUB_TOKEN_REF: 'secret-token' },
      now: () => 3000,
      fetchImpl: mockGithubFetch([], {
        pulls: [githubItem(8, 'PR 8')],
        issues: [githubItem(4, 'Issue 4')],
      }),
    });

    assert.deepEqual(second.newPullRequests, []);
    assert.deepEqual(second.newIssues, []);
    assert.equal(second.updatedRepo.lastSeenPrNumber, 8);
    assert.equal(second.updatedRepo.lastSeenIssueNumber, 4);
    assert.equal(second.updatedRepo.lastEvent, 'no_new_items');
  });

  it('filters pull requests from the issues endpoint', async () => {
    const result = await pollGithubRepo({
      ...BASE_REPO,
      lastSeenPrNumber: 1,
      lastSeenIssueNumber: 1,
    }, {
      env: { GITHUB_TOKEN_REF: 'secret-token' },
      now: () => 4000,
      fetchImpl: mockGithubFetch([], {
        pulls: [],
        issues: [
          { ...githubItem(9, 'PR-shaped issue'), pull_request: { url: 'https://api.github.com/pr/9' } },
          githubItem(5, 'Real issue'),
        ],
      }),
    });

    assert.deepEqual(result.newIssues.map((item) => item.number), [5]);
    assert.equal(result.updatedRepo.lastSeenIssueNumber, 5);
  });

  it('baselines newly enabled issue polling independently from PR cursors', async () => {
    const result = await pollGithubRepo({
      ...BASE_REPO,
      lastSeenPrNumber: 10,
      lastSeenIssueNumber: null,
    }, {
      env: { GITHUB_TOKEN_REF: 'secret-token' },
      now: () => 4500,
      fetchImpl: mockGithubFetch([], {
        pulls: [githubItem(11, 'PR 11')],
        issues: [githubItem(6, 'Issue 6'), githubItem(2, 'Issue 2')],
      }),
    });

    assert.equal(result.baselinePr, false);
    assert.equal(result.baselineIssue, true);
    assert.deepEqual(result.newPullRequests.map((item) => item.number), [11]);
    assert.deepEqual(result.newIssues, []);
    assert.equal(result.updatedRepo.lastSeenPrNumber, 11);
    assert.equal(result.updatedRepo.lastSeenIssueNumber, 6);
  });

  it('sets empty baseline cursors to zero so the first future item emits', async () => {
    const baseline = await pollGithubRepo(BASE_REPO, {
      env: { GITHUB_TOKEN_REF: 'secret-token' },
      now: () => 4600,
      fetchImpl: mockGithubFetch([], { pulls: [], issues: [] }),
    });

    assert.equal(baseline.baselined, true);
    assert.equal(baseline.updatedRepo.lastSeenPrNumber, 0);
    assert.equal(baseline.updatedRepo.lastSeenIssueNumber, 0);

    const next = await pollGithubRepo(baseline.updatedRepo, {
      env: { GITHUB_TOKEN_REF: 'secret-token' },
      now: () => 4700,
      fetchImpl: mockGithubFetch([], {
        pulls: [githubItem(1, 'First PR')],
        issues: [githubItem(1, 'First issue')],
      }),
    });

    assert.equal(next.baselined, false);
    assert.deepEqual(next.newPullRequests.map((item) => item.number), [1]);
    assert.deepEqual(next.newIssues.map((item) => item.number), [1]);
  });

  it('can suppress startup spawns while advancing high-water marks', async () => {
    const launches = [];
    let saved = null;
    const store = buildGithubAgentRepoStore({
      stateStore: {
        loadSync: () => null,
        load: async () => saved,
        save: async (data) => { saved = data; },
        close: async () => {},
      },
      now: () => 7000,
    });
    await store.upsertRepo({
      ...BASE_REPO,
      lastSeenPrNumber: 7,
      lastSeenIssueNumber: 3,
    });
    const poller = new GithubAgentPoller({
      repoStore: store,
      config: {
        enabled: true,
        env: { GITHUB_TOKEN_REF: 'secret-token' },
        repoPaths: {},
        workDir: '/tmp/github-agents',
        maxSpawnsPerPoll: 5,
      },
      now: () => 7100,
      fetchImpl: mockGithubFetch([], {
        pulls: [githubItem(8, 'PR 8')],
        issues: [githubItem(4, 'Issue 4')],
      }),
      resolveScratchWorkDir: async ({ kind, number }) => `/tmp/${kind}-${number}`,
      sessionLauncher: async (launch) => {
        launches.push(launch);
        return { sessionId: `sess_${launch.metadata.github_kind}_${launch.metadata.github_number}` };
      },
    });

    const startup = await poller.pollOnce({ suppressSpawn: true });
    assert.deepEqual(startup[0].newPullRequests.map((item) => item.number), [8]);
    assert.deepEqual(startup[0].newIssues.map((item) => item.number), [4]);
    assert.deepEqual(startup[0].spawned, []);
    assert.equal(launches.length, 0);

    const repoAfterStartup = await store.getRepo('octo/demo');
    assert.equal(repoAfterStartup.lastSeenPrNumber, 8);
    assert.equal(repoAfterStartup.lastSeenIssueNumber, 4);

    const next = await poller.pollOnce();
    assert.deepEqual(next[0].newPullRequests, []);
    assert.deepEqual(next[0].newIssues, []);
    assert.equal(launches.length, 0);
  });

  it('returns sanitized errors for GitHub failures and never leaks tokens', async () => {
    for (const [status, expected] of [[401, 'unauthorized'], [403, 'unauthorized'], [404, 'not_found'], [500, 'server_error']]) {
      const result = await pollGithubRepo(BASE_REPO, {
        env: { GITHUB_TOKEN_REF: 'secret-token' },
        now: () => 5000,
        fetchImpl: async () => response(status, { message: 'raw upstream detail' }),
      });
      assert.equal(result.error, expected);
      assert.equal(result.updatedRepo.lastError, expected);
      assert.equal(JSON.stringify(result).includes('secret-token'), false);
      assert.equal(JSON.stringify(result).includes('raw upstream detail'), false);
    }
  });

  it('sanitizes timeouts without crashing the repo poll', async () => {
    const result = await pollGithubRepo(BASE_REPO, {
      env: { GITHUB_TOKEN_REF: 'secret-token' },
      now: () => 6000,
      timeoutMs: 1,
      fetchImpl: (_url, opts = {}) => new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
    });

    assert.equal(result.error, 'timeout');
    assert.equal(result.updatedRepo.lastError, 'timeout');
  });

  it('enforces refs-only auth references', () => {
    assert.equal(validateGithubAuthRef('GITHUB_TOKEN_REF'), 'GITHUB_TOKEN_REF');
    assert.throws(() => validateGithubAuthRef('ghp_inline_secret'), /env-style ref/);
    assert.throws(() => validateGithubAuthRef('https://example.test/token'), /env-style ref/);
    assert.throws(() => normalizeGithubAgentRepo({ ...BASE_REPO, authRef: 'github_pat_inline' }), /env-style ref/);
  });

  it('persists repo records through the github_agent_repos store shape', async () => {
    let saved = null;
    const stateStore = {
      loadSync: () => null,
      load: async () => saved,
      save: async (data) => { saved = data; },
      close: async () => {},
    };
    const store = buildGithubAgentRepoStore({
      stateStore,
      now: () => 7000,
      defaultAutoReviewEnabled: true,
    });

    const repo = await store.upsertRepo(BASE_REPO);
    assert.equal(repo.id, 'octo/demo');
    assert.equal(repo.autoReviewEnabled, true);
    assert.equal(saved.version, 1);
    assert.equal(saved.repos['octo/demo'].authRef, 'GITHUB_TOKEN_REF');

    const updated = await store.updateRepo('octo/demo', { lastSeenPrNumber: 12, lastSpawnSessionId: 'sess_1' });
    assert.equal(updated.lastSeenPrNumber, 12);
    assert.equal(updated.lastSpawnSessionId, 'sess_1');
    assert.deepEqual((await store.listRepos()).map((entry) => entry.id), ['octo/demo']);
    await store.close();
  });

  it('spawns one scoped session for a new PR using a configured worktree', async () => {
    const launches = [];
    const worktrees = [];
    const repoUpdates = [];
    const result = await spawnGithubAgentsForPollResult({
      updatedRepo: { ...BASE_REPO, id: 'octo/demo' },
      newPullRequests: [githubItem(12, 'Fix bug')],
      newIssues: [],
    }, {
      config: {
        enabled: true,
        repoPaths: { 'octo/demo': '/repo/demo' },
        workDir: '/tmp/github-agents',
        provider: 'codex',
        model: 'gpt-5.5',
        thinkingLevel: 'medium',
        maxSpawnsPerPoll: 5,
      },
      now: () => 8000,
      createPrWorktree: async (args) => {
        worktrees.push(args);
        return {
          repoPath: '/repo/demo',
          worktreePath: '/tmp/github-agents/worktrees/octo-demo/pr-12/demo',
          branch: 'dueno-fleet/pr-12-8000',
          baseRef: 'origin/main',
          baseHead: 'base123',
          sourceBranch: 'main',
          sourceHead: 'abc123',
          repoName: 'demo',
        };
      },
      sessionLauncher: async (launch) => {
        launches.push(launch);
        return { sessionId: 'sess_pr_12' };
      },
      repoStore: { updateRepo: async (id, patch) => { repoUpdates.push({ id, patch }); return { id, ...patch }; } },
    });

    assert.equal(result.spawned.length, 1);
    assert.equal(result.spawned[0].sessionId, 'sess_pr_12');
    assert.equal(worktrees[0].repoPath, '/repo/demo');
    assert.equal(worktrees[0].prNumber, 12);
    assert.equal(worktrees[0].itemId, '8000');
    assert.equal(launches[0].workDir, '/tmp/github-agents/worktrees/octo-demo/pr-12/demo');
    assert.equal(launches[0].displayName, 'GitHub PR #12');
    assert.equal(launches[0].metadata.github_repo, 'octo/demo');
    assert.equal(launches[0].metadata.github_kind, 'pr');
    assert.equal(launches[0].metadata.github_number, 12);
    assert.equal(launches[0].metadata.github_branch, 'dueno-fleet/pr-12-8000');
    assert.equal(launches[0].metadata.github_base_ref, 'origin/main');
    assert.equal(launches[0].metadata.github_base_head, 'base123');
    assert.match(launches[0].prompt, /baseRef: origin\/main/);
    assert.match(launches[0].prompt, /pull request/);
    assert.match(launches[0].prompt, /Fix bug/);
    assert.match(launches[0].prompt, /autoReviewEnabled=true: you ARE authorized to post a GitHub pull-request review/);
    assert.doesNotMatch(launches[0].prompt, /Do not post comments, reviews, commits, pushes, GitHub mutations/);
    assert.doesNotMatch(launches[0].prompt, /auto-post/i);
    assert.deepEqual(repoUpdates, [{
      id: 'octo/demo',
      patch: { lastSpawnSessionId: 'sess_pr_12', lastEvent: 'spawned_pr', spawnedItemKeys: ['pr:12'] },
    }]);
  });

  it('spawns one scoped session for a new issue using a project-first configured worktree', async () => {
    const launches = [];
    const worktrees = [];
    const result = await spawnGithubAgentsForPollResult({
      updatedRepo: { ...BASE_REPO, id: 'octo/demo' },
      newPullRequests: [],
      newIssues: [githubItem(14, 'Investigate issue')],
    }, {
      config: {
        enabled: true,
        repoPaths: { 'octo/demo': '/repo/demo' },
        workDir: '/tmp/github-agents',
      },
      now: () => 10_000,
      createIssueWorktree: async (args) => {
        worktrees.push(args);
        return {
          repoPath: '/repo/demo',
          worktreePath: '/tmp/github-agents/worktrees/octo-demo/issue-14-10000/demo',
          branch: 'dueno-fleet/issue/issue-14-10000',
          sourceBranch: 'main',
          sourceHead: 'abc123',
          repoName: 'demo',
        };
      },
      sessionLauncher: async (launch) => {
        launches.push(launch);
        return { sessionId: 'sess_issue_14' };
      },
    });

    assert.equal(result.spawned[0].sessionId, 'sess_issue_14');
    assert.equal(worktrees[0].repoPath, '/repo/demo');
    assert.equal(worktrees[0].repoId, 'octo/demo');
    assert.equal(worktrees[0].issueNumber, 14);
    assert.equal(worktrees[0].itemId, '10000');
    assert.equal(worktrees[0].incidentId, 'issue-14-10000');
    assert.equal(launches[0].workDir, '/tmp/github-agents/worktrees/octo-demo/issue-14-10000/demo');
    assert.equal(launches[0].metadata.github_worktree_path, '/tmp/github-agents/worktrees/octo-demo/issue-14-10000/demo');
    assert.equal(launches[0].metadata.github_branch, 'dueno-fleet/issue/issue-14-10000');
    assert.match(launches[0].prompt, /issue/);
    assert.match(launches[0].prompt, /Investigate issue/);
  });

  it('falls back to scratch when PR worktree creation fails', async () => {
    const launches = [];
    const result = await spawnGithubAgentsForPollResult({
      updatedRepo: { ...BASE_REPO, id: 'octo/demo' },
      newPullRequests: [githubItem(13, 'Broken branch')],
      newIssues: [],
    }, {
      config: {
        enabled: true,
        repoPaths: { 'octo/demo': '/repo/demo' },
        workDir: '/tmp/github-agents',
      },
      now: () => 9000,
      createPrWorktree: async () => {
        const error = new Error('fetch failed');
        error.code = 'github_pr_fetch_failed';
        throw error;
      },
      resolveScratchWorkDir: async () => '/tmp/github-agents/scratch/octo-demo/pr-13-9000',
      sessionLauncher: async (launch) => {
        launches.push(launch);
        return { id: 'sess_scratch' };
      },
    });

    assert.equal(result.spawned[0].sessionId, 'sess_scratch');
    assert.equal(launches[0].workDir, '/tmp/github-agents/scratch/octo-demo/pr-13-9000');
    assert.equal(launches[0].metadata.github_fallback_reason, 'github_pr_fetch_failed');
    assert.match(launches[0].prompt, /fallbackReason: github_pr_fetch_failed/);
  });

  it('falls back to scratch when no local repo path is mapped', async () => {
    const launches = [];
    const result = await spawnGithubAgentsForPollResult({
      updatedRepo: { ...BASE_REPO, id: 'octo/demo' },
      newPullRequests: [],
      newIssues: [githubItem(14, 'Investigate issue')],
    }, {
      config: { enabled: true, repoPaths: {}, workDir: '/tmp/github-agents' },
      now: () => 10_000,
      resolveScratchWorkDir: async () => '/tmp/github-agents/scratch/octo-demo/issue-14-10000',
      sessionLauncher: async (launch) => {
        launches.push(launch);
        return { sessionId: 'sess_issue' };
      },
    });

    assert.equal(result.spawned[0].sessionId, 'sess_issue');
    assert.equal(launches[0].metadata.github_kind, 'issue');
    assert.equal(launches[0].metadata.github_fallback_reason, 'repo_not_configured');
    assert.match(launches[0].prompt, /issue/);
    assert.match(launches[0].prompt, /Investigate issue/);
  });

  it('respects the per-poll spawn cap', async () => {
    const launches = [];
    const warnings = [];
    const result = await spawnGithubAgentsForPollResult({
      updatedRepo: { ...BASE_REPO, id: 'octo/demo' },
      newPullRequests: [githubItem(1, 'PR 1'), githubItem(2, 'PR 2')],
      newIssues: [githubItem(3, 'Issue 3')],
    }, {
      config: { enabled: true, repoPaths: {}, workDir: '/tmp/github-agents', maxSpawnsPerPoll: 2 },
      resolveScratchWorkDir: async ({ kind, number }) => `/tmp/${kind}-${number}`,
      sessionLauncher: async (launch) => {
        launches.push(launch);
        return { sessionId: `sess_${launch.metadata.github_kind}_${launch.metadata.github_number}` };
      },
      log: { warn: (data) => warnings.push(data) },
    });

    assert.equal(result.capped, true);
    assert.equal(result.spawned.length, 2);
    assert.equal(launches.length, 2);
    assert.equal(warnings[0].requested, 3);
    assert.equal(result.updatedRepo.lastSeenIssueNumber, 2);
  });

  it('does not respawn an item already recorded in the per-item ledger', async () => {
    const launches = [];
    const repoUpdates = [];
    const result = await spawnGithubAgentsForPollResult({
      updatedRepo: {
        ...BASE_REPO,
        id: 'octo/demo',
        lastSeenPrNumber: 18,
        spawnedItemKeys: ['pr:19'],
      },
      newPullRequests: [githubItem(19, 'Already spawned'), githubItem(20, 'New PR')],
      newIssues: [],
    }, {
      config: { enabled: true, repoPaths: {}, workDir: '/tmp/github-agents', maxSpawnsPerPoll: 5 },
      resolveScratchWorkDir: async ({ kind, number }) => `/tmp/${kind}-${number}`,
      sessionLauncher: async (launch) => {
        launches.push(launch);
        return { sessionId: `sess_${launch.metadata.github_kind}_${launch.metadata.github_number}` };
      },
      repoStore: { updateRepo: async (id, patch) => { repoUpdates.push({ id, patch }); return { id, ...patch }; } },
    });

    assert.equal(result.spawned.length, 1);
    assert.equal(result.spawned[0].number, 20);
    assert.deepEqual(launches.map((launch) => launch.metadata.github_number), [20]);
    assert.deepEqual(repoUpdates[0].patch.spawnedItemKeys, ['pr:19', 'pr:20']);
  });

  it('does not spawn when a live existing session is already in the item worktree', async () => {
    const launches = [];
    const repoUpdates = [];
    const result = await spawnGithubAgentsForPollResult({
      updatedRepo: {
        ...BASE_REPO,
        id: 'octo/demo',
        owner: 'octo',
        repo: 'demo',
        lastSeenPrNumber: 207,
      },
      newPullRequests: [githubItem(207, 'Existing PR session')],
      newIssues: [],
    }, {
      config: { enabled: true, repoPaths: {}, workDir: '/tmp/github-agents', maxSpawnsPerPoll: 5 },
      resolveScratchWorkDir: async ({ kind, number }) => `/tmp/${kind}-${number}`,
      listExistingSessions: async () => [{
        id: 'existing_pr_207',
        source: 'dashboard',
        workDir: '/tmp/github-agents/worktrees/octo-demo/pr-207-abc/demo',
      }],
      sessionLauncher: async (launch) => {
        launches.push(launch);
        return { sessionId: `sess_${launch.metadata.github_kind}_${launch.metadata.github_number}` };
      },
      repoStore: { updateRepo: async (id, patch) => { repoUpdates.push({ id, patch }); return { id, ...patch }; } },
    });

    assert.deepEqual(result.spawned, []);
    assert.equal(launches.length, 0);
    assert.deepEqual(repoUpdates, [{
      id: 'octo/demo',
      patch: { lastSpawnSessionId: 'existing_pr_207', lastEvent: 'existing_pr', spawnedItemKeys: ['pr:207'] },
    }]);
  });

  it('does not spawn when a live pi session matches item metadata on the default path', async () => {
    await withTempCwd(async (dir) => {
      await writePiRegistry(dir, [piGithubSession()]);
      const outcome = await spawnForGithubItem({
        tmuxSessionExists: async () => true,
      });
      assertExistingSession(outcome, { sessionId: 'pi_existing_pr_42', kind: 'pr', number: 42 });
    });
  });

  it('does not spawn when a live pi session is only in the legacy registry', async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, '.pi_sessions.json'), JSON.stringify([piGithubSession({
        id: 'pi_legacy_pr_42',
        tmuxSession: 'pi-legacy-pr-42',
      })]));
      const outcome = await spawnForGithubItem({
        tmuxSessionExists: async () => true,
      });
      assertExistingSession(outcome, { sessionId: 'pi_legacy_pr_42', kind: 'pr', number: 42 });
    });
  });

  it('ignores the legacy pi registry when piSessionsFile is set', async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, '.pi_sessions.json'), JSON.stringify([piGithubSession()]));
      const outcome = await spawnForGithubItem({
        config: { piSessionsFile: join(dir, 'missing-pi.json') },
        tmuxSessionExists: async () => true,
      });
      assertSpawned(outcome, { kind: 'pr', number: 42 });
    });
  });

  it('spawns when no session registries exist', async () => {
    await withTempCwd(async () => {
      const outcome = await spawnForGithubItem({
        tmuxSessionExists: async () => true,
      });
      assertSpawned(outcome, { kind: 'pr', number: 42 });
    });
  });

  it('does not spawn when a live pi session matches the item worktree path', async () => {
    await withTempCwd(async (dir) => {
      await writePiRegistry(dir, [piGithubSession({
        id: 'pi_worktree_pr_42',
        metadata: false,
        workDir: '/tmp/github-agents/worktrees/octo-demo/pr-42-abc/demo',
      })]);
      const outcome = await spawnForGithubItem({
        tmuxSessionExists: async () => true,
      });
      assertExistingSession(outcome, { sessionId: 'pi_worktree_pr_42', kind: 'pr', number: 42 });
    });
  });

  it('spawns when a matching pi session is no longer live in tmux', async () => {
    await withTempCwd(async (dir) => {
      await writePiRegistry(dir, [piGithubSession()]);
      const outcome = await spawnForGithubItem({
        tmuxSessionExists: async () => false,
      });
      assertSpawned(outcome, { kind: 'pr', number: 42 });
    });
  });

  it('does not spawn when a live pi session matches issue metadata', async () => {
    await withTempCwd(async (dir) => {
      await writePiRegistry(dir, [piGithubSession({
        id: 'pi_existing_issue_9',
        kind: 'issue',
        number: 9,
        tmuxSession: 'pi-existing-issue-9',
      })]);
      const outcome = await spawnForGithubItem({
        kind: 'issue',
        number: 9,
        title: 'Existing Pi issue session',
        tmuxSessionExists: async () => true,
      });
      assertExistingSession(outcome, { sessionId: 'pi_existing_issue_9', kind: 'issue', number: 9 });
    });
  });

  it('spawns when a live pi session belongs to a different item', async () => {
    await withTempCwd(async (dir) => {
      await writePiRegistry(dir, [piGithubSession({ id: 'pi_other_pr_99', number: 99, tmuxSession: 'pi-other-pr-99' })]);
      const outcome = await spawnForGithubItem({
        tmuxSessionExists: async () => true,
      });
      assertSpawned(outcome, { kind: 'pr', number: 42 });
    });
  });

  it('logs the original spawn error while persisting a sanitized lastError', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-github-agent-error-'));
    const logs = [];
    const broadcasts = [];
    let saved = null;
    try {
      const store = buildGithubAgentRepoStore({
        stateStore: {
          loadSync: () => null,
          load: async () => saved,
          save: async (data) => { saved = data; },
          close: async () => {},
        },
        now: () => 12_000,
      });
      await store.upsertRepo({
        ...BASE_REPO,
        lastSeenPrNumber: 7,
        lastSeenIssueNumber: 3,
      });
      const poller = new GithubAgentPoller({
        repoStore: store,
        config: {
          enabled: true,
          env: { GITHUB_TOKEN_REF: 'secret-token' },
          repoPaths: {},
          workDir: '/tmp/github-agents',
          provider: 'codex',
          model: 'grok-4.6',
          maxSpawnsPerPoll: 5,
        },
        now: () => 12_100,
        fetchImpl: mockGithubFetch([], {
          pulls: [githubItem(8, 'PR 8')],
          issues: [githubItem(4, 'Issue 4')],
        }),
        resolveScratchWorkDir: async ({ kind, number }) => `/tmp/${kind}-${number}`,
        sessionLauncher: async (launch) => {
          assert.equal(launch.provider, 'codex');
          assert.equal(launch.model, 'grok-4.6');
          await assertValidCodexModel(launch.model, {
            forceRefresh: true,
            env: {},
            cacheFile: join(dir, 'model-cache.json'),
            fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
          });
          throw new Error('should not create session');
        },
        onResult: async (payload) => { broadcasts.push(payload); },
        log: {
          error(data, message) {
            logs.push({ data, message });
          },
        },
      });

      const results = await poller.pollOnce();
      const result = results[0];
      const persisted = await store.getRepo('octo/demo');
      const serialized = JSON.stringify({ result, persisted, broadcasts });

      assert.equal(results.length, 1);
      assert.equal(result.error, 'poll_failed');
      assert.equal(result.updatedRepo.lastError, 'poll_failed');
      assert.equal(persisted.lastError, 'poll_failed');
      assert.equal(broadcasts[0].updatedRepo.lastError, 'poll_failed');
      assert.equal(serialized.includes('Unsupported Codex model'), false);
      assert.equal(serialized.includes('grok-4.6'), false);

      assert.equal(logs.length, 1);
      assert.equal(logs[0].message, 'GitHub agent repo poll failed');
      assert.equal(logs[0].data.repoId, 'octo/demo');
      assert.equal(logs[0].data.statusCode, 400);
      assert.equal(logs[0].data.code, null);
      assert.match(logs[0].data.message, /Unsupported Codex model "grok-4.6"/);
      assert.match(String(logs[0].data.stack || ''), /assertValidCodexModel|assertProviderModel|invalidModelError/);
      assert.match(logs[0].data.err.message, /Unsupported Codex model "grok-4.6"/);
      assert.equal(logs[0].data.err.statusCode, 400);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('maps statusCode-only HTTP errors to existing sanitized buckets', async () => {
    const cases = [
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [404, 'not_found'],
      [500, 'server_error'],
      [503, 'server_error'],
    ];
    for (const [statusCode, expected] of cases) {
      let saved = null;
      const store = buildGithubAgentRepoStore({
        stateStore: {
          loadSync: () => null,
          load: async () => saved,
          save: async (data) => { saved = data; },
          close: async () => {},
        },
        now: () => 13_000,
      });
      await store.upsertRepo({
        ...BASE_REPO,
        lastSeenPrNumber: 7,
        lastSeenIssueNumber: 3,
      });
      const poller = new GithubAgentPoller({
        repoStore: store,
        config: {
          enabled: true,
          env: { GITHUB_TOKEN_REF: 'secret-token' },
          repoPaths: {},
          workDir: '/tmp/github-agents',
          maxSpawnsPerPoll: 5,
        },
        now: () => 13_100,
        fetchImpl: mockGithubFetch([], {
          pulls: [githubItem(8, 'PR 8')],
          issues: [],
        }),
        resolveScratchWorkDir: async ({ kind, number }) => `/tmp/${kind}-${number}`,
        sessionLauncher: async () => {
          const error = new Error(`upstream failed with ${statusCode}`);
          error.statusCode = statusCode;
          throw error;
        },
      });

      const [result] = await poller.pollOnce();
      const persisted = await store.getRepo('octo/demo');
      assert.equal(result.error, expected, `statusCode ${statusCode}`);
      assert.equal(result.updatedRepo.lastError, expected);
      assert.equal(persisted.lastError, expected);
      assert.equal(JSON.stringify(result).includes(`upstream failed with ${statusCode}`), false);
    }
  });

  it('removes the created worktree when sessionLauncher throws and does not record spawnedItemKeys', async () => {
    const removed = [];
    const repoUpdates = [];
    await assert.rejects(() => spawnGithubAgentsForPollResult({
      updatedRepo: { ...BASE_REPO, id: 'octo/demo' },
      newPullRequests: [githubItem(159, 'Leaks worktrees')],
      newIssues: [],
    }, {
      config: {
        enabled: true,
        repoPaths: { 'octo/demo': '/repo/demo' },
        workDir: '/tmp/github-agents',
      },
      now: () => 8000,
      createPrWorktree: async () => ({
        repoPath: '/repo/demo',
        worktreePath: '/tmp/github-agents/worktrees/octo-demo/pr-159-8000/demo',
        branch: 'dueno-fleet/pr-159-8000',
        baseRef: 'origin/main',
        baseHead: 'base123',
        sourceBranch: 'main',
        sourceHead: 'abc123',
        repoName: 'demo',
      }),
      removeWorktree: async (args) => {
        removed.push(args);
        return { removed: true, path: args.worktreePath, branch: args.branch };
      },
      sessionLauncher: async () => {
        throw new Error('unsupported model');
      },
      repoStore: { updateRepo: async (id, patch) => { repoUpdates.push({ id, patch }); return { id, ...patch }; } },
    }), /unsupported model/);

    assert.equal(removed.length, 1);
    assert.equal(removed[0].repoPath, '/repo/demo');
    assert.equal(removed[0].worktreePath, '/tmp/github-agents/worktrees/octo-demo/pr-159-8000/demo');
    assert.equal(removed[0].branch, 'dueno-fleet/pr-159-8000');
    assert.equal(removed[0].force, true);
    assert.deepEqual(repoUpdates, []);
  });

  it('backs off a failing item without using spawnedItemKeys as a failure marker', async () => {
    const spawnBackoff = new Map();
    const launches = [];
    const worktrees = [];
    const removed = [];
    const nowMs = { value: 20_000 };
    const poll = () => spawnGithubAgentsForPollResult({
      updatedRepo: { ...BASE_REPO, id: 'octo/demo', spawnedItemKeys: [], lastSeenPrNumber: 159 },
      newPullRequests: [githubItem(159, 'Failing PR')],
      newIssues: [],
    }, {
      config: {
        enabled: true,
        repoPaths: { 'octo/demo': '/repo/demo' },
        workDir: '/tmp/github-agents',
      },
      now: () => nowMs.value,
      spawnBackoff,
      createPrWorktree: async (args) => {
        worktrees.push(args);
        return {
          repoPath: '/repo/demo',
          worktreePath: `/tmp/github-agents/worktrees/octo-demo/pr-159-${args.itemId}/demo`,
          branch: `dueno-fleet/pr-159-${args.itemId}`,
          sourceBranch: 'main',
          sourceHead: 'abc123',
          repoName: 'demo',
        };
      },
      removeWorktree: async (args) => {
        removed.push(args.worktreePath);
        return { removed: true, path: args.worktreePath, branch: args.branch };
      },
      sessionLauncher: async () => {
        launches.push(nowMs.value);
        throw new Error('launcher failed');
      },
    });

    await assert.rejects(poll, /launcher failed/);
    assert.equal(worktrees.length, 1);
    assert.equal(launches.length, 1);
    assert.equal(removed.length, 1);
    assert.equal(spawnBackoff.get('octo/demo:pr:159').count, 1);

    nowMs.value = 20_000 + 59_000;
    const skipped = await poll();
    assert.equal(skipped.spawned.length, 0);
    assert.equal(worktrees.length, 1);
    assert.equal(launches.length, 1);
    assert.deepEqual(skipped.updatedRepo.spawnedItemKeys || [], []);
    assert.equal(skipped.updatedRepo.lastSeenPrNumber, 158);

    nowMs.value = 20_000 + 60_000;
    await assert.rejects(poll, /launcher failed/);
    assert.equal(worktrees.length, 2);
    assert.equal(launches.length, 2);
    assert.equal(removed.length, 2);
    assert.equal(spawnBackoff.get('octo/demo:pr:159').count, 2);
    assert.notDeepEqual(worktrees[0].itemId, worktrees[1].itemId);
  });

  it('clears spawn backoff after a successful retry', async () => {
    const spawnBackoff = new Map();
    let shouldFail = true;
    const poll = () => spawnGithubAgentsForPollResult({
      updatedRepo: { ...BASE_REPO, id: 'octo/demo' },
      newPullRequests: [githubItem(42, 'Retry later')],
      newIssues: [],
    }, {
      config: { enabled: true, repoPaths: {}, workDir: '/tmp/github-agents' },
      now: () => 30_000,
      spawnBackoff,
      resolveScratchWorkDir: async () => '/tmp/github-agents/scratch/octo-demo/pr-42',
      sessionLauncher: async () => {
        if (shouldFail) throw new Error('transient launcher error');
        return { sessionId: 'sess_pr_42' };
      },
    });

    await assert.rejects(poll, /transient launcher error/);
    shouldFail = false;
    spawnBackoff.set('octo/demo:pr:42', { count: 1, nextRetryMs: 30_000 });
    const result = await poll();
    assert.equal(result.spawned[0].sessionId, 'sess_pr_42');
    assert.equal(spawnBackoff.has('octo/demo:pr:42'), false);
    assert.deepEqual(result.updatedRepo.spawnedItemKeys, ['pr:42']);
  });

  it('removes an issue worktree when sessionLauncher throws', async () => {
    const removed = [];
    await assert.rejects(() => spawnGithubAgentsForPollResult({
      updatedRepo: { ...BASE_REPO, id: 'octo/demo' },
      newPullRequests: [],
      newIssues: [githubItem(14, 'Leaks issue worktrees')],
    }, {
      config: {
        enabled: true,
        repoPaths: { 'octo/demo': '/repo/demo' },
        workDir: '/tmp/github-agents',
      },
      now: () => 11_000,
      createIssueWorktree: async () => ({
        repoPath: '/repo/demo',
        worktreePath: '/tmp/github-agents/worktrees/octo-demo/issue-14-11000/demo',
        branch: 'dueno-fleet/issue/issue-14-11000',
        sourceBranch: 'main',
        sourceHead: 'abc123',
        repoName: 'demo',
      }),
      removeWorktree: async (args) => {
        removed.push(args);
        return { removed: true, path: args.worktreePath, branch: args.branch };
      },
      sessionLauncher: async () => {
        throw new Error('unsupported model');
      },
    }), /unsupported model/);

    assert.equal(removed.length, 1);
    assert.equal(removed[0].worktreePath, '/tmp/github-agents/worktrees/octo-demo/issue-14-11000/demo');
    assert.equal(removed[0].branch, 'dueno-fleet/issue/issue-14-11000');
    assert.equal(removed[0].force, true);
  });

  it('cleans up a worktree when sessionLauncher returns no session id', async () => {
    const removed = [];
    const result = await spawnGithubAgentsForPollResult({
      updatedRepo: { ...BASE_REPO, id: 'octo/demo', lastSeenPrNumber: 21 },
      newPullRequests: [githubItem(21, 'No session id')],
      newIssues: [],
    }, {
      config: {
        enabled: true,
        repoPaths: { 'octo/demo': '/repo/demo' },
        workDir: '/tmp/github-agents',
      },
      now: () => 21_000,
      createPrWorktree: async () => ({
        repoPath: '/repo/demo',
        worktreePath: '/tmp/github-agents/worktrees/octo-demo/pr-21-21000/demo',
        branch: 'dueno-fleet/pr-21-21000',
        sourceBranch: 'main',
        sourceHead: 'abc123',
        repoName: 'demo',
      }),
      removeWorktree: async (args) => {
        removed.push(args);
        return { removed: true, path: args.worktreePath };
      },
      sessionLauncher: async () => ({}),
    });

    assert.equal(result.spawned[0].sessionId, '');
    assert.equal(removed.length, 1);
    assert.equal(removed[0].worktreePath, '/tmp/github-agents/worktrees/octo-demo/pr-21-21000/demo');
    assert.deepEqual(result.updatedRepo.spawnedItemKeys || [], []);
    assert.equal(result.updatedRepo.lastSeenPrNumber, 20);
  });

  it('still throws the original spawn error if worktree cleanup fails', async () => {
    const warnings = [];
    await assert.rejects(() => spawnGithubAgentsForPollResult({
      updatedRepo: { ...BASE_REPO, id: 'octo/demo' },
      newPullRequests: [githubItem(22, 'Cleanup fails')],
      newIssues: [],
    }, {
      config: {
        enabled: true,
        repoPaths: { 'octo/demo': '/repo/demo' },
        workDir: '/tmp/github-agents',
      },
      now: () => 22_000,
      createPrWorktree: async () => ({
        repoPath: '/repo/demo',
        worktreePath: '/tmp/github-agents/worktrees/octo-demo/pr-22/demo',
        branch: 'dueno-fleet/pr-22-22000',
      }),
      removeWorktree: async () => {
        const error = new Error('remove failed');
        error.code = 'worktree_remove_failed';
        throw error;
      },
      sessionLauncher: async () => {
        throw new Error('unsupported model');
      },
      log: { warn: (data, message) => warnings.push({ data, message }) },
    }), /unsupported model/);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0].message || ''), /Failed to remove GitHub agent worktree/);
  });

  it('does not suppress a later item while an earlier item is backing off', async () => {
    const launches = [];
    const result = await spawnGithubAgentsForPollResult({
      updatedRepo: { ...BASE_REPO, id: 'octo/demo', lastSeenPrNumber: 160 },
      newPullRequests: [githubItem(159, 'Backing off'), githubItem(160, 'Ready')],
      newIssues: [],
    }, {
      config: { enabled: true, repoPaths: {}, workDir: '/tmp/github-agents' },
      now: () => 40_000,
      spawnBackoff: new Map([
        ['octo/demo:pr:159', { count: 1, nextRetryMs: 99_000 }],
      ]),
      resolveScratchWorkDir: async ({ kind, number }) => `/tmp/${kind}-${number}`,
      sessionLauncher: async (launch) => {
        launches.push(launch.metadata.github_number);
        return { sessionId: `sess_${launch.metadata.github_number}` };
      },
    });

    assert.deepEqual(launches, [160]);
    assert.deepEqual(result.updatedRepo.spawnedItemKeys, ['pr:160']);
    assert.equal(result.updatedRepo.lastSeenPrNumber, 158);
  });

  it('keeps a failing item eligible across poller backoff skips', async () => {
    let saved = null;
    const launches = [];
    const removed = [];
    const nowMs = { value: 50_000 };
    const store = buildGithubAgentRepoStore({
      stateStore: {
        loadSync: () => null,
        load: async () => saved,
        save: async (data) => { saved = data; },
        close: async () => {},
      },
      now: () => nowMs.value,
    });
    await store.upsertRepo({
      ...BASE_REPO,
      lastSeenPrNumber: 7,
      lastSeenIssueNumber: 3,
    });
    let shouldFail = true;
    const poller = new GithubAgentPoller({
      repoStore: store,
      config: {
        enabled: true,
        env: { GITHUB_TOKEN_REF: 'secret-token' },
        repoPaths: { 'octo/demo': '/repo/demo' },
        workDir: '/tmp/github-agents',
        maxSpawnsPerPoll: 5,
      },
      now: () => nowMs.value,
      fetchImpl: mockGithubFetch([], {
        pulls: [githubItem(8, 'PR 8')],
        issues: [githubItem(3, 'Issue 3')],
      }),
      createPrWorktree: async (args) => ({
        repoPath: '/repo/demo',
        worktreePath: `/tmp/github-agents/worktrees/octo-demo/pr-8-${args.itemId}/demo`,
        branch: `dueno-fleet/pr-8-${args.itemId}`,
        sourceBranch: 'main',
        sourceHead: 'abc123',
        repoName: 'demo',
      }),
      removeWorktree: async (args) => {
        removed.push(args.worktreePath);
        return { removed: true, path: args.worktreePath };
      },
      sessionLauncher: async () => {
        launches.push(nowMs.value);
        if (shouldFail) throw new Error('launcher failed');
        return { sessionId: 'sess_pr_8' };
      },
    });

    const [failed] = await poller.pollOnce();
    assert.equal(failed.error, 'poll_failed');
    assert.equal(launches.length, 1);
    assert.equal(removed.length, 1);
    assert.equal((await store.getRepo('octo/demo')).lastSeenPrNumber, 7);
    assert.deepEqual((await store.getRepo('octo/demo')).spawnedItemKeys, []);

    nowMs.value = 50_000 + 59_000;
    const [skipped] = await poller.pollOnce();
    assert.equal(skipped.error, null);
    assert.deepEqual(skipped.spawned, []);
    assert.equal(launches.length, 1);
    assert.equal((await store.getRepo('octo/demo')).lastSeenPrNumber, 7);
    assert.deepEqual((await store.getRepo('octo/demo')).spawnedItemKeys, []);

    nowMs.value = 50_000 + 60_000;
    shouldFail = false;
    const [recovered] = await poller.pollOnce();
    assert.equal(recovered.spawned[0].sessionId, 'sess_pr_8');
    assert.equal(launches.length, 2);
    assert.equal((await store.getRepo('octo/demo')).lastSeenPrNumber, 8);
    assert.deepEqual((await store.getRepo('octo/demo')).spawnedItemKeys, ['pr:8']);
  });

  it('preserves a successful sibling ledger when a later spawn throws', async () => {
    let saved = null;
    const store = buildGithubAgentRepoStore({
      stateStore: {
        loadSync: () => null,
        load: async () => saved,
        save: async (data) => { saved = data; },
        close: async () => {},
      },
      now: () => 61_000,
    });
    await store.upsertRepo({
      ...BASE_REPO,
      lastSeenPrNumber: 7,
      lastSeenIssueNumber: 3,
    });
    const poller = new GithubAgentPoller({
      repoStore: store,
      config: {
        enabled: true,
        env: { GITHUB_TOKEN_REF: 'secret-token' },
        repoPaths: {},
        workDir: '/tmp/github-agents',
        maxSpawnsPerPoll: 5,
      },
      now: () => 61_100,
      fetchImpl: mockGithubFetch([], {
        pulls: [githubItem(8, 'PR 8'), githubItem(9, 'PR 9')],
        issues: [],
      }),
      resolveScratchWorkDir: async ({ kind, number }) => `/tmp/${kind}-${number}`,
      sessionLauncher: async (launch) => {
        if (launch.metadata.github_number === 9) throw new Error('second item failed');
        return { sessionId: `sess_${launch.metadata.github_number}` };
      },
    });

    const [result] = await poller.pollOnce();
    const persisted = await store.getRepo('octo/demo');
    assert.equal(result.error, 'poll_failed');
    assert.deepEqual(persisted.spawnedItemKeys, ['pr:8']);
    assert.equal(persisted.lastSeenPrNumber, 7);
    assert.equal(persisted.lastError, 'poll_failed');
  });

  it('does not spawn when globally disabled or repo disabled', async () => {
    const globalDisabled = await spawnGithubAgentsForPollResult({
      updatedRepo: { ...BASE_REPO, id: 'octo/demo' },
      newPullRequests: [githubItem(15, 'PR 15')],
    }, {
      config: { enabled: false },
      sessionLauncher: async () => { throw new Error('should not spawn'); },
    });
    assert.equal(globalDisabled.skipped, true);
    assert.equal(globalDisabled.reason, 'github_agents_disabled');

    const repoDisabled = await spawnGithubAgentsForPollResult({
      updatedRepo: { ...BASE_REPO, id: 'octo/demo', enabled: false },
      newPullRequests: [githubItem(16, 'PR 16')],
    }, {
      config: { enabled: true },
      sessionLauncher: async () => { throw new Error('should not spawn'); },
    });
    assert.equal(repoDisabled.skipped, true);
    assert.equal(repoDisabled.reason, 'repo_disabled');
  });
});

function piGithubSession({
  id = 'pi_existing_pr_42',
  kind = 'pr',
  number = 42,
  repo = 'octo/demo',
  tmuxSession = 'pi-existing-pr-42',
  workDir = '',
  metadata = true,
} = {}) {
  return {
    id,
    tmuxSession,
    workDir,
    source: 'github-agent',
    provider: 'xai',
    runtime: 'pi',
    metadata: metadata
      ? {
        github_repo: repo,
        github_kind: kind,
        github_number: number,
      }
      : {},
  };
}

async function writePiRegistry(dir, sessions) {
  const stateDir = join(dir, '.dueno', 'state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'pi_sessions.json'), JSON.stringify(sessions));
}

async function withTempCwd(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dueno-github-pi-dedupe-'));
  const previousCwd = process.cwd();
  // Unset both names: a legacy DM_STATE_DIR loaded from .env would otherwise still apply.
  const stateKeys = ['CADRE_STATE_DIR', 'DM_STATE_DIR'];
  const previousStateDirs = stateKeys.map((key) => process.env[key]);
  process.chdir(dir);
  for (const key of stateKeys) delete process.env[key];
  try {
    return await fn(dir);
  } finally {
    process.chdir(previousCwd);
    stateKeys.forEach((key, index) => {
      if (previousStateDirs[index] === undefined) delete process.env[key];
      else process.env[key] = previousStateDirs[index];
    });
    await rm(dir, { recursive: true, force: true });
  }
}

async function spawnForGithubItem({
  kind = 'pr',
  number = 42,
  title = 'Existing Pi item',
  config = {},
  tmuxSessionExists,
} = {}) {
  const launches = [];
  const repoUpdates = [];
  const item = githubItem(number, title);
  const result = await spawnGithubAgentsForPollResult({
    updatedRepo: {
      ...BASE_REPO,
      id: 'octo/demo',
      owner: 'octo',
      repo: 'demo',
      lastSeenPrNumber: kind === 'pr' ? number : 1,
      lastSeenIssueNumber: kind === 'issue' ? number : 1,
    },
    newPullRequests: kind === 'pr' ? [item] : [],
    newIssues: kind === 'issue' ? [item] : [],
  }, {
    config: {
      enabled: true,
      repoPaths: {},
      workDir: '/tmp/github-agents',
      maxSpawnsPerPoll: 5,
      ...config,
    },
    resolveScratchWorkDir: async ({ kind: itemKind, number: itemNumber }) => `/tmp/${itemKind}-${itemNumber}`,
    tmuxSessionExists,
    sessionLauncher: async (launch) => {
      launches.push(launch);
      return { sessionId: `sess_${launch.metadata.github_kind}_${launch.metadata.github_number}` };
    },
    repoStore: {
      updateRepo: async (id, patch) => {
        repoUpdates.push({ id, patch });
        return { id, ...patch };
      },
    },
  });
  return { result, launches, repoUpdates };
}

function assertExistingSession(outcome, { sessionId, kind, number }) {
  assert.deepEqual(outcome.result.spawned, []);
  assert.equal(outcome.launches.length, 0);
  assert.deepEqual(outcome.repoUpdates, [{
    id: 'octo/demo',
    patch: {
      lastSpawnSessionId: sessionId,
      lastEvent: `existing_${kind}`,
      spawnedItemKeys: [`${kind}:${number}`],
    },
  }]);
}

function assertSpawned(outcome, { kind, number }) {
  assert.equal(outcome.result.spawned.length, 1);
  assert.equal(outcome.result.spawned[0].kind, kind);
  assert.equal(outcome.result.spawned[0].number, number);
  assert.equal(outcome.launches.length, 1);
}

function githubItem(number, title) {
  return {
    id: number * 10,
    number,
    title,
    state: 'open',
    html_url: `https://github.com/octo/demo/${number}`,
    url: `https://api.github.com/repos/octo/demo/issues/${number}`,
    created_at: '2026-06-22T12:00:00Z',
    updated_at: '2026-06-22T12:00:00Z',
    user: { login: 'alice' },
  };
}

function mockGithubFetch(calls, { pulls = [], issues = [] } = {}) {
  return async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers });
    if (String(url).includes('/pulls?')) return response(200, pulls);
    if (String(url).includes('/issues?')) return response(200, issues);
    return response(404, { message: 'not found' });
  };
}

function response(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  };
}
