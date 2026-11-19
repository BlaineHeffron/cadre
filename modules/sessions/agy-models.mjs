// Google Antigravity CLI (`agy`): binary discovery and model catalog.
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { exec } from '../../lib/exec.mjs';

export const AGY_DEFAULT_MODEL = 'gemini-4-neon-medium';

const variants = (base, label, efforts) => efforts.map((effort) => ({
  id: `${base}-${effort}`, label: `${label} (${effort === 'xhigh' ? 'XHigh' : effort[0].toUpperCase() + effort.slice(1)})`,
}));

// `agy models` as of agy 1.5.12; the effort is part of the id.
export const AGY_FALLBACK_MODELS = Object.freeze([
  ...variants('gemini-4-neon', 'Gemini 4 Neon', ['medium', 'low', 'high', 'xhigh']),
  ...variants('gemini-4-argon', 'Gemini 4 Argon', ['medium', 'low', 'high']),
  ...variants('gemini-4-hydrogen', 'Gemini 4 Hydrogen', ['medium', 'low', 'high', 'xhigh']),
  { id: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)' },
  { id: 'gemini-pro-orchestrator-g1-pro', label: 'Orchestrator (Argon)' },
  ...variants('gemini-3.8-flash', 'Gemini 3.8 Flash', ['medium', 'low', 'high']),
  ...variants('claude-opus-5-5', 'Claude Opus 5.5', ['medium', 'low', 'high']),
  ...variants('claude-sonnet-5-5', 'Claude Sonnet 5.5', ['medium', 'low', 'high']),
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
]);
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;
let cached = null;

function executable(path) {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

/** `AGY_BIN`, then PATH, then ~/.local/bin (the installer's target, often not on a service PATH). */
export function findAgyBinarySync(env = process.env) {
  const explicit = String(env.AGY_BIN || '').trim();
  if (explicit.includes('/')) return executable(explicit) ? explicit : '';
  const name = explicit || 'agy';
  const dirs = [...String(env.PATH || '').split(delimiter).filter(Boolean), join(env.HOME || homedir(), '.local', 'bin')];
  return dirs.map((dir) => join(dir, name)).find(executable) || '';
}

/** Parses `agy models` lines of `id<TAB>label`; other lines (e.g. "Fetching ...") are skipped. */
export function parseAgyModels(output = '') {
  const models = String(output || '').split(/\r?\n/)
    .map((line) => line.trim().split('\t'))
    .filter(([id, label]) => label && /^[a-z0-9][a-z0-9.-]*$/.test(id))
    .map(([id, label]) => ({ id, label: label.trim() }));
  return [...new Map(models.map((entry) => [entry.id, entry])).values()];
}

/** `agy models` when the binary answers, otherwise the static list above. */
export async function listAgyModels({ binary = findAgyBinarySync(), execImpl = exec, now = Date.now() } = {}) {
  if (cached && cached.binary === binary && now - cached.at < MODEL_TTL_MS) return cached.models;
  let models = [];
  if (binary) {
    const { code, stdout } = await execImpl(binary, ['models'], { timeout: 15000 }).catch(() => ({ code: 1 }));
    if (code === 0) models = parseAgyModels(stdout);
  }
  if (models.length === 0) return [...AGY_FALLBACK_MODELS];
  cached = { binary, at: now, models };
  return models;
}

export async function assertAgyModel(model = '', options = {}) {
  const requested = String(model || '').trim() || AGY_DEFAULT_MODEL;
  const models = await listAgyModels(options);
  if (models.some((entry) => entry.id === requested)) return requested;
  throw Object.assign(
    new Error(`Unsupported Antigravity model "${requested}". Allowed models: ${models.map((entry) => entry.id).join(', ')}`),
    { statusCode: 400, code: 'agy_model_unsupported' },
  );
}

export function isKnownAgyModel(model = '') {
  return AGY_FALLBACK_MODELS.some((entry) => entry.id === String(model || '').trim());
}
