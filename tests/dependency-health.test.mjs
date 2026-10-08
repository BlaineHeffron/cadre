import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createDependencyHealthProbe } from '../modules/ops/dependency-health.mjs';
import { summarizeReadiness } from '../modules/ops/health-controls.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cadre-dependencies-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { PATH: dir, HOME: dir };
  const binary = (name, body) => writeFile(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  for (const name of ['codex', 'claude', 'grok']) await binary(name, '[ "$1" = "--version" ] || exit 9\necho fixture-version');
  const probe = (options = {}) => createDependencyHealthProbe({ env, imageGenEnabled: false, cacheMs: 0, ...options });
  return { dir, env, binary, probe };
}

it('checks fake CLIs on the service PATH and caches concurrent/repeated probes', async (t) => {
  const { dir, binary, probe } = await fixture(t);
  await binary('codex', `echo checked >> '${join(dir, 'calls')}'`);
  const get = probe({ cacheMs: 180_000 });
  const [first, concurrent] = await Promise.all([get(), get()]);
  assert.equal(first.status, 'ok');
  assert.equal(first, concurrent);
  await rm(join(dir, 'codex'));
  assert.equal(await get(), first);
  assert.equal(await readFile(join(dir, 'calls'), 'utf8'), 'checked\n');
  assert.equal((await probe()()).data.codex.status, 'degraded');
});

it('reports missing, broken and timed-out CLIs as warnings without blocking readiness', async (t) => {
  const { dir, binary, probe } = await fixture(t);
  await rm(join(dir, 'codex'));
  await binary('claude', 'exit 7');
  await binary('grok', 'while :; do :; done');
  const dependencies = await probe({ timeoutMs: 100 })();
  assert.equal(dependencies.data.codex.detail, 'version_failed_ENOENT');
  assert.equal(dependencies.data.claude.detail, 'version_failed_7');
  assert.equal(dependencies.data.grok.detail, 'version_timeout');
  assert.match(dependencies.detail, /codex, claude, grok/);
  const readiness = summarizeReadiness({ storage: { status: 'ok' }, dependencies });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.status, 'degraded');
  assert.equal(summarizeReadiness({ storage: { status: 'failed' }, dependencies }).ready, false);
});

it('expires the cached result', async (t) => {
  const { dir, probe } = await fixture(t);
  const get = probe({ cacheMs: 15 });
  assert.equal((await get()).data.codex.status, 'ok');
  await rm(join(dir, 'codex'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await get()).data.codex.status, 'degraded');
});

it('finds cached models under HF_HOME, including non-Systran repos and broken symlinks', async (t) => {
  const { dir, env, probe } = await fixture(t);
  Object.assign(env, { FLEET_TRANSCRIBE_ENGINE: 'faster-whisper', FLEET_WHISPER_MODEL: 'large-v3-turbo', HF_HOME: join(dir, 'hf') });
  const snapshot = join(env.HF_HOME, 'hub/models--mobiuslabsgmbh--faster-whisper-large-v3-turbo/snapshots/revision');
  await mkdir(snapshot, { recursive: true });
  assert.equal((await probe()()).data.transcriptionModel.status, 'degraded');
  await writeFile(join(snapshot, 'model.bin'), 'fixture weights');
  assert.equal((await probe()()).data.transcriptionModel.status, 'ok');
  await rm(join(snapshot, 'model.bin'));
  await symlink(join(dir, 'deleted-blob'), join(snapshot, 'model.bin'));
  assert.equal((await probe()()).data.transcriptionModel.status, 'degraded');
  env.FLEET_WHISPER_MODEL = 'mobiuslabsgmbh/faster-whisper-large-v3-turbo';
  await rm(join(snapshot, 'model.bin'));
  await writeFile(join(snapshot, 'model.bin'), 'weights');
  assert.equal((await probe()()).data.transcriptionModel.status, 'ok');
});

it('uses configured wrapper HF_HOME ahead of env, or a local model path', async (t) => {
  const { dir, env, binary, probe } = await fixture(t);
  Object.assign(env, { FLEET_TRANSCRIBE_ENGINE: 'faster-whisper', HF_HOME: join(dir, 'wrong'), FLEET_WHISPER_BIN: 'wrapper' });
  await binary('wrapper', 'export HF_HOME="$HOME/models"\nexit 99');
  const snapshot = join(dir, 'models/hub/models--Systran--faster-whisper-base.en/snapshots/revision');
  await mkdir(snapshot, { recursive: true });
  await writeFile(join(snapshot, 'model.bin'), 'weights');
  assert.equal((await probe()()).data.transcriptionModel.status, 'ok');
  env.FLEET_WHISPER_MODEL = snapshot;
  delete env.FLEET_WHISPER_BIN;
  assert.equal((await probe()()).data.transcriptionModel.status, 'ok');
  delete env.FLEET_WHISPER_MODEL;
  delete env.HF_HOME;
  const defaultSnapshot = join(dir, '.cache/huggingface/hub/models--Systran--faster-whisper-base.en/snapshots/revision');
  await mkdir(defaultSnapshot, { recursive: true });
  await writeFile(join(defaultSnapshot, 'model.bin'), 'weights');
  assert.equal((await probe()()).data.transcriptionModel.status, 'ok');
  env.FLEET_TRANSCRIBE_ENGINE = 'whisper-cpp';
  assert.equal((await probe()()).data.transcriptionModel, undefined);
});

it('accepts any proxy HTTP response, warns on failure/timeout, and skips when disabled', async (t) => {
  const { probe } = await fixture(t);
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.url !== '/hang') { res.writeHead(401); res.end('no key needed for readiness'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const proxyUrl = `http://127.0.0.1:${server.address().port}/`;
  const get = probe({ imageGenEnabled: true, proxyUrl });
  assert.deepEqual((await get()).data.cliProxyApi, { status: 'ok', detail: 'http_401' });
  assert.equal((await probe({ imageGenEnabled: false, proxyUrl })()).data.cliProxyApi, undefined);
  assert.equal(requests, 1);
  assert.equal((await probe({ imageGenEnabled: true, proxyUrl: `${proxyUrl}hang`, timeoutMs: 100 })()).data.cliProxyApi.status, 'degraded');
  await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  assert.equal((await get()).data.cliProxyApi.status, 'degraded');
});
