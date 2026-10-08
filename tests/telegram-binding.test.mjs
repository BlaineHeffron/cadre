import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildBindingStore,
  claudeProjectDirName,
  claudeProjectDirNames,
  claudeTranscriptPath,
  hasExactBusIdentity,
  piProjectDirName,
  resolveBinding,
} from '../modules/telegram/binding.mjs';
import { duenoOriginator } from '../modules/agent/launch-env.mjs';

const WORK_DIR = '/home/dev/projects/fleet';

// Real epoch milliseconds: `created` below 1e12 would be read as seconds.
const CREATED_MS = 1_700_000_000_000;
const PREDATES_MS = 1_600_000_000_000;
const LIVE_MS = 1_700_000_500_000;
const NEWER_MS = 1_700_000_900_000;

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dueno-telegram-binding-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function jsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function claudeLines({ identity = '', text = 'hello' } = {}) {
  const records = [];
  if (identity) records.push({ type: 'user', message: { role: 'user', content: `Your identity: ${identity}` }, cwd: WORK_DIR });
  records.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, cwd: WORK_DIR });
  return jsonl(records);
}

function codexRollout({ cwd = WORK_DIR, duenoSessionId = '', identity = '', sessionId = 'cli-uuid', originator = 'codex-tui' } = {}) {
  const records = [{ type: 'session_meta', payload: { cwd, session_id: sessionId, originator, timestamp: new Date(0).toISOString() } }];
  if (duenoSessionId) {
    records.push({ type: 'event_msg', payload: { message: `export DUENO_SESSION_ID='${duenoSessionId}'` } });
  }
  if (identity) {
    records.push({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: `Your identity: ${identity}` }] } });
  }
  return jsonl(records);
}

/** Write a claude transcript into the project dir claude would actually use. */
async function writeClaudeTranscript(projectsDir, fileName, content, mtimeMs = LIVE_MS) {
  const dir = join(projectsDir, claudeProjectDirName(WORK_DIR));
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, fileName);
  await writeFile(filePath, content);
  await utimes(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

async function writeCodexRollout(sessionsDir, fileName, content, mtimeMs = LIVE_MS) {
  await mkdir(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, `rollout-${fileName}.jsonl`);
  await writeFile(filePath, content);
  await utimes(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

async function writePiTranscript(agentDir, cliSessionId, {
  cwd = WORK_DIR,
  fileName = `2026-07-30T23-33-14-321Z_${cliSessionId}.jsonl`,
} = {}) {
  const dir = join(agentDir, 'sessions', piProjectDirName(cwd));
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, fileName);
  await writeFile(filePath, jsonl([
    { type: 'session', version: 3, id: cliSessionId, cwd },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'pi output' }] } },
  ]));
  return filePath;
}

const noHook = async () => ({ duenoSessionId: '', transcriptPath: '', cliSessionId: '' });

function claudeSession(id, overrides = {}) {
  return { id, runtime: 'claude', workDir: WORK_DIR, created: CREATED_MS, ...overrides };
}

describe('claude project dir encoding', () => {
  it('encodes hidden fleet worktree paths the way Claude stores them', () => {
    const workDir = '/home/dev/.dueno-fleet/agent-worktrees/worktrees/agents/fix-telegram-issue/dueno-fleet';
    assert.equal(
      claudeProjectDirName(workDir),
      '-home-dev--dueno-fleet-agent-worktrees-worktrees-agents-fix-telegram-issue-dueno-fleet',
    );
    assert.deepEqual(claudeProjectDirNames(workDir), [
      '-home-dev--dueno-fleet-agent-worktrees-worktrees-agents-fix-telegram-issue-dueno-fleet',
      '-home-dev-.dueno-fleet-agent-worktrees-worktrees-agents-fix-telegram-issue-dueno-fleet',
    ]);
  });
});

describe('transcript binding resolvers', () => {
  it('binds a claude session whose workDir contains a hidden directory', async () => {
    await withTempDir(async (dir) => {
      const projectsDir = join(dir, 'projects');
      const workDir = '/home/dev/.dueno-fleet/agent-worktrees/worktrees/agents/codex-mss27ya2/example-app';
      const cliSessionId = '353fddd9-c0d3-4251-a299-861392c46a55';
      const encodedDir = join(
        projectsDir,
        '-home-dev--dueno-fleet-agent-worktrees-worktrees-agents-codex-mss27ya2-example-app',
      );
      await mkdir(encodedDir, { recursive: true });
      const expected = join(encodedDir, `${cliSessionId}.jsonl`);
      await writeFile(expected, claudeLines());

      assert.equal(claudeTranscriptPath(projectsDir, workDir, cliSessionId), expected);
      const result = await resolveBinding(claudeSession('3f97c1fe', { workDir, cliSessionId }), {
        liveTenantCount: 1,
        deps: { projectsDir, readHookSessionMetadata: noHook },
      });

      assert.equal(result.path, expected);
      assert.equal(result.anchor, 'cli_session_id');
    });
  });

  it('binds a claude session to the transcript named by its registry cliSessionId', async () => {
    await withTempDir(async (dir) => {
      const projectsDir = join(dir, 'projects');
      const cliSessionId = 'd35f5989-b630-4b26-83d8-a440e071737d';
      const expected = await writeClaudeTranscript(projectsDir, `${cliSessionId}.jsonl`, claudeLines());
      // A decoy that is newer and would win any mtime-based ranking.
      await writeClaudeTranscript(projectsDir, 'decoy.jsonl', claudeLines({ text: 'decoy' }), NEWER_MS);

      const result = await resolveBinding(claudeSession('aaaa1111', { cliSessionId }), {
        liveTenantCount: 2,
        deps: { projectsDir, readHookSessionMetadata: noHook },
      });

      assert.equal(result.path, expected);
      assert.equal(result.anchor, 'cli_session_id');
      assert.equal(result.cliSessionId, cliSessionId);
    });
  });

  it('ignores a registry cliSessionId whose transcript does not exist yet', async () => {
    await withTempDir(async (dir) => {
      const projectsDir = join(dir, 'projects');
      const only = await writeClaudeTranscript(projectsDir, 'only.jsonl', claudeLines(), LIVE_MS);

      const result = await resolveBinding(claudeSession('aaaa1111', { cliSessionId: 'not-written-yet' }), {
        liveTenantCount: 1,
        deps: { projectsDir, readHookSessionMetadata: noHook },
      });

      assert.equal(result.path, only, 'falls through to a weaker anchor rather than binding a missing file');
      assert.equal(result.anchor, 'sole_tenant');
    });
  });

  it('binds a Pi/OpenCode Go session to its exact project transcript', async () => {
    await withTempDir(async (dir) => {
      const piAgentDir = join(dir, 'pi-agent');
      const cliSessionId = 'd66caf53-6bf3-475d-a6db-730eeae32910';
      const expected = await writePiTranscript(piAgentDir, cliSessionId);
      await writePiTranscript(piAgentDir, 'decoy-session');

      const result = await resolveBinding({
        id: '34845546',
        runtime: 'pi',
        provider: 'opencode-go',
        workDir: WORK_DIR,
        cliSessionId,
      }, {
        liveTenantCount: 2,
        deps: { piAgentDir, readHookSessionMetadata: noHook },
      });

      assert.equal(result.path, expected);
      assert.equal(result.anchor, 'cli_session_id');
      assert.equal(result.cliSessionId, cliSessionId);
    });
  });

  it('refuses a Pi transcript whose header identity does not match the registry', async () => {
    await withTempDir(async (dir) => {
      const piAgentDir = join(dir, 'pi-agent');
      const cliSessionId = 'expected-session';
      await writePiTranscript(piAgentDir, 'wrong-session', {
        fileName: `2026-07-30T23-33-14-321Z_${cliSessionId}.jsonl`,
      });

      const result = await resolveBinding({
        id: '34845546',
        runtime: 'pi',
        workDir: WORK_DIR,
        cliSessionId,
      }, {
        deps: { piAgentDir, readHookSessionMetadata: noHook },
      });

      assert.equal(result.path, null);
      assert.equal(result.reason, 'not_found');
    });
  });

  it('binds a codex session by its dueno originator stamp, ignoring a newer same-cwd rollout', async () => {
    await withTempDir(async (dir) => {
      const codexSessionsDir = join(dir, 'codex');
      const expected = await writeCodexRollout(
        codexSessionsDir,
        'mine',
        codexRollout({ originator: duenoOriginator('cccc3333'), sessionId: 'cli-7' }),
        LIVE_MS,
      );
      await writeCodexRollout(codexSessionsDir, 'theirs', codexRollout({ originator: duenoOriginator('dddd4444') }), NEWER_MS);

      const result = await resolveBinding({ id: 'cccc3333', runtime: 'codex', workDir: WORK_DIR, created: CREATED_MS }, {
        liveTenantCount: 2,
        deps: { codexSessionsDir, readHookSessionMetadata: noHook },
      });

      assert.equal(result.path, expected);
      assert.equal(result.anchor, 'originator');
      assert.equal(result.cliSessionId, 'cli-7');
    });
  });

  it('does not bind a codex originator stamp from another cwd', async () => {
    await withTempDir(async (dir) => {
      const codexSessionsDir = join(dir, 'codex');
      await writeCodexRollout(
        codexSessionsDir,
        'elsewhere',
        codexRollout({ cwd: '/other/project', originator: duenoOriginator('cccc3333') }),
        LIVE_MS,
      );

      const result = await resolveBinding({ id: 'cccc3333', runtime: 'codex', workDir: WORK_DIR, created: CREATED_MS }, {
        liveTenantCount: 1,
        deps: { codexSessionsDir, readHookSessionMetadata: noHook },
      });

      assert.equal(result.path, null);
      assert.equal(result.reason, 'not_found');
    });
  });

  it('does not bind a manager rollout that merely quotes a child bus identity', async () => {
    await withTempDir(async (dir) => {
      const codexSessionsDir = join(dir, 'codex');
      const manager = codexRollout({
        originator: duenoOriginator('manager1'),
        sessionId: 'manager-cli',
      });
      await writeCodexRollout(
        codexSessionsDir,
        'manager',
        `${manager}${JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'mcp_tool_call_end',
            result: 'spawned child: Your identity: codex:cccc3333',
          },
        })}\n`,
        LIVE_MS,
      );

      const result = await resolveBinding({
        id: 'cccc3333',
        runtime: 'codex',
        workDir: WORK_DIR,
        created: CREATED_MS,
      }, {
        liveTenantCount: 1,
        deps: { codexSessionsDir, readHookSessionMetadata: noHook },
      });

      assert.equal(result.path, null);
      assert.equal(result.reason, 'not_found');
    });
  });

  it('does not bind a codex user identity carried by another dueno originator', async () => {
    await withTempDir(async (dir) => {
      const codexSessionsDir = join(dir, 'codex');
      await writeCodexRollout(
        codexSessionsDir,
        'other-dueno-session',
        codexRollout({
          identity: 'codex:cccc3333',
          originator: duenoOriginator('manager1'),
          sessionId: 'manager-cli',
        }),
        LIVE_MS,
      );

      const result = await resolveBinding({
        id: 'cccc3333',
        runtime: 'codex',
        workDir: WORK_DIR,
        created: CREATED_MS,
      }, {
        liveTenantCount: 2,
        deps: { codexSessionsDir, readHookSessionMetadata: noHook },
      });

      assert.equal(result.path, null);
      assert.equal(result.reason, 'ambiguous');
    });
  });

  it('replaces a persisted manager identity binding with the child originator binding', async () => {
    await withTempDir(async (dir) => {
      const codexSessionsDir = join(dir, 'codex');
      const managerPath = await writeCodexRollout(
        codexSessionsDir,
        'manager',
        codexRollout({
          identity: 'codex:cccc3333',
          originator: duenoOriginator('manager1'),
          sessionId: 'manager-cli',
        }),
        LIVE_MS,
      );
      const expected = await writeCodexRollout(
        codexSessionsDir,
        'child',
        codexRollout({
          originator: duenoOriginator('cccc3333'),
          sessionId: 'child-cli',
        }),
        NEWER_MS,
      );
      const { ino } = await stat(managerPath);

      const result = await resolveBinding({
        id: 'cccc3333',
        runtime: 'codex',
        workDir: WORK_DIR,
        created: CREATED_MS,
      }, {
        previous: {
          transcript_path: managerPath,
          anchor: 'identity',
          cli_session_id: 'manager-cli',
          ino,
        },
        liveTenantCount: 2,
        deps: { codexSessionsDir, readHookSessionMetadata: noHook },
      });

      assert.equal(result.path, expected);
      assert.equal(result.anchor, 'originator');
      assert.equal(result.reused, undefined);
    });
  });

  it('refuses to bind two co-located claude sessions rather than crossing their transcripts', async () => {
    await withTempDir(async (dir) => {
      const projectsDir = join(dir, 'projects');
      // Two live transcripts, both newer than both sessions' created times, no anchors.
      await writeClaudeTranscript(projectsDir, 'first.jsonl', claudeLines({ text: 'from first' }), LIVE_MS);
      await writeClaudeTranscript(projectsDir, 'second.jsonl', claudeLines({ text: 'from second' }), NEWER_MS);

      const deps = { projectsDir, readHookSessionMetadata: noHook };
      const first = await resolveBinding(claudeSession('aaaa1111', { created: CREATED_MS }), { liveTenantCount: 2, deps });
      const second = await resolveBinding(claudeSession('bbbb2222', { created: CREATED_MS + 60_000_000 }), { liveTenantCount: 2, deps });

      assert.equal(first.path, null);
      assert.equal(first.reason, 'ambiguous');
      assert.equal(second.path, null);
      assert.equal(second.reason, 'ambiguous');
    });
  });

  it('binds the claude session carrying a bus identity marker and still refuses its unanchored neighbour', async () => {
    await withTempDir(async (dir) => {
      const projectsDir = join(dir, 'projects');
      const anchored = await writeClaudeTranscript(projectsDir, 'first.jsonl', claudeLines({ identity: 'claude:aaaa1111' }), LIVE_MS);
      await writeClaudeTranscript(projectsDir, 'second.jsonl', claudeLines({ text: 'from second' }), NEWER_MS);

      const deps = { projectsDir, readHookSessionMetadata: noHook };
      const first = await resolveBinding(claudeSession('aaaa1111'), { liveTenantCount: 2, deps });
      const second = await resolveBinding(claudeSession('bbbb2222'), { liveTenantCount: 2, deps });

      assert.equal(first.path, anchored);
      assert.equal(first.anchor, 'identity');
      assert.equal(second.path, null, 'unanchored neighbour must not take the remaining file');
      assert.equal(second.reason, 'ambiguous');
    });
  });

  it('does not bind a claude transcript that only quotes another session identity in tool output', async () => {
    await withTempDir(async (dir) => {
      const projectsDir = join(dir, 'projects');
      await writeClaudeTranscript(
        projectsDir,
        'manager.jsonl',
        jsonl([
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_result', content: 'Your identity: claude:aaaa1111' }],
            },
            cwd: WORK_DIR,
          },
        ]),
        LIVE_MS,
      );

      const result = await resolveBinding(claudeSession('aaaa1111'), {
        liveTenantCount: 2,
        deps: { projectsDir, readHookSessionMetadata: noHook },
      });

      assert.equal(result.path, null);
      assert.equal(result.reason, 'ambiguous');
    });
  });

  it('binds a sole claude tenant to the only plausible transcript', async () => {
    await withTempDir(async (dir) => {
      const projectsDir = join(dir, 'projects');
      const expected = await writeClaudeTranscript(projectsDir, 'only.jsonl', claudeLines(), LIVE_MS);

      const result = await resolveBinding(claudeSession('aaaa1111'), {
        liveTenantCount: 1,
        deps: { projectsDir, readHookSessionMetadata: noHook },
      });

      assert.equal(result.path, expected);
      assert.equal(result.anchor, 'sole_tenant');
    });
  });

  it('excludes transcripts that predate a sole tenant session instead of ranking by clock distance', async () => {
    await withTempDir(async (dir) => {
      const projectsDir = join(dir, 'projects');
      // The dead transcript stopped writing long before this session started; the live one is current.
      await writeClaudeTranscript(projectsDir, 'dead.jsonl', claudeLines({ text: 'old' }), PREDATES_MS);
      const live = await writeClaudeTranscript(projectsDir, 'live.jsonl', claudeLines({ text: 'new' }), LIVE_MS);

      const result = await resolveBinding(claudeSession('aaaa1111', { created: CREATED_MS }), {
        liveTenantCount: 1,
        deps: { projectsDir, readHookSessionMetadata: noHook },
      });

      assert.equal(result.path, live);
      assert.equal(result.anchor, 'sole_tenant');
    });
  });

  it('prefers an explicit hook binding over any scan', async () => {
    await withTempDir(async (dir) => {
      const projectsDir = join(dir, 'projects');
      const hookPath = await writeClaudeTranscript(projectsDir, 'hooked.jsonl', claudeLines(), PREDATES_MS);
      await writeClaudeTranscript(projectsDir, 'newer.jsonl', claudeLines({ text: 'newer' }), NEWER_MS);

      const result = await resolveBinding(claudeSession('aaaa1111'), {
        liveTenantCount: 3,
        deps: {
          projectsDir,
          readHookSessionMetadata: async () => ({ duenoSessionId: 'aaaa1111', transcriptPath: hookPath, cliSessionId: 'cli-1' }),
        },
      });

      assert.equal(result.path, hookPath);
      assert.equal(result.anchor, 'hook');
      assert.equal(result.cliSessionId, 'cli-1');
    });
  });

  it('ignores hook metadata that does not name this session', async () => {
    await withTempDir(async (dir) => {
      const projectsDir = join(dir, 'projects');
      const otherPath = await writeClaudeTranscript(projectsDir, 'other.jsonl', claudeLines(), LIVE_MS);

      const result = await resolveBinding(claudeSession('aaaa1111'), {
        liveTenantCount: 2,
        deps: {
          projectsDir,
          readHookSessionMetadata: async () => ({ duenoSessionId: 'bbbb2222', transcriptPath: otherPath, cliSessionId: 'cli-2' }),
        },
      });

      assert.equal(result.path, null);
      assert.equal(result.reason, 'ambiguous');
    });
  });

  it('keeps a reused binding when hook metadata naming another session points elsewhere', async () => {
    await withTempDir(async (dir) => {
      const projectsDir = join(dir, 'projects');
      const boundPath = await writeClaudeTranscript(projectsDir, 'bound.jsonl', claudeLines(), LIVE_MS);
      const otherPath = await writeClaudeTranscript(projectsDir, 'other.jsonl', claudeLines(), NEWER_MS);
      const { ino } = await stat(boundPath);

      const result = await resolveBinding(claudeSession('aaaa1111'), {
        previous: { transcript_path: boundPath, anchor: 'cli_session_id', ino, cli_session_id: 'bound' },
        liveTenantCount: 2,
        deps: {
          projectsDir,
          readHookSessionMetadata: async () => ({ duenoSessionId: 'bbbb2222', transcriptPath: otherPath, cliSessionId: 'other' }),
        },
      });

      assert.equal(result.path, boundPath);
      assert.equal(result.reused, true);
    });
  });

  it('binds a codex session by its DUENO_SESSION_ID env marker, ignoring a newer same-cwd rollout', async () => {
    await withTempDir(async (dir) => {
      const codexSessionsDir = join(dir, 'codex');
      const expected = await writeCodexRollout(codexSessionsDir, 'mine', codexRollout({ duenoSessionId: 'cccc3333', sessionId: 'cli-9' }), LIVE_MS);
      await writeCodexRollout(codexSessionsDir, 'theirs', codexRollout({ duenoSessionId: 'dddd4444' }), NEWER_MS);

      const result = await resolveBinding({ id: 'cccc3333', runtime: 'codex', workDir: WORK_DIR, created: CREATED_MS }, {
        liveTenantCount: 2,
        deps: { codexSessionsDir, readHookSessionMetadata: noHook },
      });

      assert.equal(result.path, expected);
      assert.equal(result.anchor, 'env');
      assert.equal(result.cliSessionId, 'cli-9');
    });
  });

  it('does not bind a codex rollout from a different cwd', async () => {
    await withTempDir(async (dir) => {
      const codexSessionsDir = join(dir, 'codex');
      await writeCodexRollout(codexSessionsDir, 'elsewhere', codexRollout({ cwd: '/other/project', duenoSessionId: 'cccc3333' }), LIVE_MS);

      const result = await resolveBinding({ id: 'cccc3333', runtime: 'codex', workDir: WORK_DIR, created: CREATED_MS }, {
        liveTenantCount: 1,
        deps: { codexSessionsDir, readHookSessionMetadata: noHook },
      });

      assert.equal(result.path, null);
      assert.equal(result.reason, 'not_found');
    });
  });

  it('reuses a proven binding without rescanning, and re-anchors when the file is replaced', async () => {
    await withTempDir(async (dir) => {
      const projectsDir = join(dir, 'projects');
      const identityPath = await writeClaudeTranscript(projectsDir, 'first.jsonl', claudeLines({ identity: 'claude:aaaa1111' }), LIVE_MS);
      const { ino } = await stat(identityPath);
      const deps = { projectsDir, readHookSessionMetadata: noHook };

      const reused = await resolveBinding(claudeSession('aaaa1111'), {
        previous: { transcript_path: identityPath, anchor: 'identity', ino, cli_session_id: 'first' },
        liveTenantCount: 2,
        deps,
      });
      assert.equal(reused.path, identityPath);
      assert.equal(reused.reused, true);

      // A different inode at the same path means the transcript was rotated; the old proof is void.
      const rebound = await resolveBinding(claudeSession('aaaa1111'), {
        previous: { transcript_path: identityPath, anchor: 'identity', ino: ino + 1, cli_session_id: 'first' },
        liveTenantCount: 2,
        deps,
      });
      assert.equal(rebound.path, identityPath);
      assert.equal(rebound.anchor, 'identity', 'must re-prove rather than reuse');
      assert.notEqual(rebound.reused, true);
    });
  });

  it('never reuses an unproven legacy binding', async () => {
    await withTempDir(async (dir) => {
      const projectsDir = join(dir, 'projects');
      const stalePath = await writeClaudeTranscript(projectsDir, 'stale.jsonl', claudeLines({ text: 'someone else' }), LIVE_MS);
      await writeClaudeTranscript(projectsDir, 'other.jsonl', claudeLines({ text: 'also someone else' }), NEWER_MS);

      const result = await resolveBinding(claudeSession('aaaa1111'), {
        previous: { transcript_path: stalePath, anchor: 'legacy', offset: 500 },
        liveTenantCount: 2,
        deps: { projectsDir, readHookSessionMetadata: noHook },
      });

      assert.equal(result.path, null);
      assert.equal(result.reason, 'ambiguous');
    });
  });

  it('drops a binding whose file no longer exists', async () => {
    await withTempDir(async (dir) => {
      const projectsDir = join(dir, 'projects');
      const result = await resolveBinding(claudeSession('aaaa1111'), {
        previous: { transcript_path: join(projectsDir, 'gone.jsonl'), anchor: 'identity', ino: 7 },
        liveTenantCount: 1,
        deps: { projectsDir, readHookSessionMetadata: noHook },
      });
      assert.equal(result.path, null);
      assert.equal(result.reason, 'not_found');
    });
  });

  it('matches a bus identity preceded by a JSONL-escaped newline', () => {
    // How the bootstrap prompt is actually stored: the newline is the literal two chars `\n`,
    // so the character before `Your` is the word character `n`.
    const stored = JSON.stringify({ message: { content: 'Thread title\nYour identity: claude:77e575cd\nTeammates:' } });
    assert.ok(stored.includes('\\nYour identity'), 'fixture must carry the escaped newline');
    assert.equal(hasExactBusIdentity(stored, 'claude', '77e575cd'), true);
  });

  it('does not treat a session id as a prefix of a longer id', () => {
    const stored = 'Your identity: claude:77e575cde\n';
    assert.equal(hasExactBusIdentity(stored, 'claude', '77e575cd'), false);
    assert.equal(hasExactBusIdentity(stored, 'claude', '77e575cde'), true);
  });

  it('does not match another agent kind with the same session id', () => {
    const stored = 'Your identity: codex:77e575cd\n';
    assert.equal(hasExactBusIdentity(stored, 'claude', '77e575cd'), false);
    assert.equal(hasExactBusIdentity(stored, 'codex', '77e575cd'), true);
  });

});

describe('binding store', () => {
  it('resets the offset atomically on rebind and refuses to advance a foreign path', async () => {
    await withTempDir(async (stateDir) => {
      const store = buildBindingStore({ stateDir, now: () => 42 });
      await store.load();

      await store.bind('aaaa1111', { path: '/t/a.jsonl', anchor: 'identity', ino: 5, runtime: 'claude', workDir: WORK_DIR });
      await store.advance('aaaa1111', { path: '/t/a.jsonl', offset: 900 });
      assert.equal(store.get('aaaa1111').offset, 900);

      await store.bind('aaaa1111', { path: '/t/b.jsonl', anchor: 'identity', ino: 6, runtime: 'claude', workDir: WORK_DIR });
      const rebound = store.get('aaaa1111');
      assert.equal(rebound.transcript_path, '/t/b.jsonl');
      assert.equal(rebound.offset, 0, 'a rebind must never inherit the previous file offset');

      assert.equal(await store.advance('aaaa1111', { path: '/t/a.jsonl', offset: 1200 }), null);
      assert.equal(store.get('aaaa1111').offset, 0);

      const persisted = JSON.parse(await readFile(store.filePath, 'utf8'));
      assert.equal(persisted.aaaa1111.transcript_path, '/t/b.jsonl');
      assert.equal(persisted.aaaa1111.offset, 0);
    });
  });

  it('imports legacy offsets as unproven bindings that must re-anchor', async () => {
    await withTempDir(async (stateDir) => {
      const store = buildBindingStore({ stateDir, now: () => 42 });
      await store.load();
      const imported = await store.importLegacyOffsets({
        aaaa1111: { transcript_path: '/t/a.jsonl', offset: 700 },
        bbbb2222: { offset: 5 },
      });

      assert.equal(imported, 1);
      assert.equal(store.get('aaaa1111').anchor, 'legacy');
      assert.equal(store.get('aaaa1111').offset, 700);
      assert.equal(store.get('bbbb2222'), null);
    });
  });

  it('does not clobber an existing binding when importing legacy offsets', async () => {
    await withTempDir(async (stateDir) => {
      const store = buildBindingStore({ stateDir, now: () => 42 });
      await store.load();
      await store.bind('aaaa1111', { path: '/t/proven.jsonl', anchor: 'hook', ino: 1 });
      await store.importLegacyOffsets({ aaaa1111: { transcript_path: '/t/legacy.jsonl', offset: 700 } });
      assert.equal(store.get('aaaa1111').transcript_path, '/t/proven.jsonl');
      assert.equal(store.get('aaaa1111').anchor, 'hook');
    });
  });

  it('persists session route identity for post-registry transcript draining', async () => {
    await withTempDir(async (stateDir) => {
      let now = 1000;
      const store = buildBindingStore({ stateDir, now: () => now });
      await store.load();
      const session = {
        id: 'aaaa1111',
        runtime: 'codex',
        workDir: WORK_DIR,
        tmuxSession: 'codex-aaaa1111',
        name: 'Long task',
        created: 900,
        busThreadId: 'thr_1',
        busThreadTitle: 'Shared task',
      };
      await store.bind('aaaa1111', {
        path: '/t/proven.jsonl',
        anchor: 'identity',
        ino: 1,
        runtime: 'codex',
        workDir: WORK_DIR,
        session,
      });

      now = 2000;
      const missing = await store.markMissing('aaaa1111');
      assert.equal(missing.orphaned_at_ms, 2000);
      assert.equal(missing.tmux_session, 'codex-aaaa1111');
      assert.equal(missing.bus_thread_id, 'thr_1');

      now = 3000;
      await store.observe('aaaa1111', session);
      assert.equal(store.get('aaaa1111').orphaned_at_ms, 0);
      assert.equal(store.entries().length, 1);
    });
  });
});
