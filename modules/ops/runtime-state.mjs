import { resolve } from 'node:path';
import { readEnv } from '../platform/cadre-env.mjs';

export function runtimeStateDir(env = process.env) {
  return resolve(readEnv('DM_STATE_DIR', env) || '.dueno/state');
}

export function runtimeStatePath(name, env = process.env) {
  return resolve(runtimeStateDir(env), name);
}

export function legacyRootStatePath(name) {
  return resolve(`.${name}`);
}
