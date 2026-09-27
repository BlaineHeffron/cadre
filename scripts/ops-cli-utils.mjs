import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function normalizeText(value) {
  return String(value || '').trim();
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

export function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const normalized = normalizeText(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function deriveAppBaseUrl({
  explicitBaseUrl = '',
  env = process.env,
  envKey = '',
} = {}) {
  const explicit = normalizeText(explicitBaseUrl || (envKey ? env[envKey] : ''));
  if (explicit) return explicit;

  const port = Number(env.PORT || 8443) || 8443;
  const tlsEnabled = normalizeBoolean(env.TLS_ENABLED, true);
  const protocol = tlsEnabled ? 'https' : 'http';
  const rawHost = normalizeText(env.HOST || '127.0.0.1') || '127.0.0.1';
  const hostname = rawHost === '0.0.0.0' ? '127.0.0.1' : rawHost;
  return `${protocol}://${hostname}:${port}`;
}

export function deriveAuthToken({
  explicitToken = '',
  env = process.env,
  envKeys = [],
} = {}) {
  const explicit = normalizeText(explicitToken);
  if (explicit) return explicit;
  for (const key of envKeys) {
    const value = normalizeText(env[key]);
    if (value) return value;
  }
  return '';
}

export async function readJsonIfExists(path, fallback = null) {
  if (!normalizeText(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJsonReport(path, value) {
  if (!normalizeText(path)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function postJson(url, payload, {
  fetchImpl = fetch,
  headers = {},
} = {}) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(payload),
  });

  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    body: responseBody,
  };
}
