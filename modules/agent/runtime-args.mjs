import { resolve } from 'node:path';

const HARNESS_ALIASES = Object.freeze({
  anthropic: 'claude',
  claude: 'claude',
  codex: 'codex',
  deepseek: 'deepseek',
  dsh: 'deepseek',
  pi: 'pi',
});

export const DEFAULT_CODEX_PLUGIN_REMOVALS = Object.freeze(['browser@openai-bundled']);
const CODEX_PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function tomlQuotedKeySegment(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function trustedCodexProjectConfig(workDir = '') {
  const trustedWorkDir = resolve(workDir || '.');
  return `projects.${tomlQuotedKeySegment(trustedWorkDir)}.trust_level="trusted"`;
}

export function normalizeHarnessWorkDir(workDir = '') {
  return resolve(String(workDir || '').trim() || '.');
}

export function normalizeCodexPluginSelection(value) {
  const selection = value === undefined ? {} : value;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw Object.assign(new Error('codexPlugins must be an object'), {
      statusCode: 400, code: 'codex_plugin_selection_invalid',
    });
  }
  const unknown = Object.keys(selection).find((key) => !['add', 'remove'].includes(key));
  if (unknown) {
    throw Object.assign(new Error(`Unknown codexPlugins field: ${unknown}`), {
      statusCode: 400, code: 'codex_plugin_selection_invalid',
    });
  }
  const normalizeList = (field) => {
    const input = selection[field] ?? [];
    if (!Array.isArray(input)) {
      throw Object.assign(new Error(`codexPlugins.${field} must be an array`), {
        statusCode: 400, code: 'codex_plugin_selection_invalid',
      });
    }
    const ids = [...new Set(input)];
    if (ids.some((id) => typeof id !== 'string' || !CODEX_PLUGIN_ID_RE.test(id))) {
      throw Object.assign(new Error(`codexPlugins.${field} must contain plugin@marketplace IDs`), {
        statusCode: 400, code: 'codex_plugin_selection_invalid',
      });
    }
    return Object.freeze(ids);
  };
  return Object.freeze({ add: normalizeList('add'), remove: normalizeList('remove') });
}

export function buildCodexPluginConfigArgs(selection) {
  const normalized = normalizeCodexPluginSelection(selection);
  const states = new Map(DEFAULT_CODEX_PLUGIN_REMOVALS.map((id) => [id, false]));
  for (const id of normalized.remove) states.set(id, false);
  for (const id of normalized.add) states.set(id, true);
  // Nested keys merge into plugins instead of replacing the whole table.
  // These flags are injected before caller args so unrelated later -c values still apply.
  return [...states].flatMap(([id, enabled]) => [
    '-c',
    `plugins.${tomlQuotedKeySegment(id)}.enabled=${enabled}`,
  ]);
}

function assertNoCallerCodexPluginOverrides(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] ?? '').trim();
    if (arg === '--') break;
    let override = '';
    if (arg === '-c' || arg === '--config') override = String(args[index += 1] ?? '').trim();
    else if (arg.startsWith('--config=') || arg.startsWith('-c=')) override = arg.slice(arg.indexOf('=') + 1).trim();
    else if (arg.startsWith('-c') && arg.length > 2) override = arg.slice(2).trim();
    if (/^(?:plugins|"plugins"|'plugins')\s*(?:[.\[]|=|$)/.test(override)
      || /^\[\s*(?:plugins|"plugins"|'plugins')\s*(?:[.\]]|$)/.test(override)) {
      throw Object.assign(new Error('Codex plugin config overrides in args are not allowed; use codexPlugins'), {
        statusCode: 400, code: 'codex_plugin_launch_override_forbidden',
      });
    }
  }
}

export class AgentRuntimeHarness {
  constructor({ id }) {
    this.id = id;
  }

  normalizeWorkDir(workDir = '') {
    return normalizeHarnessWorkDir(workDir);
  }

  buildLaunchArgs() {
    throw new Error(`Harness ${this.id} must implement buildLaunchArgs`);
  }

  buildResumeArgs() {
    throw new Error(`Harness ${this.id} must implement buildResumeArgs`);
  }
}

class CodexRuntimeHarness extends AgentRuntimeHarness {
  constructor() {
    super({ id: 'codex' });
  }

  buildLaunchArgs({ args = [], model = '', thinkingLevel = '', workDir = '', safeRuntime = false, codexPlugins, modelProvider = 'openai' } = {}) {
    assertNoCallerCodexPluginOverrides(args);
    const resolvedWorkDir = this.normalizeWorkDir(workDir);
    // Pin the server-selected OpenAI transport (direct or Headroom), rather
    // than inheriting an unrelated provider from the user's local config.
    const nextArgs = [
      ...(safeRuntime
        ? ['--sandbox', 'read-only', '--ask-for-approval', 'untrusted']
        : ['--dangerously-bypass-approvals-and-sandbox']),
      '--cd',
      resolvedWorkDir,
      '-c',
      `model_provider=${JSON.stringify(modelProvider)}`,
      '-c',
      'features.hooks=true',
      '-c',
      trustedCodexProjectConfig(resolvedWorkDir),
      ...buildCodexPluginConfigArgs(codexPlugins),
    ];
    if (model) nextArgs.push('--model', model);
    if (thinkingLevel) nextArgs.push('-c', `model_reasoning_effort="${thinkingLevel}"`);
    return [...nextArgs, ...args];
  }

  buildResumeArgs({ cliSessionId = '', model = '', thinkingLevel = '', workDir = '', codexPlugins, modelProvider } = {}) {
    const resumeId = String(cliSessionId || '').trim();
    if (!resumeId) throw new Error('Codex resume requires a CLI session id');
    return [
      ...this.buildLaunchArgs({ args: [], model, thinkingLevel, workDir, codexPlugins, modelProvider }),
      'resume',
      resumeId,
    ];
  }
}

class ClaudeRuntimeHarness extends AgentRuntimeHarness {
  constructor() {
    super({ id: 'claude' });
  }

  /**
   * `cliSessionId` fixes the transcript path to `<projects>/<encoded cwd>/<cliSessionId>.jsonl`,
   * which is what lets the Telegram relay bind a session's transcript without guessing.
   * Claude refuses to start on a reused id ("Session ID ... is already in use"), so this must
   * be a fresh uuid per launch and must never be combined with `--resume`.
   */
  buildLaunchArgs({
    args = [], model = '', thinkingLevel = '', workDir = '', cliSessionId = '', settingsPath = '',
    remoteControl = false,
  } = {}) {
    const resolvedWorkDir = this.normalizeWorkDir(workDir);
    const nextArgs = [
      '--dangerously-skip-permissions',
      '--permission-mode',
      'bypassPermissions',
      '--add-dir',
      resolvedWorkDir,
    ];
    // Registers the local session with claude.ai so the Claude app can drive it. Outbound only.
    if (remoteControl) nextArgs.push('--remote-control');
    const hookSettings = String(settingsPath || '').trim();
    if (hookSettings) nextArgs.push('--settings', hookSettings);
    const sessionId = String(cliSessionId || '').trim();
    if (sessionId) nextArgs.push('--session-id', sessionId);
    if (model) nextArgs.push('--model', model);
    if (thinkingLevel) nextArgs.push('--effort', thinkingLevel);
    return [...nextArgs, ...args];
  }

  buildResumeArgs({ cliSessionId = '', model = '', thinkingLevel = '', workDir = '', remoteControl = false } = {}) {
    const resumeId = String(cliSessionId || '').trim();
    if (!resumeId) throw new Error('Claude resume requires a CLI session id');
    return [
      ...this.buildLaunchArgs({ args: [], model, thinkingLevel, workDir, remoteControl }),
      '--resume',
      resumeId,
    ];
  }
}

class PiRuntimeHarness extends AgentRuntimeHarness {
  constructor() {
    super({ id: 'pi' });
  }

  buildLaunchArgs({
    args = [],
    provider = '',
    model = '',
    thinkingLevel = '',
    cliSessionId = '',
  } = {}) {
    const nextArgs = ['--approve'];
    if (provider) nextArgs.push('--provider', provider);
    if (model) nextArgs.push('--model', model);
    const sessionId = String(cliSessionId || '').trim();
    if (sessionId) nextArgs.push('--session-id', sessionId);
    if (thinkingLevel) nextArgs.push('--thinking', thinkingLevel);
    return [...nextArgs, ...args];
  }

  buildResumeArgs({ cliSessionId = '', ...options } = {}) {
    const resumeId = String(cliSessionId || '').trim();
    if (!resumeId) throw new Error('Pi resume requires a CLI session id');
    // Pi's exact --session-id contract opens the matching project session and
    // creates it only when absent. It must not be combined with --resume.
    return this.buildLaunchArgs({ ...options, cliSessionId: resumeId });
  }
}

class DeepSeekRuntimeHarness extends AgentRuntimeHarness {
  constructor() {
    super({ id: 'deepseek' });
  }

  buildLaunchArgs({ args = [], configPath = '' } = {}) {
    const config = String(configPath || '').trim();
    if (!config) throw new Error('DeepSeek Harness ACP launch requires a config path');
    return ['--config', config, ...args];
  }

  buildResumeArgs() {
    throw new Error('DeepSeek Harness ACP sessions cannot be resumed');
  }
}

const HARNESSES = Object.freeze({
  claude: new ClaudeRuntimeHarness(),
  codex: new CodexRuntimeHarness(),
  deepseek: new DeepSeekRuntimeHarness(),
  pi: new PiRuntimeHarness(),
});

export function getAgentRuntimeHarness(runtime = '') {
  const normalized = String(runtime || '').trim().toLowerCase();
  const harnessId = HARNESS_ALIASES[normalized] || normalized;
  const harness = HARNESSES[harnessId];
  if (!harness) throw new Error(`Unsupported agent runtime harness: ${runtime}`);
  return harness;
}

export function buildAgentRuntimeLaunchArgs({ runtime = '', ...options } = {}) {
  const normalizedRuntime = String(runtime || '').trim().toLowerCase();
  return getAgentRuntimeHarness(normalizedRuntime).buildLaunchArgs(options);
}

export function buildAgentRuntimeResumeArgs({ runtime = '', ...options } = {}) {
  const normalizedRuntime = String(runtime || '').trim().toLowerCase();
  return getAgentRuntimeHarness(normalizedRuntime).buildResumeArgs(options);
}

export function buildCodexLaunchArgs(options = {}) {
  return buildAgentRuntimeLaunchArgs({ runtime: 'codex', ...options });
}

export function buildClaudeLaunchArgs(options = {}) {
  return buildAgentRuntimeLaunchArgs({ runtime: 'claude', ...options });
}

export function buildPiLaunchArgs(options = {}) {
  return buildAgentRuntimeLaunchArgs({ runtime: 'pi', ...options });
}

export function buildDeepSeekLaunchArgs(options = {}) {
  return buildAgentRuntimeLaunchArgs({ runtime: 'deepseek', ...options });
}

export function buildCodexResumeArgs(options = {}) {
  return buildAgentRuntimeResumeArgs({ runtime: 'codex', ...options });
}

export function buildClaudeResumeArgs(options = {}) {
  return buildAgentRuntimeResumeArgs({ runtime: 'claude', ...options });
}

export function buildPiResumeArgs(options = {}) {
  return buildAgentRuntimeResumeArgs({ runtime: 'pi', ...options });
}
