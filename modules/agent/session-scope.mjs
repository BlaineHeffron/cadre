import { exec as defaultExec } from '../../lib/exec.mjs';
import { shellQuote } from '../platform/shell-quote.mjs';
import { readEnv } from '../platform/cadre-env.mjs';

const UNIT_RE = /^dueno-agent-(?:codex|claude|pi)-[a-z0-9][a-z0-9-]{0,63}\.scope$/u;
const MEMORY_LIMIT_RE = /^\d+(?:[KMGTPE])?$/iu;
const TASK_LIMIT_RE = /^\d+$/u;

function enabled(value, platform) {
  if (platform !== 'linux') return false;
  return !['0', 'false', 'off', 'disabled'].includes(String(value ?? '1').trim().toLowerCase());
}

function boundedSetting(value, fallback, pattern) {
  const normalized = String(value || fallback).trim();
  return pattern.test(normalized) ? normalized : fallback;
}

export function agentScopeUnitName(kind, sessionId) {
  const provider = String(kind || '').trim().toLowerCase();
  const id = String(sessionId || '').trim().toLowerCase();
  if (!['codex', 'claude', 'pi'].includes(provider) || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)) return '';
  return `dueno-agent-${provider}-${id}.scope`;
}

export function isAgentScopeUnit(unit) {
  return UNIT_RE.test(String(unit || '').trim());
}

export function buildAgentScopeLaunch(command, {
  kind,
  sessionId,
  env = process.env,
  platform = process.platform,
} = {}) {
  const unit = agentScopeUnitName(kind, sessionId);
  if (!unit || !enabled(readEnv('DUENO_AGENT_CGROUP_ISOLATION', env), platform)) {
    return { command, enabled: false, unit: '', slice: '' };
  }

  const tasksMax = boundedSetting(readEnv('DUENO_AGENT_SCOPE_TASKS_MAX', env), '1024', TASK_LIMIT_RE);
  const memoryHigh = boundedSetting(readEnv('DUENO_AGENT_SCOPE_MEMORY_HIGH', env), '4G', MEMORY_LIMIT_RE);
  const memoryMax = boundedSetting(readEnv('DUENO_AGENT_SCOPE_MEMORY_MAX', env), '8G', MEMORY_LIMIT_RE);
  const args = [
    'exec',
    'systemd-run',
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    `--unit=${unit.slice(0, -'.scope'.length)}`,
    '--slice=dueno-agents.slice',
    `--property=TasksMax=${tasksMax}`,
    `--property=MemoryHigh=${memoryHigh}`,
    `--property=MemoryMax=${memoryMax}`,
    '--property=TimeoutStopSec=3s',
    '--property=KillMode=control-group',
    'bash',
    '-lc',
    shellQuote(command),
  ];
  return {
    command: args.join(' '),
    enabled: true,
    unit,
    slice: 'dueno-agents.slice',
  };
}

function parseShow(stdout = '') {
  return Object.fromEntries(String(stdout || '').split('\n').flatMap((line) => {
    const separator = line.indexOf('=');
    return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
  }));
}

async function scopeState(unit, execImpl) {
  const result = await execImpl('systemctl', [
    '--user',
    'show',
    unit,
    '--property=LoadState',
    '--property=ActiveState',
    '--property=SubState',
    '--property=ControlGroup',
  ]);
  const state = parseShow(result.stdout);
  return { ...result, ...state };
}

function scopeGone(state = {}) {
  return state.LoadState === 'not-found'
    || ['inactive', 'failed'].includes(state.ActiveState);
}

export async function stopAgentScope(unit, { execImpl = defaultExec } = {}) {
  if (!isAgentScopeUnit(unit)) {
    return { ok: false, reason: 'invalid_agent_scope', residual: [{ type: 'cgroup', id: String(unit || '') }] };
  }

  const before = await scopeState(unit, execImpl);
  if (!before.LoadState) {
    return {
      ok: false,
      reason: 'agent_scope_lookup_failed',
      error: before.stderr || 'systemctl returned no scope state',
      residual: [{ type: 'cgroup', id: unit }],
    };
  }
  if (scopeGone(before)) return { ok: true, status: 'already_gone', residual: [] };

  const stopped = await execImpl('systemctl', ['--user', 'stop', unit], { timeout: 10000 });
  const after = await scopeState(unit, execImpl);
  if (!after.LoadState) {
    return {
      ok: false,
      reason: 'agent_scope_lookup_failed',
      error: after.stderr || stopped.stderr || 'systemctl returned no scope state after stop',
      residual: [{ type: 'cgroup', id: unit }],
    };
  }
  if (scopeGone(after)) return { ok: true, status: 'terminated', residual: [] };

  return {
    ok: false,
    reason: 'agent_scope_survived',
    error: stopped.stderr || `Scope remained ${after.ActiveState || 'active'} (${after.SubState || 'unknown'})`,
    residual: [{ type: 'cgroup', id: unit, path: after.ControlGroup || '' }],
  };
}
