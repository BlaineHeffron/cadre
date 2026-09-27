import { readEnv } from './cadre-env.mjs';

export function envEnabled(env, name) {
  return ['1', 'true', 'yes', 'on'].includes(String(readEnv(name, env) || '').trim().toLowerCase());
}

export function shouldSuppressSideEffectLoops({ env = process.env, port } = {}) {
  if (envEnabled(env, 'DUENO_ALLOW_SIDE_EFFECTS')) return false;
  if (envEnabled(env, 'DUENO_DISABLE_SIDE_EFFECTS') || envEnabled(env, 'DUENO_TEST_SERVER')) return true;
  return String(env.PORT || port || '') !== '4310';
}

export function shouldEnableTelegramBridge({ env = process.env, sideEffectLoopsSuppressed } = {}) {
  return !sideEffectLoopsSuppressed && env.TELEGRAM_BRIDGE !== '0';
}

export function shouldStartAgentBusMcpHttp({ sideEffectLoopsSuppressed } = {}) {
  return sideEffectLoopsSuppressed === false;
}
