import { execFile } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function modelPresent(env) {
  const home = env.HOME || homedir();
  let hfHome = env.HF_HOME || join(env.XDG_CACHE_HOME || join(home, '.cache'), 'huggingface');
  const wrapper = env.FLEET_WHISPER_BIN;
  if (wrapper) {
    const paths = wrapper.includes('/') ? [wrapper] : (env.PATH || '').split(delimiter).map((dir) => join(dir, wrapper));
    for (const path of paths) {
      try {
        await access(path, constants.X_OK);
        const source = await readFile(path, 'utf8');
        // Read the configured wrapper's literal assignment; never execute shell code.
        const value = source.match(/^\s*export HF_HOME=["']?([^\n"']+)["']?\s*$/m)?.[1];
        if (value) hfHome = value.replace(/\$\{HOME\}|\$HOME\b/g, home);
        break;
      } catch { /* Try the next PATH entry. */ }
    }
  }
  const model = env.FLEET_WHISPER_MODEL || 'base.en';
  const complete = async (path) => {
    try {
      const file = await stat(join(path, 'model.bin'));
      return file.isFile() && file.size > 0;
    } catch { return false; }
  };
  if (await complete(model)) return true;
  const hub = env.HF_HUB_CACHE || join(hfHome, 'hub');
  try {
    const repos = (await readdir(hub)).filter((name) => model.includes('/')
      ? name === `models--${model.replaceAll('/', '--')}`
      : name.startsWith('models--') && name.endsWith(`--faster-whisper-${model}`));
    for (const repo of repos) {
      const snapshots = join(hub, repo, 'snapshots');
      for (const revision of await readdir(snapshots)) {
        if (await complete(join(snapshots, revision))) return true;
      }
    }
  } catch { /* A missing cache is a warning. */ }
  return false;
}

export function createDependencyHealthProbe({
  env = process.env,
  imageGenEnabled = true,
  proxyUrl = 'http://127.0.0.1:8317/',
  timeoutMs = 2000,
  cacheMs = 180_000,
} = {}) {
  let cached;
  let expires = 0;
  return () => {
    if (cached && Date.now() < expires) return cached;
    expires = Date.now() + cacheMs;
    cached = (async () => {
      const data = Object.fromEntries(await Promise.all(['codex', 'claude', 'grok'].map(async (name) => {
        try {
          await run(name, ['--version'], { env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16_384 });
          return [name, { status: 'ok', detail: 'version_ok' }];
        } catch (error) {
          return [name, { status: 'degraded', detail: error.killed ? 'version_timeout' : `version_failed_${error.code || 'unknown'}` }];
        }
      })));
      if (env.FLEET_TRANSCRIBE_ENGINE === 'faster-whisper') {
        const present = await modelPresent(env);
        data.transcriptionModel = { status: present ? 'ok' : 'degraded', detail: present ? 'model_present' : 'model_missing' };
      }
      if (imageGenEnabled) {
        try {
          const response = await fetch(proxyUrl, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
          await response.body?.cancel();
          data.cliProxyApi = { status: 'ok', detail: `http_${response.status}` };
        } catch {
          data.cliProxyApi = { status: 'degraded', detail: 'proxy_unreachable' };
        }
      }
      const warnings = Object.keys(data).filter((name) => data[name].status === 'degraded');
      return { status: warnings.length ? 'degraded' : 'ok', detail: warnings.length ? `degraded dependencies: ${warnings.join(', ')}` : 'dependencies_ready', data };
    })();
    return cached;
  };
}
