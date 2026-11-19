// A Pi session saved under the retired `antigravity` provider (CLIProxyAPI) still loads: it lists and
// opens with its recorded provider, and Resume refuses it as an unsupported provider without launching.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const coverageEnv = process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {};

it('loads a stored antigravity Pi session as an unavailable provider without throwing', async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'cadre-retired-pi-'));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const binDir = join(tempDir, 'bin');
  await mkdir(binDir);
  // No tmux session exists for it, and any launch attempt is logged.
  await writeFile(join(binDir, 'tmux'), '#!/bin/sh\necho "$1" >> "$TMUX_LOG"\n[ "$1" = has-session ] && exit 1\nexit 0\n');
  await writeFile(join(binDir, 'pi'), '#!/bin/sh\necho 0.84.0\n');
  await chmod(join(binDir, 'tmux'), 0o755);
  await chmod(join(binDir, 'pi'), 0o755);
  const id = 'pi-antigravity-legacy';
  await writeFile(join(tempDir, '.pi_sessions.json'), JSON.stringify([{
    id, tmuxSession: 'pi-antigravity-legacy', source: 'dashboard', workDir: tempDir, created: Date.now(),
    provider: 'antigravity', runtime: 'pi', model: 'gemini-4-argon-high', cliSessionId: 'cli-legacy',
  }]));
  const script = `
    import Fastify from ${JSON.stringify(pathToFileURL(resolve('node_modules/fastify/fastify.js')).href)};
    process.chdir(${JSON.stringify(tempDir)});
    const { getAgentSessionsProvider } = await import(${JSON.stringify(pathToFileURL(resolve('modules/sessions/index.mjs')).href)});
    const app = Fastify();
    await app.register(getAgentSessionsProvider('pi').plugin, { wsManager: { broadcast() {}, onChannel() {}, channels: new Map() } });
    await app.ready();
    const out = {};
    for (const [key, method, url] of [['list', 'GET', '/api/pi/sessions'], ['detail', 'GET', '/api/pi/sessions/${id}'], ['resume', 'POST', '/api/pi/sessions/${id}/resume']]) {
      const response = await app.inject({ method, url });
      out[key] = { statusCode: response.statusCode, body: response.json() };
    }
    await app.close();
    console.log(JSON.stringify(out));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: resolve('.'),
    env: {
      ...coverageEnv, NODE_TEST_CONTEXT: '1', HOME: tempDir, PATH: `${binDir}:/usr/bin:/bin`, TMUX_LOG: join(tempDir, 'tmux.log'),
      LOG_LEVEL: 'error', APP_STATE_STORAGE: 'file', PI_SESSIONS_STORAGE: 'file', DATABASE_URL: '',
      CADRE_AGENT_CGROUP_ISOLATION: '0', CADRE_DISABLE_SIDE_EFFECTS: '1',
    },
  });
  const { list, detail, resume } = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(list.statusCode, 200, JSON.stringify(list.body));
  const listed = list.body.sessions.find((session) => session.id === id);
  assert.equal(listed?.provider, 'antigravity');
  assert.equal(detail.statusCode, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.provider, 'antigravity');
  assert.equal(resume.statusCode, 400, JSON.stringify(resume.body));
  assert.equal(resume.body.code, 'pi_provider_unsupported');
  const calls = await readFile(join(tempDir, 'tmux.log'), 'utf8').catch(() => '');
  assert.ok(!calls.includes('new-session'), calls);
});
