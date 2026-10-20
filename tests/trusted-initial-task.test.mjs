import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);

test('collab launches keep prompt and profile text out of every agent argv', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cadre-trusted-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  await mkdir(bin);
  const recorder = `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.TEST_ARGV, JSON.stringify({ args: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8') }));\n`;
  for (const kind of ['codex', 'claude', 'pi']) {
    await writeFile(join(bin, kind), recorder);
    await chmod(join(bin, kind), 0o755);
  }
  await writeFile(join(bin, 'pi'), '#!/bin/sh\ncase \"$1\" in --version) echo \"pi 0.80.7\"; exit 0;; --list-models) printf \"provider  model  name\\nxai  grok-4.3  Grok\\n\"; exit 0;; esac\nexec ' + process.execPath + ' ' + join(bin, 'pi-recorder.cjs') + ' \"$@\"\n');
  await writeFile(join(bin, 'pi-recorder.cjs'), recorder.split('\n').slice(1).join('\n'));
  await writeFile(join(bin, 'tmux'), '#!/bin/sh\nif [ "$1" = new-session ]; then for arg do command="$arg"; done; printf "%s" "$command" > "$TEST_COMMAND"; fi\nexit 0\n');
  await chmod(join(bin, 'tmux'), 0o755);
  const harnessUrl = pathToFileURL(resolve('tests/helpers/agent-bus-test-harness.mjs')).href;
  const sessionsUrl = pathToFileURL(resolve('modules/sessions/index.mjs')).href;
  const task = 'Implement this. Quotes: \' " `echo wrong` $(echo wrong)\n' + 'Large task line.\n'.repeat(3000);
  const script = `
    import { readFile, stat, writeFile } from 'node:fs/promises';
    import { execFile } from 'node:child_process';
    import { promisify } from 'node:util';
    process.chdir(${JSON.stringify(root)});
    const { createAgentBusHarness } = await import(${JSON.stringify(harnessUrl)});
    const h = await createAgentBusHarness();
    await h.setProviderPreferences({ claudeEnabled: true, codexEnabled: true, xaiEnabled: true });
    const providers = {};
    const { createAgentSessionsProvider, renderAgentSessionLaunch } = await import(${JSON.stringify(sessionsUrl)});
    const launches = {};
    for (const kind of ['codex', 'claude', 'pi']) {
      h.createResponders[kind] = async (body) => {
        const rooms = h.store.listThreads();
        const room = await h.app.inject({ method: 'GET', url: '/api/agent-bus/threads/' + rooms[0].id, headers: h.authHeaders });
        if (room.statusCode !== 200 || room.json().thread.participants.length !== 3 || room.json().messages.length !== 3) throw new Error('Missing room or startup history before launch');
        if (h.store.getThread(rooms[0].id).deliveries.some((delivery) => delivery.status === 'queued')) throw new Error('Startup was queued for paste');
        // Keep MCP offline; bootstrap's capability forwarding is covered by its route tests.
        providers[kind] = createAgentSessionsProvider(kind);
        const created = await providers[kind].createSession({ ...body, mcpProfile: 'default', mcpServers: undefined, promptProfile: 'research' });
        const command = await readFile(process.env.TEST_COMMAND, 'utf8');
        await promisify(execFile)('bash', ['-c', 'exec < /dev/null; ' + command]);
        const { args, stdin } = JSON.parse(await readFile(process.env.TEST_ARGV, 'utf8'));
        const fileArg = args.find((arg) => arg.startsWith('@'));
        const file = command.match(/ < '([^']+)'/)?.[1] || fileArg?.slice(1) || '';
        launches[kind] = { args, stdin, fileArg, file, body: body.initialPrompt, initialPromptError: created.initialPromptError,
          ...(file ? { prompt: await readFile(file, 'utf8'), mode: (await stat(file)).mode & 511 } : {}) };
        const resume = renderAgentSessionLaunch({ resume: true, backendType: kind,
          sessionBinary: kind, buildOptions: { cliSessionId: 'cli-id', initialPromptFile: file || '/state/prompt.txt' } });
        launches[kind].resume = resume.paneCommand;
      };
    }
    const response = await h.app.inject({ method: 'POST', url: '/api/agent-bus/bootstrap', headers: h.authHeaders,
      payload: { title: 'Trusted launch', workDir: ${JSON.stringify(root)}, initialTask: ${JSON.stringify(task)},
        participants: [{ kind: 'codex', create: true }, { kind: 'claude', create: true }, { kind: 'xai', model: 'grok-4.3', create: true }] } });
    const assert = (await import('node:assert/strict')).default;
    for (const kind of ['codex', 'claude', 'pi']) {
      const options = { workDir: ${JSON.stringify(root)}, provider: kind === 'pi' ? 'xai' : kind,
        model: kind === 'pi' ? 'grok-4.3' : '', mcpProfile: 'default' };
      await assert.rejects(providers[kind].createSession({ ...options, initialPrompt: 'é'.repeat(65536) }), /128 KiB/);
      await assert.rejects(providers[kind].createSession({ ...options, initialPrompt: 'bad\\0task' }), /NUL/);
      await assert.rejects(providers[kind].createSession({ ...options, sessionId: '../escape' }), /Invalid/);
      await assert.rejects(providers[kind].createSession({ ...options, sessionId: 12345678 }), /Invalid/);
      const existingId = h.createdSessions[kind][0].sessionId;
      await assert.rejects(providers[kind].createSession({ ...options, sessionId: existingId }), /duplicate/);
    }
    await writeFile(${JSON.stringify(join(bin, 'tmux'))}, '#!/bin/sh\\nexit 9\\n');
    await assert.rejects(providers.claude.createSession({ workDir: ${JSON.stringify(root)},
      sessionId: 'feedcafe', initialPrompt: 'Must clean up', mcpProfile: 'default' }), /Failed to create session/);
    await assert.rejects(readFile(launches.claude.file.replace(/[^/]+$/, 'claude-feedcafe.txt')), /ENOENT/);
    console.log(JSON.stringify({ status: response.statusCode, body: response.json(), launches, injected: h.injected }));
    await h.cleanup();
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '--eval', script], {
    env: { NODE_TEST_CONTEXT: '1', HOME: root, PATH: `${bin}:/usr/bin:/bin`,
      APP_STATE_STORAGE: 'file', CODEX_SESSIONS_STORAGE: 'file', CLAUDE_SESSIONS_STORAGE: 'file', PI_SESSIONS_STORAGE: 'file',
      PI_BIN: join(bin, 'pi'), PI_MODEL_CATALOG_STORAGE: 'file', PI_MODEL_CATALOG_CACHE_FILE: join(root, 'pi-models.json'),
      CADRE_AGENT_CGROUP_ISOLATION: '0', DATABASE_URL: '', LOG_LEVEL: 'error',
      TEST_ARGV: join(root, 'args.json'), TEST_COMMAND: join(root, 'command.txt'),
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}) },
    maxBuffer: 2 * 1024 * 1024,
  });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.bootstrapOk, true);
  const { resolvePromptProfile } = await import('../modules/integrations/prompt-profile-catalog.mjs');
  const sentences = (text) => text.split(/[.\n]/).map((line) => line.trim()).filter((line) => line.length >= 12);
  const profileSentences = sentences(resolvePromptProfile({ promptProfile: 'research' }).body);
  assert.ok(profileSentences.length > 3);
  for (const kind of ['codex', 'claude', 'pi']) {
    const launch = result.launches[kind];
    const message = result.body.messages[['codex', 'claude', 'pi'].indexOf(kind)];
    assert.equal(message.type, 'startup_prompt');
    assert.equal(launch.body, message.body);
    assert.ok(launch.body.includes(task.trim()));
    assert.match(launch.body, new RegExp(result.body.thread.id));
    assert.ok(launch.body.includes('never find or kill processes by matching their full command line'));
    assert.equal(result.injected[kind].length, 0);
    assert.doesNotMatch(launch.resume, /initial_prompts|Begin working now|prompt\.txt/);
    const forbidden = [...sentences(launch.body), ...profileSentences];
    for (const arg of launch.args) assert.equal(forbidden.find((sentence) => arg.includes(sentence)), undefined, kind + ' argv: ' + arg.slice(0, 80));
  }
  // Claude reads the prompt from stdin and Pi from an @file; both files are private.
  assert.equal(result.launches.claude.stdin, result.launches.claude.body);
  assert.equal(result.launches.claude.prompt, result.launches.claude.body);
  assert.equal(result.launches.pi.args.at(-1), result.launches.pi.fileArg);
  assert.equal(result.launches.pi.prompt, result.launches.pi.body);
  for (const kind of ['claude', 'pi']) assert.equal(result.launches[kind].mode, 0o600);
  // Codex types its prompt into the pane through the command gate, which this provider never registered.
  assert.equal(result.launches.codex.prompt, undefined);
  assert.match(result.launches.codex.initialPromptError, /command gate is not ready/);
  assert.ok(result.body.deliveries.every((delivery) => delivery.resolution.channel === 'launch' && delivery.attempts === 0));
});
