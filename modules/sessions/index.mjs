import { removeGithubAgentScratch } from '../integrations/github-agent-scratch.mjs';
import { exec } from '../../lib/exec.mjs';
import { config as appConfig } from '../../config.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stripCodexIndent } from '../session-state/providers/patterns.mjs';
import { normalizeProviderPane } from '../session-state/providers/pane-view.mjs';
import { assertValidCodexModel } from './codex-models.mjs';
import { assertValidClaudeModel, normalizeClaudeProvider } from './claude-models.mjs';
import { sendTmuxText, sleep } from '../platform/tmux-input.mjs';
import { notifyPush } from '../platform/push.mjs';
import { saveImageToWorkspace, buildAgentImagePrompt, buildImageAttachmentResult } from './image-handoff.mjs';
import { AttachmentStore } from '../agent/attachment-store.mjs';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { recordRuntimeHookEvent, registerHookSessionRegistry, removeSessionHookFiles } from '../agent/hook-events.mjs';
import { readHookDerivedState, readHookSessionMetadata } from '../session-state/providers/hook.mjs';
import { canonicalSessionStateId, projectCompatibility } from '../session-state/contract.mjs';
import { isFinishedWorkEdge, nextRememberedStatus } from '../session-state/attention-edge.mjs';
import {
  PANE_FRESH_MS,
  PANE_OBSERVER_CADENCE_MS,
  PROCESS_LIFECYCLE_FRESH_MS,
  sessionStateTracker,
} from '../session-state/tracker.mjs';
import { observeClaudePane } from '../session-state/providers/claude.mjs';
import { observeCodexPane } from '../session-state/providers/codex.mjs';
import { observePiPane } from '../session-state/providers/pi.mjs';
import { observeTranscriptFile } from '../session-state/providers/transcript.mjs';
import { observeProcessLiveness } from '../session-state/providers/process.mjs';
import { latestFreshPaneExecution, nextTranscriptIdleSince, shouldAutoCloseSession } from './auto-close.mjs';
import {
  extractClaudeConversationText,
  extractCodexConversationText,
  readConversationPage,
} from '../telegram/transcript.mjs';
import { resolveBinding } from '../telegram/binding.mjs';
import { createTmuxCommandExecutor, sessionCommandGate } from '../session-state/command-gate.mjs';
import {
  buildAgentRuntimeLaunchArgs,
  buildClaudeLaunchArgs,
  normalizeCodexPluginSelection,
} from '../agent/runtime-args.mjs';
import { buildLaunchEnvPrefix } from '../agent/launch-env.mjs';
import { prepareHeadroomLaunch } from '../agent/headroom.mjs';
import { readLaunchLogTail, waitForStartupPane } from '../agent/startup-input.mjs';
import { detectLaunchFailure } from '../agent/launch-failure.mjs';
import { normalizeSessionWorkDir } from './workdir.mjs';
import { seedClaudeWorkspaceTrust } from '../platform/mcp-seed.mjs';
import { resolveMcpCapabilities } from '../integrations/mcp-capability-resolver.mjs';
import { buildMcpCapabilityCatalog } from '../integrations/mcp-server-catalog.mjs';
import {
  cleanupMcpCapabilityLaunch,
  prepareMcpCapabilityLaunch,
  sanitizedMcpSnapshot,
} from '../integrations/mcp-launch-preflight.mjs';
import { resolvePromptProfile } from '../integrations/prompt-profile-catalog.mjs';
import {
  buildPromptLaunchArgs,
  cleanupPromptProfileLaunch,
  preparePromptProfileLaunch,
  promptProfilePath,
  sanitizedPromptSnapshot,
} from '../integrations/prompt-profile-launch.mjs';
import {
  composeLaunchSourcePrompt,
  expandSkillTokens,
  resolveLaunchSkills,
  sanitizedSkillSnapshot,
  skillDeliveryResolution,
} from '../integrations/launch-skills.mjs';
import { buildAttachCommand, resolveTmuxSocketPath } from '../platform/tmux.mjs';
import { legacyRootStatePath, runtimeStatePath } from '../ops/runtime-state.mjs';
import { notifyAgentSessionDeleted } from '../agent/session-delete-events.mjs';
import {
  findProcessIdentitiesByEnvironment,
  mergeProcessIdentities,
  snapshotProcessTrees,
  terminateVerifiedProcesses,
} from '../agent/process-termination.mjs';
import {
  agentScopeUnitName,
  buildAgentScopeLaunch,
  stopAgentScope,
} from '../agent/session-scope.mjs';
import { recordSessionDeliveryAudit } from './delivery-audit.mjs';
import { createKeyedSingleFlight } from './keyed-single-flight.mjs';
import { queueControlEvent } from '../ops/control-events.mjs';
import { removeAgentSessionWorktree } from '../fleet/git-worktree.mjs';
import {
  coordinatorOwnerMetadata,
  coordinatorSessionMetadata,
  loopRegistrationSessionMetadata,
  normalizeCredentialCoordinatorPolicy,
  operatorLoopRegistrationPolicy,
  operatorResumeLoopRegistrationPolicy,
  sessionControlProvenance,
  storedCoordinatorPolicy,
  stripReservedCoordinatorMetadata,
} from '../agent-bus/coordinator-policy.mjs';
import {
  classifyProcessTrees,
  classifyTmuxSession as classifyTmuxSessionByProcessTree,
  externalSessionIdFromTmuxName,
  isRustManagedTmuxSessionName,
  rustManagedSessionFields,
  tmuxNameFromExternalSessionId,
} from '../agent/tmux-classifier.mjs';
import { shellQuote } from '../platform/shell-quote.mjs';
import { nonoStatePaths, prepareNonoLaunch, resolveSandbox } from '../agent/nono-launch.mjs';
import { remoteMcpServer } from '../integrations/mcp-remote-servers.mjs';
import { permissionAuthorityForRequest } from '../platform/auth.mjs';
import { assertPiProviderModel, normalizePiProvider } from './pi-model-catalog.mjs';
import { hasResearchWorkbenchLaunchProfile } from '../integrations/research-profile.mjs';
import { cadreEnvName } from '../platform/cadre-env.mjs';

const LAUNCH_LOG_DIR = runtimeStatePath('agent_launch_logs');
const LAUNCH_VERIFY_INTERVAL_MS = 250;
const DISCOVERY_CACHE_TTL_MS = 10000;
const STATE_CACHE_TTL_MS = 5000;
const LIST_STATE_CAPTURE_LINES = 120;
export const HOOK_STATE_TTL_MS = 90000;
const PROMPT_READY_SNIPPET_MAX = 160;
const TOOL_BUSY_STATUSES = new Set(['working', 'thinking', 'awaiting_response']);
const BLOCKING_INTERACTION_KINDS = new Set([
  'permission', 'confirmation', 'selection', 'trust', 'guardrail', 'update', 'unknown_blocking',
]);

export async function validatePiCliContract(binary, {
  execImpl = exec,
  readFileImpl = readFile,
  nodeVersion = process.version,
} = {}) {
  const sourcePrefix = await readFileImpl(binary, 'utf8')
    .then((source) => String(source || '').slice(0, 200))
    .catch(() => '');
  const shebang = sourcePrefix.split(/\r?\n/, 1)[0];
  if (/^#!.*\bnode\b/.test(shebang)) {
    const nodeMatch = String(nodeVersion || '').match(/v?(\d+)\.(\d+)\.(\d+)/);
    const nodeCompatible = nodeMatch
      && compareSemanticVersions(nodeMatch.slice(1, 4), [22, 19, 0]) >= 0;
    if (!nodeCompatible) {
      const error = new Error(`Pi CLI 0.80.7 requires Node.js 22.19.0 or newer${nodeVersion ? `; found ${nodeVersion}` : ''}`);
      error.statusCode = 503;
      error.code = 'pi_node_version_incompatible';
      throw error;
    }
  }

  const result = await execImpl(binary, ['--version'], { timeout: 5000 });
  const rawVersion = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const match = rawVersion.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  const compatible = result.code === 0 && match && compareSemanticVersions(match.slice(1, 4), [0, 80, 7]) >= 0;
  if (!compatible) {
    const error = new Error(`Pi CLI 0.80.7 or newer is required${rawVersion ? `; found ${rawVersion}` : ''}`);
    error.statusCode = 503;
    error.code = 'pi_version_incompatible';
    throw error;
  }
}

export { stripCodexIndent };

export function isTmuxMissingSessionError(stderr = '') {
  return /can't find (?:session|pane)|no such (?:session|pane)|(?:session|pane) not found|error connecting to .+\(No such file or directory\)|no server running on \S+/i.test(String(stderr || ''));
}

export function isTmuxMissingNamedSessionError(stderr = '') {
  return /can't find session|no such session|session not found/i.test(String(stderr || ''));
}

export { canonicalSessionStateId };

export function reconcileSessionMaps(live, baseline, discovered) {
  const next = new Map(discovered);
  for (const id of baseline.keys()) {
    if (!live.has(id)) next.delete(id);
  }
  for (const [id, meta] of live) {
    if (!baseline.has(id) || live.get(id) !== baseline.get(id)) next.set(id, meta);
  }
  return next;
}

function projectCanonicalState(snapshot) {
  return {
    ...projectCompatibility(snapshot),
    sessionId: snapshot.sessionId,
    updatedAt: snapshot.updatedAt,
    lifecycle: snapshot.lifecycle,
    execution: snapshot.execution,
    interaction: snapshot.interaction,
    runtime: snapshot.runtime,
    degradedReasons: snapshot.degradedReasons,
    pendingResponse: snapshot.status === 'awaiting_response',
    sentAt: null,
  };
}

class SessionRequestError extends Error {
  constructor(message, statusCode = 400, code = null) {
    super(message);
    this.name = 'SessionRequestError';
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

const PROVIDER_CONFIGS = {
  // Codex hooks are project-level (.codex/hooks.json) only — no per-session
  // --settings equivalent. Installing there would collide for multiple sessions
  // in one worktree. Codex stays scrape + transcript until a per-session path exists.
  codex: {
    id: 'codex',
    displayName: 'Codex',
    tmuxPrefix: 'codex',
    defaultProvider: 'openai',
    defaultRuntime: 'codex',
    stateFile: 'codex_sessions.json',
    storageEnv: 'CODEX_SESSIONS_STORAGE',
    stripContent: stripCodexIndent,
    startupDelayMs: 180,
    initialPromptDelayMs: 350,
    bufferPrefix: 'dueno-codex',
    assertModel: assertValidCodexModel,
    normalizeRuntime(provider = '', runtime = '') {
      const normalizedRuntime = String(runtime || '').trim().toLowerCase();
      const normalizedProvider = String(provider || '').trim().toLowerCase();
      if ((normalizedRuntime && normalizedRuntime !== 'codex') || (normalizedProvider && normalizedProvider !== 'codex')) {
        const error = new Error('provider must be codex');
        error.statusCode = 400;
        throw error;
      }
      return { provider: 'codex', runtime: 'codex', launchRuntime: 'codex' };
    },
    buildArgs({ args = [], model = '', thinkingLevel = '', workDir = '', runtime = 'codex', mcpLaunch = {}, promptLaunch = {}, researchSafeRuntime = false, codexPlugins, modelProvider } = {}) {
      return [
        ...buildAgentRuntimeLaunchArgs({ runtime, args, model, thinkingLevel, workDir, safeRuntime: researchSafeRuntime, codexPlugins, modelProvider }),
        ...(mcpLaunch.codexArgs || []),
        ...buildPromptLaunchArgs({ runtime: 'codex', promptLaunch }),
      ];
    },
    buildResumeArgs({ cliSessionId = '', model = '', thinkingLevel = '', workDir = '', runtime = 'codex', mcpLaunch = {}, promptLaunch = {}, researchSafeRuntime = false, codexPlugins, modelProvider } = {}) {
      const resumeId = String(cliSessionId || '').trim();
      if (!resumeId) throw new Error('Codex resume requires a CLI session id');
      return [
        ...buildAgentRuntimeLaunchArgs({ runtime, args: [], model, thinkingLevel, workDir, safeRuntime: researchSafeRuntime, codexPlugins, modelProvider }),
        ...(mcpLaunch.codexArgs || []),
        ...buildPromptLaunchArgs({ runtime: 'codex', promptLaunch }),
        'resume',
        resumeId,
      ];
    },
    shellPrefix(sessionId, provider) {
      return buildLaunchEnvPrefix(sessionId, provider);
    },
    shellCommand({ sessionBinary, allArgs, launchLogPath, sessionId, provider, mcpLaunch = {}, initialPromptFile = '' }) {
      const baseCommand = `${shellQuote(sessionBinary)} ${allArgs.map(shellQuote).join(' ')}${initialPromptFile ? ` -- "$(< ${shellQuote(initialPromptFile)})"` : ''}`;
      const command = launchLogPath
        ? `${baseCommand} 2> >(tee -a ${shellQuote(launchLogPath)} >&2)`
        : baseCommand;
      const credentialPrefix = mcpLaunch.credentialPath && mcpLaunch.credentialEnvVar
        ? `export ${mcpLaunch.credentialEnvVar}="$(< ${shellQuote(mcpLaunch.credentialPath)})"; export ${cadreEnvName(mcpLaunch.credentialEnvVar)}="$${mcpLaunch.credentialEnvVar}"`
        : '';
      const forwardedEnvPrefix = mcpLaunch.envPath
        ? `while IFS= read -r -d '' entry; do export "$entry"; done < ${shellQuote(mcpLaunch.envPath)}`
        : '';
      const envPrefix = [buildLaunchEnvPrefix(sessionId, provider), credentialPrefix, forwardedEnvPrefix].filter(Boolean).join('; ');
      return envPrefix ? `${envPrefix}; ${command}` : command;
    },
  },
  claude: {
    id: 'claude',
    displayName: 'Claude',
    tmuxPrefix: 'claude',
    // Claude accepts `--session-id`, so we choose the transcript filename at launch instead of
    // discovering it later. Codex has no equivalent flag and is identified by its originator stamp.
    assignsCliSessionId: true,
    defaultProvider: 'anthropic',
    defaultRuntime: 'claude',
    stateFile: 'claude_sessions.json',
    storageEnv: 'CLAUDE_SESSIONS_STORAGE',
    stripContent: (text = '') => String(text || ''),
    startupDelayMs: 300,
    initialPromptDelayMs: 500,
    bufferPrefix: 'dueno-claude',
    assertModel: assertValidClaudeModel,
    normalizeRuntime(provider = '', runtime = '') {
      const normalizedProvider = normalizeClaudeProvider(provider);
      const normalizedRuntime = String(runtime || '').trim().toLowerCase();
      if (normalizedProvider !== 'anthropic' || (normalizedRuntime && normalizedRuntime !== 'claude')) {
        const error = new Error('provider must be claude');
        error.statusCode = 400;
        throw error;
      }
      return { provider: 'anthropic', runtime: 'claude', launchRuntime: 'claude' };
    },
    buildArgs({ args = [], model = '', thinkingLevel = '', workDir = '', mcpLaunch = {}, promptLaunch = {}, cliSessionId = '' } = {}) {
      return [
        ...buildClaudeLaunchArgs({
          args, model, thinkingLevel, workDir, cliSessionId,
          remoteControl: appConfig.agentInterface.claudeRemoteControlEnabled,
        }),
        ...(mcpLaunch.claudeConfigPath ? ['--mcp-config', mcpLaunch.claudeConfigPath, '--strict-mcp-config'] : []),
        ...buildPromptLaunchArgs({ runtime: 'claude', promptLaunch }),
      ];
    },
    buildResumeArgs({ cliSessionId = '', model = '', thinkingLevel = '', workDir = '', mcpLaunch = {}, promptLaunch = {} } = {}) {
      const resumeId = String(cliSessionId || '').trim();
      if (!resumeId) throw new Error('Claude resume requires a CLI session id');
      return [
        ...buildClaudeLaunchArgs({
          args: [], model, thinkingLevel, workDir,
          remoteControl: appConfig.agentInterface.claudeRemoteControlEnabled,
        }),
        ...(mcpLaunch.claudeConfigPath ? ['--mcp-config', mcpLaunch.claudeConfigPath, '--strict-mcp-config'] : []),
        ...buildPromptLaunchArgs({ runtime: 'claude', promptLaunch }),
        '--resume',
        resumeId,
      ];
    },
    shellCommand({ sessionBinary, allArgs, launchLogPath, sessionId, initialPromptFile = '' }) {
      const baseCommand = [sessionBinary, ...allArgs].map(shellQuote).join(' ')
        + (initialPromptFile ? ` -- "$(< ${shellQuote(initialPromptFile)})"` : '');
      const command = launchLogPath
        ? `${baseCommand} 2> >(tee -a ${shellQuote(launchLogPath)} >&2)`
        : baseCommand;
      return [
        buildLaunchEnvPrefix(sessionId, 'claude'),
        'unset CLAUDECODE',
        command,
      ].filter(Boolean).join('; ');
    },
  },
  // Pi has no fleet hook reporter. readNativeHookState is false; control
  // paths must use transcript + tmux liveness, not a hook slot.
  pi: {
    id: 'pi',
    displayName: 'Pi',
    tmuxPrefix: 'pi',
    binaryName: 'pi',
    binaryEnv: 'PI_BIN',
    strictBinary: true,
    assignsCliSessionId: true,
    readNativeHookState: false,
    supportsBusinessOsMcp: false,
    revalidateModelOnResume: true,
    defaultProvider: 'xai',
    defaultRuntime: 'pi',
    stateFile: 'pi_sessions.json',
    storageEnv: 'PI_SESSIONS_STORAGE',
    stripContent: (text = '') => String(text || ''),
    startupDelayMs: 180,
    initialPromptDelayMs: 350,
    // Pi loads extensions after the pane opens, so a failed extension (or bad flag) only shows
    // up ~1-2s in; verify across that window before recording the session.
    launchVerifyMs: 3000,
    bufferPrefix: 'dueno-pi',
    async assertModel(model = '', { provider = '', piBin = '' } = {}) {
      return assertPiProviderModel(provider, model, { piBin });
    },
    normalizeRuntime(provider = '', runtime = '') {
      const normalizedRuntime = String(runtime || '').trim().toLowerCase();
      const requestedProvider = String(provider || '').trim().toLowerCase();
      const normalizedProvider = normalizePiProvider(requestedProvider === 'pi' ? 'xai' : requestedProvider);
      if (!normalizedProvider || (normalizedRuntime && normalizedRuntime !== 'pi')) {
        const error = new Error('Pi provider must be xai, google, opencode-go, or openrouter and runtime must be pi');
        error.statusCode = 400;
        error.code = 'pi_provider_unsupported';
        throw error;
      }
      return { provider: normalizedProvider, runtime: 'pi', launchRuntime: 'pi' };
    },
    buildArgs({ args = [], provider = '', model = '', thinkingLevel = '', runtime = 'pi', cliSessionId = '', mcpLaunch = {}, promptLaunch = {} } = {}) {
      return [...buildAgentRuntimeLaunchArgs({
        runtime,
        args,
        provider,
        model,
        thinkingLevel,
        cliSessionId,
      }), ...(mcpLaunch.piExtensionPath ? ['--extension', mcpLaunch.piExtensionPath] : []), ...buildPromptLaunchArgs({ runtime: 'pi', promptLaunch })];
    },
    buildResumeArgs({ cliSessionId = '', provider = '', model = '', thinkingLevel = '', runtime = 'pi', mcpLaunch = {}, promptLaunch = {} } = {}) {
      const resumeId = String(cliSessionId || '').trim();
      if (!resumeId) throw new Error('Pi resume requires a CLI session id');
      return [...buildAgentRuntimeLaunchArgs({
        runtime,
        args: [],
        provider,
        model,
        thinkingLevel,
        cliSessionId: resumeId,
      }), ...(mcpLaunch.piExtensionPath ? ['--extension', mcpLaunch.piExtensionPath] : []), ...buildPromptLaunchArgs({ runtime: 'pi', promptLaunch })];
    },
    async validateBinary(binary) {
      return validatePiCliContract(binary);
    },
    shellCommand({ sessionBinary, allArgs, launchLogPath, sessionId, provider, mcpLaunch = {}, initialPromptFile = '' }) {
      const baseCommand = [sessionBinary, ...allArgs].map(shellQuote).join(' ')
        + (initialPromptFile ? ` "$(< ${shellQuote(initialPromptFile)})"` : '');
      const command = launchLogPath
        ? `${baseCommand} 2> >(tee -a ${shellQuote(launchLogPath)} >&2)`
        : baseCommand;
      const envPrefix = [
        buildLaunchEnvPrefix(sessionId, provider),
        mcpLaunch.piConfigPath ? `export CADRE_PI_MCP_CONFIG=${shellQuote(mcpLaunch.piConfigPath)}; export DUENO_PI_MCP_CONFIG=${shellQuote(mcpLaunch.piConfigPath)}` : '',
      ].filter(Boolean).join('; ');
      return envPrefix ? `${envPrefix}; ${command}` : command;
    },
  },
};

export function renderAgentSessionLaunch({
  backendType,
  resume = false,
  sessionBinary,
  buildOptions = {},
  launchLogPath = '',
  sessionId = '',
  provider = '',
  headroom = { env: {}, args: [] },
  sandbox = null,
} = {}) {
  const providerConfig = PROVIDER_CONFIGS[backendType];
  if (!providerConfig) throw new TypeError(`Unsupported session backend: ${backendType}`);
  buildOptions = { ...buildOptions, ...(headroom.modelProvider ? { modelProvider: headroom.modelProvider } : {}) };
  const allArgs = resume
    ? providerConfig.buildResumeArgs(buildOptions)
    : providerConfig.buildArgs(buildOptions);
  allArgs.unshift(...headroom.args);
  const envPrefix = Object.entries({ ...headroom.env, ...sandbox?.env }).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join('; ');
  const tokenExport = sandbox?.tokenFile ? `export CADRE_SANDBOX_GH_TOKEN="$(< ${shellQuote(sandbox.tokenFile)})"` : '';
  return {
    allArgs,
    paneCommand: [envPrefix, tokenExport, providerConfig.shellCommand({
      sessionBinary: sandbox ? 'nono' : sessionBinary,
      allArgs: sandbox ? [...sandbox.args, '--', sessionBinary, ...allArgs] : allArgs,
      launchLogPath,
      sessionId,
      provider,
      mcpLaunch: buildOptions.mcpLaunch || {},
      initialPromptFile: resume ? '' : buildOptions.initialPromptFile || '',
    })].filter(Boolean).join('; '),
  };
}

const binaryCache = new Map();

function compareSemanticVersions(left = [], right = []) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = Number(left[index] || 0);
    const rightPart = Number(right[index] || 0);
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

export function createAgentSessionsProvider(providerId) {
  const config = PROVIDER_CONFIGS[providerId];
  if (!config) throw new Error(`Unsupported agent session provider: ${providerId}`);

  const SESSION_STORE = buildPostgresJsonStore({
    namespace: `${config.id}_sessions`,
    filePath: runtimeStatePath(config.stateFile),
    legacyFilePath: legacyRootStatePath(config.stateFile),
    modeEnvKey: config.storageEnv,
  });
  const SCHEDULED_SEND_STORE = buildPostgresJsonStore({
    namespace: `${config.id}_scheduled_sends`,
    filePath: runtimeStatePath(`${config.id}_scheduled_sends.json`),
    legacyFilePath: legacyRootStatePath(`${config.id}_scheduled_sends.json`),
    modeEnvKey: `${config.id.toUpperCase()}_SCHEDULED_SENDS_STORAGE`,
  });
  let sessions = new Map();
  let lastStates = new Map();
  let lastAlertTime = new Map();
  let attentionSeq = new Map();
  let activeAttention = new Map();
  let lastAttentionStatus = new Map();
  let lastReadyAt = new Map();
  let lastBroadcastAttentionKey = new Map();
  let firstTranscriptIdleAt = new Map();
  let lastHookedStates = new Map();
  let _registerSession = null;
  let _ensureDialogPolicy = null;
  let _enqueueSessionCommand = null;
  let _submitSessionCommand = null;
  const discoveryCache = new Map();
  const stateCache = new Map();
  const captureInFlight = new Map();
  let agentBusCredentialStore = null;

  function credentialStoreOptions() {
    return agentBusCredentialStore ? { credentialStore: agentBusCredentialStore } : {};
  }

  async function authorizeInteractionRequest(
    req,
    id,
    snapshot,
    tool = 'tmux.interaction',
    sessionDeliveryAuditStore = null,
  ) {
    let audit;
    try {
      audit = permissionAuthorityForRequest(req, {
        tool,
        scope: 'permission.approve',
        risk: snapshot?.interaction?.kind || 'terminal_interaction',
      });
    } catch (error) {
      audit = error.authorityAudit || { decision: 'denied' };
      await recordSessionDeliveryAudit(sessionDeliveryAuditStore, {
        source: 'interaction_authority', kind: config.id, sessionId: id,
        text: '', enter: false, status: 'dropped',
        error: error.message || '',
        metadata: {
          ...audit,
          interactionFingerprint: snapshot?.interaction?.fingerprint || null,
          interactionKind: snapshot?.interaction?.kind || null,
        },
      }).catch(() => {});
      throw error;
    }
    await recordSessionDeliveryAudit(sessionDeliveryAuditStore, {
      source: 'interaction_authority', kind: config.id, sessionId: id,
      text: '', enter: false, status: 'queued',
      metadata: {
        ...audit,
        interactionFingerprint: snapshot?.interaction?.fingerprint || null,
        interactionKind: snapshot?.interaction?.kind || null,
      },
    }).catch(() => {});
    return audit;
  }

function paneObservations(content, options = {}) {
  if (config.id === 'codex') return observeCodexPane(content, options);
  if (config.id === 'pi') return observePiPane(content, options);
  return observeClaudePane(content, options);
}

function latestPaneExecution(id) {
  const explained = sessionStateTracker.explain(canonicalSessionStateId(config.id, id));
  return latestFreshPaneExecution(explained?.observations || [], Date.now());
}

function hookExecution(activity = '') {
  if (activity === 'prompt_ready' || activity === 'done_idle') return 'idle';
  if (activity === 'thinking') return 'thinking';
  if (['starting', 'working', 'tool_running', 'compacting'].includes(activity)) return 'working';
  return 'unknown';
}

async function resolveSessionTranscriptPath(id, meta = {}) {
  const hookMetadata = await readHookSessionMetadata({
    workDir: meta.workDir || process.cwd(),
    provider: config.id,
    sessionId: id,
  }).catch(() => null);
  const known = String(hookMetadata?.transcriptPath || meta.transcriptPath || '').trim();
  if (known) return known;
  // Pi has no hook reporter. Resolve the cheap cliSessionId path only —
  // full telegram binding scans Codex rollouts and is not safe on this tick.
  if (config.id !== 'pi' || !meta.cliSessionId || !meta.workDir) return '';
  const binding = await resolveBinding({
    id,
    workDir: meta.workDir,
    runtime: 'pi',
    cliSessionId: meta.cliSessionId,
    created: meta.created,
  }).catch(() => null);
  return String(binding?.path || '').trim();
}

async function observeSessionEvidence(id, meta = {}, content = '', now = Date.now(), {
  lifecycle = 'running',
  paneFreshMs = PANE_FRESH_MS,
} = {}) {
  const trackerId = canonicalSessionStateId(config.id, id);
  let processLifecycle = lifecycle;
  const observations = [];
  if (lifecycle === 'running' && meta?.tmuxSession) {
    const processObservations = await observeProcessLiveness({
      sessionName: meta.tmuxSession || meta.name || '',
      now,
      execFn: exec,
      expectedCli: config.id,
    });
    // Empty means the probe could not decide. Do not synthesize missing.
    if (processObservations.length) {
      observations.push(...processObservations);
      processLifecycle = processObservations[0]?.value?.lifecycle || processLifecycle;
    }
  } else {
    observations.push({
      source: 'process',
      kind: 'lifecycle',
      value: { lifecycle: processLifecycle },
      observedAt: now,
      expiresAt: processLifecycle === 'running' ? now + Math.max(PROCESS_LIFECYCLE_FRESH_MS, 1) : 0,
      fingerprint: `process:${processLifecycle}`,
    });
  }
  observations.push({
    source: 'runtime',
    kind: 'requested_runtime',
    value: {
      requestedModel: String(meta.model || ''),
      requestedThinkingLevel: String(meta.thinkingLevel || ''),
    },
    observedAt: now,
    expiresAt: 0,
    fingerprint: `requested:${String(meta.model || '')}:${String(meta.thinkingLevel || '')}`,
  });

  if (processLifecycle === 'running') {
    observations.push(...paneObservations(content, {
      observedAt: now,
      expiresAt: now + Math.max(paneFreshMs, 1),
      stable: true,
      requireRepeat: true,
    }));
  }

  const hook = config.readNativeHookState === false ? null : await readHookDerivedState({
    workDir: meta.workDir || process.cwd(),
    provider: config.id,
    sessionId: id,
    now,
  }).catch(() => null);
  if (hook?.source === 'hook' && hook.ageMs < HOOK_STATE_TTL_MS) {
    const hookAt = Number(hook.last_hook_event_at || now);
    const expiresAt = hookAt + HOOK_STATE_TTL_MS;
    observations.push({
      source: 'hook',
      kind: 'lifecycle',
      value: { lifecycle: hook.lifecycle || 'running' },
      observedAt: hookAt,
      // Hook execution may stay fresh for HOOK_STATE_TTL_MS. Lifecycle is not
      // a liveness check — keep it on the process TTL so a stale Stop hook
      // cannot grant running after captures stop. Stop is never process death.
      expiresAt: hookAt + PROCESS_LIFECYCLE_FRESH_MS,
      fingerprint: `hook-lifecycle:${hook.lifecycle || 'running'}:${hook.last_event_name || ''}`,
    });
    observations.push({
      source: 'hook',
      kind: 'execution',
      value: { execution: hookExecution(hook.activity), activity: hook.activity || 'unknown' },
      observedAt: hookAt,
      expiresAt,
      fingerprint: `hook-execution:${hook.activity || 'unknown'}:${hook.last_event_name || ''}`,
    });
    if (hook.activity === 'needs_permission') {
      observations.push({
        source: 'hook',
        kind: 'interaction',
        value: { kind: 'permission', detail: 'Needs permission', options: [] },
        observedAt: hookAt,
        expiresAt,
        fingerprint: `hook-interaction:permission:${hook.last_event_name || ''}`,
      });
    }
  }

  // Transcript ingest is independent of native hook state. Pi sets
  // readNativeHookState false (no fleet hook reporter) but still has transcripts.
  if (processLifecycle === 'running') {
    const transcriptPath = await resolveSessionTranscriptPath(id, meta);
    if (transcriptPath) {
      if (sessions.has(id) && !sessions.get(id)?.transcriptPath) {
        sessions.set(id, { ...sessions.get(id), transcriptPath });
      }
      observations.push(...await observeTranscriptFile(transcriptPath, {
        provider: config.id,
        now,
      }).catch(() => []));
    }
  }

  const snapshot = sessionStateTracker.observe(trackerId, observations);
  _ensureDialogPolicy?.(id, snapshot);
  return snapshot;
}

function extractPromptReadySnippet(content = '') {
  const lines = normalizeProviderPane(config.id, content).contentLines;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    return line.length > PROMPT_READY_SNIPPET_MAX
      ? `${line.slice(0, PROMPT_READY_SNIPPET_MAX - 1)}…`
      : line;
  }
  return '';
}

function sessionCacheKey(session = {}, fallback = '') {
  return String(session?.id || fallback || session?.tmuxSession || session?.name || '').trim();
}

// Scrape-derived telemetry only. Canonical state reads state.hook via
// readHookDerivedState (source === 'hook'). This writer fills the runtime
// slot and appends source:'runtime' jsonl events consumed by:
//   - agent-bus/observer processRuntimeHookEvent (outbound queue readiness)
//   - telegram/relay isOperatorQuestionClosedEvent (notification, allowed to be wrong)
// Do not treat these events as hook evidence.
async function recordSessionRuntimeHook(id, meta, eventName, data = {}) {
  try {
    await recordRuntimeHookEvent({
      workDir: meta?.workDir || process.cwd(),
      provider: config.id,
      sessionId: id,
      eventName,
      data,
    });
  } catch {
    // Best effort
  }
}

function priorHookedStateSnapshot(value) {
  if (value && typeof value === 'object') {
    return {
      key: String(value.key || '').trim(),
      state: String(value.state || '').trim(),
      status: String(value.status || '').trim(),
    };
  }
  const state = String(value || '').trim();
  return { key: state, state, status: '' };
}

function stateHookKey(state = {}) {
  return [
    String(state?.status || '').trim(),
    String(state?.execution || '').trim(),
    String(state?.interaction?.kind || '').trim(),
    state?.capabilities?.canSendNow === true ? 'sendable' : 'unsafe',
  ].join('|');
}

async function maybeRecordSessionStateHooks(id, meta, state, content = '') {
  const nextState = String(state?.state || '').trim();
  if (!nextState) return;
  if (state?.status === 'unknown' && state?.interaction?.kind === 'free_text') return;

  const previous = priorHookedStateSnapshot(lastHookedStates.get(id));
  const nextKey = stateHookKey(state);
  if (previous.key === nextKey) return;
  lastHookedStates.set(id, { key: nextKey, state: nextState, status: state.status });

  const detail = typeof state?.detail === 'string' ? state.detail : null;
  const inputType = typeof state?.inputType === 'string' ? state.inputType : null;
  const snippet = extractPromptReadySnippet(content);
  const payload = {
    previousState: previous.state || null,
    sessionState: nextState,
    detail,
    inputType,
    activity: typeof state?.activity === 'string' ? state.activity : null,
    stateSource: typeof state?.state_source === 'string' ? state.state_source : null,
    safeToMessage: state?.capabilities?.canSendNow === true,
    snippet: snippet || null,
  };

  await recordSessionRuntimeHook(id, meta, 'SessionStateChanged', payload);
  if (TOOL_BUSY_STATUSES.has(state.status) && !TOOL_BUSY_STATUSES.has(previous.status)) {
    await recordSessionRuntimeHook(id, meta, 'SessionToolStarted', payload);
  }
  if (TOOL_BUSY_STATUSES.has(previous.status) && state?.status === 'ready') {
    await recordSessionRuntimeHook(id, meta, 'SessionToolFinished', payload);
  }
  if (state?.interaction?.kind === 'permission') {
    await recordSessionRuntimeHook(id, meta, 'SessionPermissionNeeded', payload);
    return;
  }
  if (state?.status === 'ready') {
    await recordSessionRuntimeHook(id, meta, 'SessionPromptReady', payload);
    return;
  }
  if (TOOL_BUSY_STATUSES.has(state.status)) {
    await recordSessionRuntimeHook(id, meta, 'SessionBusy', payload);
  }
}

async function captureSessionSnapshotUncached(id, sessionName, meta = {}, { lines = 200, cache = true } = {}) {
  const { stdout: rawContent, code, stderr } = await exec('tmux', ['capture-pane', '-t', sessionName, '-p', '-e', '-S', `-${lines}`]);
  if (code !== 0) {
    const err = new Error(stderr || `Session not found: ${sessionName}`);
    if (isTmuxMissingSessionError(stderr)) {
      await observeSessionEvidence(id, meta, '', Date.now(), { lifecycle: 'missing' });
      err.statusCode = 404;
      err.code = 'session_not_found';
    } else {
      err.statusCode = 503;
      err.code = 'session_observation_unavailable';
      err.transient = true;
    }
    throw err;
  }

  const content = config.stripContent(rawContent);
  const snapshot = await observeSessionEvidence(id, meta, content);
  const state = projectCanonicalState(snapshot);
  const pendingResponse = state.pendingResponse ? { sentAt: state.updatedAt } : null;
  const attention = syncAttention(id, { ...meta, name: sessionName, tmuxSession: sessionName }, state, content);
  if (cache) {
    stateCache.set(sessionCacheKey({ ...meta, id }, id), {
      capturedAt: Date.now(), state, attention, pendingResponse, content,
    });
  }
  await maybeRecordSessionStateHooks(id, meta, state, content);
  return { content, state, canonicalState: snapshot, attention, pendingResponse };
}

async function captureSessionSnapshot(id, sessionName, meta = {}, options = {}) {
  const lines = Number(options?.lines || 200);
  const cache = options?.cache !== false;
  // Detail reads and permission-authority probes must observe the current pane. A capture
  // started before input delivery can otherwise pin pre-send state for the cache TTL.
  if (options?.reuseInFlight === false) {
    return captureSessionSnapshotUncached(id, sessionName, meta, { lines, cache });
  }
  const key = `${id}:${sessionName}:${lines}:${cache ? 'cache' : 'no-cache'}`;
  if (captureInFlight.has(key)) return captureInFlight.get(key);
  const pending = captureSessionSnapshotUncached(id, sessionName, meta, { lines, cache });
  captureInFlight.set(key, pending);
  try {
    return await pending;
  } finally {
    if (captureInFlight.get(key) === pending) captureInFlight.delete(key);
  }
}

async function prepareLaunchLog(sessionName) {
  await mkdir(LAUNCH_LOG_DIR, { recursive: true });
  const launchLogPath = resolve(LAUNCH_LOG_DIR, `${sessionName}.log`);
  await writeFile(launchLogPath, '');
  return launchLogPath;
}

function normalizeText(value = '') {
  return String(value || '').trim();
}

function deriveManagedWorktreeMetadata(metadata = {}) {
  const source = metadata && typeof metadata === 'object' ? metadata : {};
  const worktreePath = normalizeText(
    source.worktreePath
    || source.github_worktree_path
    || source.fleet_repo_worktree_path
  );
  const worktreeBranch = normalizeText(
    source.worktreeBranch
    || source.github_branch
    || source.fleet_repo_worktree_branch
  );
  const worktreeRepoPath = normalizeText(
    source.worktreeRepoPath
    || source.github_source_repo_path
    || source.fleet_repo_source_path
    || source.requestedWorkDir
  );
  if (!worktreePath) return {};
  return {
    managedWorktree: true,
    worktreePath,
    worktreeBranch,
    worktreeRepoPath,
  };
}

function hasBusinessOsMcpSelection(meta = {}) {
  for (const key of ['selectedMcpServers', 'includeMcpServers', 'enabledMcpServers', 'mcpServerSelection']) {
    const selected = meta?.[key];
    if (Array.isArray(selected) && selected.map(normalizeText).includes('businessos')) return true;
    if (typeof selected === 'string' && selected.split(',').map(normalizeText).includes('businessos')) return true;
    if (selected && typeof selected === 'object' && selected.businessos === true) return true;
  }
  if (meta.businessOsMcp === true || meta.enableBusinessOsMcp === true) return true;
  return meta?.businessOsMcp?.serverName === 'businessos'
    || meta?.businessOsMcp?.name === 'businessos'
    || Boolean(meta?.businessOsMcp?.url);
}

function assertNoCallerMcpOverrides(args = []) {
  if (!Array.isArray(args)) return;
  const forbidden = args.find((value) => (
    /(?:^|\.)mcp_servers(?:\s|\.|=|$)/i.test(String(value || ''))
    || /^--(?:strict-)?mcp-config(?:=|$)/i.test(String(value || ''))
  ));
  if (!forbidden) return;
  const error = new Error('MCP launch configuration must use mcpProfile/mcpServers IDs');
  error.statusCode = 400;
  error.code = 'mcp_launch_override_forbidden';
  throw error;
}

function assertNoCallerPromptOverrides(args = []) {
  if (!Array.isArray(args)) return;
  const forbidden = args.find((value) => (
    /^--(?:append-)?system-prompt(?:-file)?(?:=|$)/i.test(String(value || ''))
    || /(?:^|\.)developer_instructions(?:\s|=|$)/i.test(String(value || ''))
  ));
  if (!forbidden) return;
  const error = new Error('Prompt style must use promptProfile');
  error.statusCode = 400;
  error.code = 'prompt_launch_override_forbidden';
  throw error;
}

function capabilityProvider(configId, sessionRuntime) {
  return configId === 'pi' ? sessionRuntime.provider : configId;
}

function canonicalMcpRequest({ mcpProfile, mcpServers } = {}) {
  return {
    ...(mcpProfile !== undefined ? { mcpProfile } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
  };
}

function legacyMcpRequest(meta = {}) {
  if (hasResearchWorkbenchLaunchProfile(meta.metadata)) return { mcpProfile: 'research' };
  if (hasBusinessOsMcpSelection(meta)) {
    return { mcpServers: { add: ['businessos'] } };
  }
  return {};
}

function assertResumeDigest(stored, resolved) {
  if (!stored) return;
  if (
    stored.catalogVersion === resolved.catalogVersion
    && stored.configurationDigest === resolved.configurationDigest
  ) return;
  const error = new Error('MCP capability configuration changed; start a fresh session to change capabilities');
  error.statusCode = 409;
  error.code = 'mcp_resume_configuration_drift';
  throw error;
}

function stripLegacyMcpMetadata(meta = {}) {
  const {
    selectedMcpServers: _selectedMcpServers,
    includeMcpServers: _includeMcpServers,
    enabledMcpServers: _enabledMcpServers,
    mcpServerSelection: _mcpServerSelection,
    businessOsMcp: _businessOsMcp,
    enableBusinessOsMcp: _enableBusinessOsMcp,
    businessOsMcpConfigPath: _businessOsMcpConfigPath,
    ...sanitized
  } = meta;
  return sanitized;
}

async function assertTmuxSessionExists(sessionName, launchLogPath = '') {
  const { code, stderr } = await exec('tmux', ['has-session', '-t', sessionName]);
  if (code === 0) return;

  const launchLog = await readLaunchLogTail(launchLogPath);
  const message = launchLog
    ? `Agent process exited during startup:\n${launchLog.trim()}`
    : (stderr || `Tmux session exited immediately: ${sessionName}`);
  const err = new Error(message);
  err.statusCode = 500;
  throw err;
}

/**
 * A single `has-session` probe at 250ms cannot tell a healthy harness from one that is about to
 * die on a startup error, and `tee` on the stderr pipe keeps the pane alive after the harness
 * exits. Poll both the pane and the launch log for the harness-specific startup grace window so
 * a failed launch surfaces as a 500 instead of a blank session.
 */
async function verifyLaunchedSession(sessionName, launchLogPath, graceMs) {
  const deadline = Date.now() + Math.max(graceMs, 0);
  for (;;) {
    await assertTmuxSessionExists(sessionName, launchLogPath);
    const failure = detectLaunchFailure(
      await readLaunchLogTail(launchLogPath),
      config.defaultRuntime || config.id,
    );
    if (failure) {
      await exec('tmux', ['kill-session', '-t', sessionName]).catch(() => {});
      const err = new Error(`Agent process failed during startup:\n${failure}`);
      err.statusCode = 500;
      err.code = `${config.id}_launch_failed`;
      throw err;
    }
    if (Date.now() >= deadline) return;
    await sleep(Math.min(LAUNCH_VERIFY_INTERVAL_MS, Math.max(deadline - Date.now(), 1)));
  }
}

async function launchTmuxSession({ sessionName, workDir = '', sessionBinary = '', allArgs = [], paneCommand = '', launchLogPath = '', sessionId = '', provider = '', mcpLaunch = {}, sandboxed = false } = {}) {
  const tmuxArgs = ['new-session', '-d', '-s', sessionName];
  if (workDir) tmuxArgs.push('-c', workDir);
  tmuxArgs.push('bash', '-lc', paneCommand || config.shellCommand({
    sessionBinary,
    allArgs,
    launchLogPath,
    sessionId,
    provider,
    mcpLaunch,
  }));

  const { code, stderr } = await exec('tmux', tmuxArgs);
  if (code !== 0) {
    throw new Error(`Failed to create session: ${stderr}`);
  }
  await sleep(250);
  // nono reports its own startup errors on stderr; give them time to reach the launch log.
  await verifyLaunchedSession(sessionName, launchLogPath, Math.max(Number(config.launchVerifyMs || 0), sandboxed ? 1000 : 0));
}

async function createSession({ sessionId, initialPrompt = '', workDir, args, model = '', provider = config.id, runtime = '', thinkingLevel = '', source = 'external', displayName = '', autoCloseMode = 'never', autoCloseAfterMs = 0, metadata = {}, coordinatorPolicy = null, loopRegistrationPolicy = null, mcpProfile, mcpServers, mcpCredentialProfile = 'agent', codexPlugins, promptProfile, skills, sandbox, githubToken = '' } = {}) {
  const sessionRuntime = config.normalizeRuntime(provider, runtime);
  const sandboxMode = resolveSandbox(sandbox);
  const researchSafeRuntime = config.id === 'codex' && hasResearchWorkbenchLaunchProfile(metadata);
  if (config.id !== 'codex' && codexPlugins !== undefined) {
    throw Object.assign(new Error('codexPlugins is only supported for Codex sessions'), {
      statusCode: 400, code: 'codex_plugin_selection_unsupported',
    });
  }
  const selectedCodexPlugins = config.id === 'codex'
    ? normalizeCodexPluginSelection(codexPlugins)
    : undefined;
  if (sandboxMode === 'nono') assertNonoSupported({ researchSafeRuntime, codexPlugins: selectedCodexPlugins, serverIds: [] });
  assertNoCallerMcpOverrides(args);
  assertNoCallerPromptOverrides(args);
  let sessionBinary = config.strictBinary ? await findCompatibleBinary() : '';
  const validatedModel = await config.assertModel(model, {
    provider: sessionRuntime.provider,
    piBin: sessionBinary,
  });
  if (!sessionBinary) sessionBinary = await findCompatibleBinary();
  const normalizedWorkDir = await normalizeSessionWorkDir(workDir);
  const resolvedMcp = resolveMcpCapabilities({
    request: canonicalMcpRequest({ mcpProfile, mcpServers }),
    provider: capabilityProvider(config.id, sessionRuntime),
    runtime: sessionRuntime.runtime,
    catalog: buildMcpCapabilityCatalog(),
  });
  if (sandboxMode === 'nono') assertNonoSupported({ researchSafeRuntime, codexPlugins: selectedCodexPlugins, serverIds: resolvedMcp.serverIds });
  const selectedSkills = sanitizedSkillSnapshot(skills);
  resolveLaunchSkills({ skillIds: selectedSkills });
  resolvePromptProfile({ promptProfile });

  const id = sessionId || generateId();
  if (typeof id !== 'string' || !/^[a-f0-9]{8,32}$/.test(id) || sessions.has(id)) throw Object.assign(new Error('Invalid or duplicate sessionId'), { statusCode: 400 });
  const launchPrompt = resolveHarnessUserText(initialPrompt);
  const initialPromptFile = launchPrompt ? initialPromptPath(id) : '';
  if (launchPrompt.includes('\0') || (config.id === 'pi' && launchPrompt.startsWith('-')) || Buffer.byteLength(launchPrompt, 'utf8') >= 128 * 1024) {
    throw Object.assign(new Error('Initial prompt must be under 128 KiB, contain no NUL, and for Pi must not start with a dash'), { statusCode: 400 });
  }
  const sessionName = `${config.tmuxPrefix}-${id}`;
  const launchStartedAt = Date.now();

  const mcpPreparation = await prepareMcpCapabilityLaunch({
    resolved: resolvedMcp,
    backendType: config.id,
    sessionId: id,
    workDir: normalizedWorkDir,
    attemptGeneration: 1,
    coordinatorPolicy,
    loopRegistrationPolicy,
    credentialProfile: mcpCredentialProfile,
    ...credentialStoreOptions(),
  });
  let promptPreparation = null;
  let launchLogPath = '';
  let scopeLaunch = null;
  let sandboxLaunch = null;
  // Fresh per launch: claude rejects a session id that already has a transcript.
  const cliSessionId = config.assignsCliSessionId ? randomUUID() : '';

  try {
    promptPreparation = await preparePromptProfileLaunch({
      promptProfile,
      backendType: config.id,
      sessionId: id,
    });
    if (initialPromptFile) {
      await mkdir(resolve(initialPromptFile, '..'), { recursive: true });
      await writeFile(initialPromptFile, launchPrompt, { mode: 0o600 });
    }
    launchLogPath = await prepareLaunchLog(sessionName);
    const headroom = await prepareHeadroomLaunch(sessionRuntime.provider);
    sandboxLaunch = sandboxMode === 'nono' ? await prepareNonoLaunch({
      provider: config.id, sessionId: id, workDir: normalizedWorkDir, mcpLaunch: mcpPreparation.prepared,
      promptLaunch: promptPreparation.prepared, headroom, githubToken,
    }) : null;
    const renderedLaunch = renderAgentSessionLaunch({
      headroom,
      sandbox: sandboxLaunch,
      backendType: config.id,
      sessionBinary,
      launchLogPath,
      sessionId: id,
      provider: sessionRuntime.provider,
      buildOptions: {
        args,
        model: validatedModel,
        provider: sessionRuntime.provider,
        thinkingLevel,
        workDir: normalizedWorkDir,
        runtime: sessionRuntime.launchRuntime,
        mcpLaunch: mcpPreparation.prepared,
        promptLaunch: promptPreparation.prepared,
        cliSessionId,
        initialPromptFile,
        researchSafeRuntime,
        codexPlugins: selectedCodexPlugins,
      },
    });
    const { allArgs, paneCommand } = renderedLaunch;
    scopeLaunch = buildAgentScopeLaunch(paneCommand, { kind: config.id, sessionId: id });
    if (config.id === 'claude') await seedClaudeWorkspaceTrust(normalizedWorkDir, claudeTrustOptions(sandboxLaunch));

    await launchTmuxSession({
      sessionName,
      workDir: normalizedWorkDir,
      sessionBinary,
      allArgs,
      paneCommand: scopeLaunch.command,
      launchLogPath,
      sessionId: id,
      provider: sessionRuntime.provider,
      mcpLaunch: mcpPreparation.prepared,
      sandboxed: Boolean(sandboxLaunch),
    });
  } catch (error) {
    if (scopeLaunch?.unit) await stopAgentScope(scopeLaunch.unit).catch(() => {});
    if (launchLogPath) await rm(launchLogPath, { force: true }).catch(() => {});
    if (sandboxMode === 'nono') await removeSandboxState(id);
    await cleanupMcpCapabilityLaunch({
      backendType: config.id, sessionId: id, credentialProfile: mcpCredentialProfile, ...credentialStoreOptions(),
    });
    await cleanupPromptProfileLaunch({ backendType: config.id, sessionId: id });
    await rm(initialPromptPath(id), { force: true }).catch(() => {});
    throw error;
  }

  const meta = {
    workDir: normalizedWorkDir,
    args: args || [],
    model: validatedModel,
    provider: sessionRuntime.provider,
    runtime: sessionRuntime.runtime,
    thinkingLevel,
    source,
    displayName: String(displayName || '').trim(),
    metadata: metadata && typeof metadata === 'object' ? { ...metadata } : {},
    mcpCapabilities: sanitizedMcpSnapshot(resolvedMcp, mcpPreparation.preflight),
    mcpCredentialProfile,
    ...(selectedCodexPlugins ? { codexPlugins: selectedCodexPlugins } : {}),
    promptProfile: sanitizedPromptSnapshot(promptPreparation.resolved),
    skills: selectedSkills,
    autoCloseMode: String(autoCloseMode || 'never').trim() || 'never',
    autoCloseAfterMs: Number.isFinite(Number(autoCloseAfterMs)) ? Number(autoCloseAfterMs) : 0,
    tmuxSession: sessionName,
    created: Date.now(),
    launchStartedAt,
    attemptGeneration: 1,
    ...(scopeLaunch?.unit ? {
      agentScopeUnit: scopeLaunch.unit,
      agentScopeSlice: scopeLaunch.slice,
      processIsolation: 'systemd-scope-v1',
    } : {}),
    ...(cliSessionId ? { cliSessionId } : {}),
    launchLogPath,
    ...(sandboxLaunch ? { sandbox: 'nono', sandboxGrants: sandboxLaunch.grants } : {}),
    ...deriveManagedWorktreeMetadata(metadata),
  };

  sessions.set(id, meta);
  invalidateSessionCaches();
  await persistSessions();
  if (_registerSession) _registerSession(id, meta);

  return { id, sessionName, mcpCapabilities: meta.mcpCapabilities };
}

async function refreshSessionCliMetadata(id, meta = {}, targetSessions = sessions) {
  if (!id || !meta?.workDir) return false;
  if (config.readNativeHookState === false) return false;
  const hookMeta = await readHookSessionMetadata({
    workDir: meta.workDir,
    provider: config.id,
    sessionId: id,
  }).catch(() => null);
  if (!hookMeta?.cliSessionId) return false;
  const current = targetSessions.get(id) || meta;
  const next = {
    ...current,
    cliSessionId: hookMeta.cliSessionId,
    cliSessionUpdatedAt: hookMeta.updatedAt || new Date().toISOString(),
    ...(hookMeta.transcriptPath ? { transcriptPath: hookMeta.transcriptPath } : {}),
    ...(hookMeta.model && !current.model ? { model: hookMeta.model } : {}),
  };
  if (
    current.cliSessionId === next.cliSessionId
    && current.cliSessionUpdatedAt === next.cliSessionUpdatedAt
    && current.transcriptPath === next.transcriptPath
  ) {
    return false;
  }
  targetSessions.set(id, next);
  return true;
}

async function resumeSession(id, { loopRegistrationPolicy = null } = {}) {
  const meta = sessions.get(id);
  if (!meta) {
    const err = new Error(`Session not found: ${id}`);
    err.statusCode = 404;
    err.code = 'session_not_found';
    throw err;
  }
  if (['bare-process', 'orphan-process'].includes(meta.source) || isRustManagedReadOnlySession(meta, id)) {
    const err = new Error('Session cannot be resumed from this source');
    err.statusCode = 409;
    err.code = 'resume_unsupported';
    throw err;
  }

  await refreshSessionCliMetadata(id, meta);
  const refreshed = sessions.get(id) || meta;
  const cliSessionId = normalizeText(refreshed.cliSessionId || refreshed.sessionId || refreshed.metadata?.cliSessionId);
  if (!cliSessionId) {
    const err = new Error('Cannot resume: CLI session id is unknown. Start a fresh session in the same workdir.');
    err.statusCode = 409;
    err.code = 'cli_session_id_unknown';
    err.freshSession = {
      provider: config.id === 'pi' ? (refreshed.provider || config.defaultProvider) : config.id,
      workDir: refreshed.workDir || '',
      model: refreshed.model || '',
      thinkingLevel: refreshed.thinkingLevel || '',
      displayName: refreshed.displayName || '',
    };
    throw err;
  }

  const sessionName = refreshed.tmuxSession || `${config.tmuxPrefix}-${id}`;
  const existing = await exec('tmux', ['has-session', '-t', sessionName]);
  if (existing.code === 0) {
    const err = new Error(`Session already running: ${sessionName}`);
    err.statusCode = 409;
    err.code = 'session_already_running';
    throw err;
  }
  if (refreshed.agentScopeUnit) {
    const expectedScope = agentScopeUnitName(config.id, id);
    if (!expectedScope || refreshed.agentScopeUnit !== expectedScope) {
      const err = new Error('Cannot resume: saved agent scope identity is invalid');
      err.statusCode = 409;
      err.code = 'invalid_agent_scope';
      throw err;
    }
    const stopped = await stopAgentScope(refreshed.agentScopeUnit);
    if (!stopped.ok) {
      const err = new Error(stopped.error || 'Cannot resume while the prior agent scope is still active');
      err.statusCode = 409;
      err.code = stopped.reason || 'agent_scope_survived';
      err.residual = stopped.residual || [];
      throw err;
    }
  }

  const sandboxMode = resolveSandbox(refreshed.sandbox, { resume: true });
  const sessionBinary = await findCompatibleBinary();
  const normalizedWorkDir = await normalizeSessionWorkDir(refreshed.workDir || process.cwd());
  const sessionRuntime = config.normalizeRuntime(refreshed.provider || config.defaultProvider, refreshed.runtime || config.defaultRuntime);
  const storedMcp = refreshed.mcpCapabilities && typeof refreshed.mcpCapabilities === 'object'
    ? refreshed.mcpCapabilities
    : null;
  const resolvedMcp = resolveMcpCapabilities({
    request: storedMcp ? {} : legacyMcpRequest(refreshed),
    inherited: storedMcp,
    provider: capabilityProvider(config.id, sessionRuntime),
    runtime: sessionRuntime.runtime,
    catalog: buildMcpCapabilityCatalog(),
  });
  assertResumeDigest(storedMcp, resolvedMcp);
  if (sandboxMode === 'nono') {
    assertNonoSupported({ researchSafeRuntime: config.id === 'codex' && hasResearchWorkbenchLaunchProfile(refreshed.metadata),
      codexPlugins: refreshed.codexPlugins, serverIds: resolvedMcp.serverIds });
  }
  const resumedModel = config.revalidateModelOnResume
    ? await config.assertModel(refreshed.model || '', {
        provider: sessionRuntime.provider,
        piBin: sessionBinary,
      })
    : (refreshed.model || '');
  const resumeStartedAt = Date.now();
  await cleanupMcpCapabilityLaunch({
    backendType: config.id,
    sessionId: id,
    credentialProfile: refreshed.mcpCredentialProfile || 'agent',
    reason: 'resume_rotation',
    ...credentialStoreOptions(),
  });
  await cleanupPromptProfileLaunch({ backendType: config.id, sessionId: id });
  await rm(initialPromptPath(id), { force: true }).catch(() => {});
  const mcpPreparation = await prepareMcpCapabilityLaunch({
    resolved: resolvedMcp,
    backendType: config.id,
    sessionId: id,
    workDir: normalizedWorkDir,
    attemptGeneration: Math.max(1, Number(refreshed.attemptGeneration || 1) + 1),
    coordinatorPolicy: storedCoordinatorPolicy(refreshed.metadata),
    loopRegistrationPolicy,
    credentialProfile: refreshed.mcpCredentialProfile || 'agent',
    rotation: true,
    ...credentialStoreOptions(),
  });
  let promptPreparation = null;
  let launchLogPath = '';
  let scopeLaunch = null;

  try {
    promptPreparation = await preparePromptProfileLaunch({
      promptProfile: refreshed.promptProfile?.profileId,
      backendType: config.id,
      sessionId: id,
    });
    launchLogPath = await prepareLaunchLog(sessionName);
    const headroom = await prepareHeadroomLaunch(sessionRuntime.provider);
    const sandboxLaunch = sandboxMode === 'nono' ? await prepareNonoLaunch({
      provider: config.id, sessionId: id, workDir: normalizedWorkDir, grants: refreshed.sandboxGrants || {},
      mcpLaunch: mcpPreparation.prepared, promptLaunch: promptPreparation.prepared, headroom,
    }) : null;
    const { allArgs, paneCommand } = renderAgentSessionLaunch({
      headroom,
      sandbox: sandboxLaunch,
      backendType: config.id,
      resume: true,
      sessionBinary,
      launchLogPath,
      sessionId: id,
      provider: sessionRuntime.provider,
      buildOptions: {
        cliSessionId,
        provider: sessionRuntime.provider,
        model: resumedModel,
        thinkingLevel: refreshed.thinkingLevel || '',
        workDir: normalizedWorkDir,
        runtime: sessionRuntime.launchRuntime,
        mcpLaunch: mcpPreparation.prepared,
        promptLaunch: promptPreparation.prepared,
        researchSafeRuntime: config.id === 'codex' && hasResearchWorkbenchLaunchProfile(refreshed.metadata),
        codexPlugins: refreshed.codexPlugins,
      },
    });
    scopeLaunch = buildAgentScopeLaunch(paneCommand, { kind: config.id, sessionId: id });
    if (config.id === 'claude') await seedClaudeWorkspaceTrust(normalizedWorkDir, claudeTrustOptions(sandboxLaunch));
    await launchTmuxSession({
      sessionName,
      workDir: normalizedWorkDir,
      sessionBinary,
      allArgs,
      paneCommand: scopeLaunch.command,
      launchLogPath,
      sessionId: id,
      provider: sessionRuntime.provider,
      mcpLaunch: mcpPreparation.prepared,
      sandboxed: Boolean(sandboxLaunch),
    });
  } catch (error) {
    if (scopeLaunch?.unit) await stopAgentScope(scopeLaunch.unit).catch(() => {});
    await cleanupMcpCapabilityLaunch({
      backendType: config.id,
      sessionId: id,
      credentialProfile: refreshed.mcpCredentialProfile || 'agent',
      ...credentialStoreOptions(),
    });
    await cleanupPromptProfileLaunch({ backendType: config.id, sessionId: id });
    if (launchLogPath) await rm(launchLogPath, { force: true }).catch(() => {});
    // Keep <sd> (transcripts); the reviewer token does not outlive a failed launch.
    if (sandboxMode === 'nono') await rm(nonoStatePaths(config.id, id).tokenFile, { force: true }).catch(() => {});
    throw error;
  }

  sessions.set(id, {
    ...stripLegacyMcpMetadata(refreshed),
    workDir: normalizedWorkDir,
    provider: sessionRuntime.provider,
    runtime: sessionRuntime.runtime,
    model: resumedModel,
    tmuxSession: sessionName,
    launchLogPath,
    resumedAt: resumeStartedAt,
    attemptGeneration: Math.max(1, Number(refreshed.attemptGeneration || 1) + 1),
    mcpCapabilities: sanitizedMcpSnapshot(resolvedMcp, mcpPreparation.preflight),
    promptProfile: sanitizedPromptSnapshot(promptPreparation.resolved),
    ...(scopeLaunch?.unit ? {
      agentScopeUnit: scopeLaunch.unit,
      agentScopeSlice: scopeLaunch.slice,
      processIsolation: 'systemd-scope-v1',
    } : {
      agentScopeUnit: '',
      agentScopeSlice: '',
      processIsolation: 'legacy-process-tree',
    }),
    ...(hasResearchWorkbenchLaunchProfile(refreshed.metadata) ? { args: [] } : {}),
  });
  invalidateSessionCaches();
  await persistSessions();
  if (_registerSession) _registerSession(id, sessions.get(id));
  return { id, sessionName, resumed: true, cliSessionId };
}

function resolveHarnessUserText(value = '') {
  return expandSkillTokens(value);
}


function initialPromptPath(id) {
  return runtimeStatePath(`initial_prompts/${config.id}-${id}.txt`);
}

// Plugin and stdio/research MCP binaries would run inside the sandbox without grants.
function assertNonoSupported({ researchSafeRuntime, codexPlugins, serverIds }) {
  if (!['claude', 'codex'].includes(config.id) || researchSafeRuntime || codexPlugins?.add?.length
    || serverIds.some((id) => !['dueno', 'businessos'].includes(id) && remoteMcpServer(id)?.transport !== 'http')) {
    throw Object.assign(new Error('nono sandbox supports Claude and Codex sessions with HTTP MCP servers only, no added Codex plugins and no research safe runtime'), {
      statusCode: 400, code: 'sandbox_unsupported',
    });
  }
}

// Claude reads .claude.json from CLAUDE_CONFIG_DIR, so sandboxed trust goes to the private config dir.
function claudeTrustOptions(sandboxLaunch) {
  return sandboxLaunch ? { configPath: join(sandboxLaunch.env.CLAUDE_CONFIG_DIR, '.claude.json') } : {};
}

async function removeSandboxState(id) {
  const { stateDir, tokenFile } = nonoStatePaths(config.id, id);
  await Promise.all([rm(stateDir, { recursive: true, force: true }), rm(tokenFile, { force: true })]).catch(() => {});
}

function generateId() {
  return randomBytes(4).toString('hex');
}

async function loadPersistedSessions() {
  try {
    const data = await SESSION_STORE.load();
    if (Array.isArray(data)) {
      for (const s of data) {
        if (s.id && !sessions.has(s.id)) {
          sessions.set(s.id, s);
        }
      }
    }
  } catch {
    // Best effort
  }
}

let persistChain = Promise.resolve();
async function persistSessions() {
  const pending = persistChain.then(async () => {
    try {
      const data = [];
      for (const [id, meta] of sessions) {
        data.push({ id, ...meta });
      }
      await SESSION_STORE.save(data);
    } catch {
      // Best effort
    }
  });
  persistChain = pending;
  return pending;
}

async function findBinary() {
  const explicitBinary = normalizeText(config.binaryEnv ? process.env[config.binaryEnv] : '');
  if (explicitBinary) {
    if (!explicitBinary.includes('/')) {
      const { stdout, code } = await exec('which', [explicitBinary]);
      if (code === 0 && stdout.trim()) return stdout.trim();
    } else {
      const { code } = await exec('test', ['-x', explicitBinary]);
      if (code === 0) return explicitBinary;
    }
    if (config.strictBinary) {
      const error = new Error(`${config.displayName} CLI binary is not executable or not on PATH: ${explicitBinary}`);
      error.statusCode = 503;
      error.code = `${config.id}_binary_missing`;
      throw error;
    }
  }

  const binaryName = config.binaryName || config.id;
  const { stdout, code } = await exec('which', [binaryName]);
  if (code === 0 && stdout.trim()) return stdout.trim();

  const home = process.env.HOME || '/root';
  const nvmDir = process.env.NVM_DIR || `${home}/.nvm`;
  const { stdout: nodeVersion } = await exec('node', ['-v']);
  const version = nodeVersion?.trim();
  if (version) {
    const candidate = `${nvmDir}/versions/node/${version}/bin/${binaryName}`;
    const { code: checkCode } = await exec('test', ['-f', candidate]);
    if (checkCode === 0) return candidate;
  }

  const localBin = `${home}/.local/bin/${binaryName}`;
  const { code: localCode } = await exec('test', ['-f', localBin]);
  if (localCode === 0) return localBin;

  if (config.strictBinary) {
    const error = new Error(`${config.displayName} CLI binary not found; install ${binaryName} and ensure it is on PATH`);
    error.statusCode = 503;
    error.code = `${config.id}_binary_missing`;
    throw error;
  }
  return binaryName;
}

async function findCompatibleBinary() {
  if (!binaryCache.has(config.id)) {
    const binary = await findBinary();
    await config.validateBinary?.(binary);
    binaryCache.set(config.id, binary);
  }
  return binaryCache.get(config.id);
}

async function getProviderHealth() {
  try {
    const binary = await findCompatibleBinary();
    return {
      status: 'ok',
      detail: `${config.id}_runtime_ready`,
      data: config.id === 'pi'
        ? { binary, nodeVersion: process.version, minimumNodeVersion: '22.19.0', minimumPiVersion: '0.80.7' }
        : { binary },
    };
  } catch (error) {
    return {
      status: 'degraded',
      detail: error?.code || `${config.id}_runtime_unavailable`,
      data: {
        error: error?.message || `${config.displayName} runtime unavailable`,
        nodeVersion: process.version,
      },
    };
  }
}

async function tmuxSessionHasAgent(sessionName) {
  const classification = await classifyTmuxSessionByProcessTree(exec, sessionName);
  return classification.cli === config.id;
}

async function snapshotProcessRoots(rootPids) {
  return snapshotProcessTrees(rootPids);
}

async function tmuxPaneRootPids(sessionName) {
  const result = await exec('tmux', ['list-panes', '-s', '-t', sessionName, '-F', '#{pane_pid}\t#{pane_dead}']);
  const panes = result.code === 0
    ? String(result.stdout || '').split('\n').map((value) => value.trim()).filter(Boolean)
      .map((line) => {
        const [pid, dead = '0'] = line.split('\t');
        return { pid: pid.trim(), dead: dead.trim() === '1' };
      })
    : [];
  return {
    ...result,
    pids: panes.map((pane) => pane.pid).filter(Boolean),
    allDead: panes.length > 0 && panes.every((pane) => pane.dead),
  };
}

function invalidateSessionCaches() {
  discoveryCache.clear();
  stateCache.clear();
}

function parseIncludeReadOnly(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 1) return true;
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function forgetSession(id) {
  sessions.delete(id);
  lastStates.delete(id);
  lastAlertTime.delete(id);
  attentionSeq.delete(id);
  activeAttention.delete(id);
  lastAttentionStatus.delete(id);
  lastReadyAt.delete(id);
  lastBroadcastAttentionKey.delete(id);
  firstTranscriptIdleAt.delete(id);
  lastHookedStates.delete(id);
  stateCache.delete(id);
  const trackerId = canonicalSessionStateId(config.id, id);
  sessionCommandGate.unregister(trackerId);
  sessionStateTracker.remove(trackerId);
}

async function cleanupSessionArtifacts(id, meta, logger) {
  const cleanup = (path, operation) => operation.catch((error) => {
    logger.warn({ id, path, err: error.message }, 'Session artifact cleanup failed');
  });
  await Promise.all([
    cleanup(meta.workDir, removeGithubAgentScratch(meta)),
    cleanup(meta.workDir, removeSessionHookFiles({ workDir: meta.workDir, provider: config.id, sessionId: id })),
    cleanup(promptProfilePath(config.id, id), rm(promptProfilePath(config.id, id), { force: true })),
    cleanup(initialPromptPath(id), rm(initialPromptPath(id), { force: true })),
    ...(meta.launchLogPath ? [cleanup(meta.launchLogPath, rm(meta.launchLogPath, { force: true }))] : []),
    ...(meta.sandbox === 'nono' ? [removeSandboxState(id)] : []),
    ...(meta.managedWorktree && meta.worktreePath ? [cleanup(meta.worktreePath, removeAgentSessionWorktree({
      repoPath: meta.worktreeRepoPath || meta.workDir || '',
      worktreePath: meta.worktreePath,
      branch: meta.worktreeBranch || '',
      force: true,
      // GitHub agents are deleted automatically when their item closes, so keep any work they left.
      keepUnpushed: meta.source === 'github-agent',
      pullRequest: meta.metadata?.github_kind === 'pr' ? meta.metadata.github_number : 0,
    }).then((result) => {
      if (result.kept) logger.warn({ id, path: meta.worktreePath, reason: result.reason }, 'Session worktree kept');
    }))] : []),
  ]);
}

async function pruneMissingTmuxSessions(liveSessionNames, targetSessions = sessions) {
  let changed = false;
  for (const [id, meta] of targetSessions) {
    if (['bare-process', 'orphan-process'].includes(meta?.source)) continue;
    let sessionName = '';
    try {
      sessionName = resolveSessionName(id);
    } catch {
      continue;
    }
    if (!sessionName || liveSessionNames.has(sessionName)) continue;
    const confirmation = await exec('tmux', ['has-session', '-t', sessionName]);
    if (confirmation.code === 0) continue;
    if (!isTmuxMissingNamedSessionError(confirmation.stderr)) continue;
    await cleanupMcpCapabilityLaunch({
      backendType: config.id,
      sessionId: id,
      credentialProfile: meta.mcpCredentialProfile || 'agent',
      reason: 'attempt_process_ended',
      ...credentialStoreOptions(),
    });
    targetSessions.set(id, {
      ...meta,
      tmuxSession: sessionName,
      endedAt: meta.endedAt || Date.now(),
    });
    changed = true;
  }
  if (changed) {
    invalidateSessionCaches();
    if (targetSessions === sessions) await persistSessions();
  }
  return changed;
}

async function getSessionState(session, { forceRefresh = false } = {}) {
  if (!session?.tmuxSession && !session?.name) {
    const snapshot = await observeSessionEvidence(session.id, session, '', Date.now(), { lifecycle: 'running' });
    return { state: projectCanonicalState(snapshot), canonicalState: snapshot, attention: null };
  }
  const cacheKey = sessionCacheKey(session);
  const now = Date.now();
  const cached = stateCache.get(cacheKey);
  if (!forceRefresh && cached && now - cached.capturedAt < STATE_CACHE_TTL_MS) {
    const snapshot = sessionStateTracker.get(canonicalSessionStateId(config.id, session.id));
    const state = projectCanonicalState(snapshot);
    const attention = cached.state?.revision === state.revision
      ? cached.attention
      : syncAttention(session.id, session, state, cached.content || '', now);
    return { state, canonicalState: snapshot, attention, pendingResponse: state.pendingResponse ? { sentAt: state.updatedAt } : null };
  }

  try {
    const { stdout, code, stderr } = await exec('tmux', [
      'capture-pane',
      '-t',
      session.tmuxSession || session.name,
      '-p',
      '-e',
      '-S',
      `-${LIST_STATE_CAPTURE_LINES}`,
    ]);
    if (code === 0) {
      const normalized = config.stripContent(stdout);
      const snapshot = await observeSessionEvidence(session.id, session, normalized, now);
      const state = projectCanonicalState(snapshot);
      const pendingResponse = state.pendingResponse ? { sentAt: state.updatedAt } : null;
      const attention = syncAttention(session.id, session, state, normalized, now);
      stateCache.set(cacheKey, { capturedAt: now, state, attention, pendingResponse, content: normalized });
      return { state, canonicalState: snapshot, attention, pendingResponse };
    }
    if (!isTmuxMissingSessionError(stderr)) {
      const snapshot = sessionStateTracker.get(canonicalSessionStateId(config.id, session.id));
      return { state: projectCanonicalState(snapshot), canonicalState: snapshot, attention: cached?.attention || null };
    }
  } catch {
    const snapshot = sessionStateTracker.get(canonicalSessionStateId(config.id, session.id));
    return { state: projectCanonicalState(snapshot), canonicalState: snapshot, attention: cached?.attention || null };
  }

  const snapshot = await observeSessionEvidence(session.id, session, '', now, { lifecycle: 'missing' });
  return { state: projectCanonicalState(snapshot), canonicalState: snapshot, attention: null };
}

function buildEndedSessionListEntry(id, meta = {}) {
  const sessionName = meta.tmuxSession || tmuxNameFromExternalSessionId(id) || `${config.tmuxPrefix}-${id}`;
  const cliSessionId = normalizeText(meta.cliSessionId || meta.sessionId || meta.metadata?.cliSessionId);
  const observedAt = Date.now();
  const canonicalState = sessionStateTracker.observe(canonicalSessionStateId(config.id, id), [{
    source: 'process',
    kind: 'lifecycle',
    value: { lifecycle: 'missing' },
    observedAt,
    expiresAt: 0,
    fingerprint: 'process:missing',
  }, {
    source: 'runtime',
    kind: 'requested_runtime',
    value: {
      requestedModel: String(meta.model || ''),
      requestedThinkingLevel: String(meta.thinkingLevel || ''),
    },
    observedAt,
    expiresAt: 0,
    fingerprint: `requested:${String(meta.model || '')}:${String(meta.thinkingLevel || '')}`,
  }]);
  return {
    id,
    name: sessionName,
    sessionName,
    displayName: meta.displayName || '',
    tmuxSession: sessionName,
    attachCommand: buildAttachCommand(sessionName),
    created: Number(meta.created || 0),
    attached: false,
    workDir: meta.workDir || '',
    args: meta.args || [],
    provider: meta.provider || config.defaultProvider,
    runtime: meta.runtime || config.defaultRuntime,
    model: meta.model || '',
    thinkingLevel: meta.thinkingLevel || '',
    cliSessionId,
    canResume: Boolean(cliSessionId),
    resumeBlockedReason: cliSessionId ? '' : 'cli_session_id_unknown',
    source: meta.source || 'dashboard',
    readOnly: Boolean(meta.readOnly),
    externalOwner: meta.externalOwner || null,
    interactive: false,
    sessionEnded: true,
    state: projectCanonicalState(canonicalState),
    canonicalState,
    attention: null,
    controlProvenance: sessionControlProvenance(meta),
  };
}

async function discoverSessions({ includeReadOnly = true, forceRefresh = false } = {}) {
  const cacheKey = 'all';
  const now = Date.now();
  const cached = discoveryCache.get(cacheKey);
  if (!forceRefresh && cached && now - cached.fetchedAt < DISCOVERY_CACHE_TTL_MS) {
    return cached.list.map((entry) => ({ ...entry }));
  }

  const discovered = [];
  const baseline = new Map(sessions);
  const nextSessions = new Map(sessions);
  let sessionsChanged = false;

  const { stdout: tmuxOut, code: tmuxCode } = await exec('tmux', [
    'list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_attached}\t#{pane_pid}\t#{pane_current_path}',
  ]);

  const liveSessionNames = new Set();
  if (tmuxCode === 0 && tmuxOut.trim()) {
    const socketPath = await resolveTmuxSocketPath();
    const tmuxLines = tmuxOut.trim().split('\n').filter(Boolean).map((line) => {
      const [name, created, attached, panePid = '', ...pathParts] = line.split('\t');
      return { name, created, attached, panePid, paneCurrentPath: pathParts.join('\t') };
    });
    const externalRoots = new Map(tmuxLines
      .filter(({ name, panePid }) => !name.startsWith(`${config.tmuxPrefix}-`) && panePid)
      .map(({ name, panePid }) => [name, panePid]));
    const externalClassifications = await classifyProcessTrees(exec, externalRoots);

    for (const { name, created, attached, paneCurrentPath } of tmuxLines) {
      liveSessionNames.add(name);

      if (name.startsWith(`${config.tmuxPrefix}-`)) {
        const id = name.replace(`${config.tmuxPrefix}-`, '');
        const meta = nextSessions.get(id) || {};
        if (['bare-process', 'orphan-process'].includes(meta.source)) {
          meta.source = 'dashboard';
          nextSessions.set(id, meta);
          sessionsChanged = true;
        }
        let workDir = meta.workDir || paneCurrentPath || '';
        if (!workDir) {
          const { stdout: paneDir, code: paneDirCode } = await exec('tmux', [
            'display-message', '-t', name, '-p', '#{pane_current_path}',
          ]);
          if (paneDirCode === 0 && paneDir.trim()) {
            workDir = paneDir.trim();
            if (nextSessions.has(id)) {
              nextSessions.get(id).workDir = workDir;
              sessionsChanged = true;
            }
          }
        }
        discovered.push({
          id,
          name,
          displayName: meta.displayName || '',
          tmuxSession: name,
          attachCommand: buildAttachCommand(name, { socketPath }),
          created: Number(created),
          attached: Number(attached) > 0,
          workDir,
          args: meta.args || [],
          provider: meta.provider || config.defaultProvider,
          runtime: meta.runtime || config.defaultRuntime,
          cliSessionId: normalizeText(meta.cliSessionId || meta.sessionId || meta.metadata?.cliSessionId),
          source: meta.source || 'dashboard',
          controlProvenance: sessionControlProvenance(meta),
        });
        continue;
      }

      const classification = externalClassifications?.get(name)
        || await classifyTmuxSessionByProcessTree(exec, name);
      if (classification.cli === config.id) {
        const stableId = externalSessionIdFromTmuxName(name);
        let id = stableId;
        let existingMeta = nextSessions.get(stableId) || null;
        for (const [existingId, meta] of nextSessions) {
          if (existingId === stableId) continue;
          if (meta.tmuxSession === name) {
            existingMeta = { ...meta };
            nextSessions.delete(existingId);
            sessionsChanged = true;
            break;
          }
        }
        if (!nextSessions.has(id)) {
          nextSessions.set(id, {
            ...(existingMeta || {}),
            tmuxSession: name,
            source: 'tmux-external',
            created: existingMeta?.created || Number(created),
            provider: classification.provider || config.defaultProvider,
            runtime: classification.runtime || config.defaultRuntime,
            ...(isRustManagedTmuxSessionName(name) ? rustManagedSessionFields(classification.cli) : {}),
          });
          sessionsChanged = true;
        }
        const meta = nextSessions.get(id) || {};
        if (isRustManagedTmuxSessionName(name)) {
          Object.assign(meta, rustManagedSessionFields(classification.cli));
        }
        if (classification.provider && meta.provider !== classification.provider) {
          meta.provider = classification.provider;
        }
        if (classification.runtime && meta.runtime !== classification.runtime) {
          meta.runtime = classification.runtime;
        }
        nextSessions.set(id, meta);
        sessionsChanged = true;
        let workDir = meta.workDir || paneCurrentPath || '';
        if (!workDir) {
          const { stdout: paneDir, code: paneDirCode } = await exec('tmux', [
            'display-message', '-t', name, '-p', '#{pane_current_path}',
          ]);
          if (paneDirCode === 0 && paneDir.trim()) {
            workDir = paneDir.trim();
            if (nextSessions.has(id)) {
              nextSessions.get(id).workDir = workDir;
              sessionsChanged = true;
            }
          }
        }
        discovered.push({
          id,
          name,
          displayName: meta.displayName || '',
          tmuxSession: name,
          attachCommand: buildAttachCommand(name, { socketPath }),
          created: Number(created),
          attached: Number(attached) > 0,
          workDir,
          args: meta.args || [],
          provider: meta.provider || classification.provider || config.defaultProvider,
          runtime: meta.runtime || classification.runtime || config.defaultRuntime,
          cliSessionId: normalizeText(meta.cliSessionId || meta.sessionId || meta.metadata?.cliSessionId),
          source: 'tmux-external',
          readOnly: Boolean(meta.readOnly),
          externalOwner: meta.externalOwner || null,
          interactive: meta.interactive ?? true,
          controlProvenance: sessionControlProvenance(meta),
        });
      }
    }
  }
  if (tmuxCode === 0) {
    if (await pruneMissingTmuxSessions(liveSessionNames, nextSessions)) sessionsChanged = true;
  }

  const discoveredIds = new Set(discovered.map((entry) => entry.id));
  for (const [id, meta] of nextSessions) {
    if (discoveredIds.has(id)) continue;
    if (['bare-process', 'orphan-process'].includes(meta?.source)
      || (meta?.source === 'tmux-external' && meta.endedAt)) {
      nextSessions.delete(id);
      sessionsChanged = true;
      continue;
    }
    if (await refreshSessionCliMetadata(id, meta, nextSessions)) {
      sessionsChanged = true;
    }
    discovered.push(buildEndedSessionListEntry(id, nextSessions.get(id) || meta));
  }

  sessions = reconcileSessionMaps(sessions, baseline, nextSessions);
  const liveDiscovered = discovered.filter((entry) => sessions.has(entry.id));
  if (sessionsChanged) await persistSessions();
  discoveryCache.set(cacheKey, {
    fetchedAt: now,
    list: liveDiscovered.map((entry) => ({ ...entry })),
  });
  return liveDiscovered;
}

function resolveSessionName(id) {
  if (!id || typeof id !== 'string') {
    throw new SessionRequestError('Invalid session ID', 400);
  }
  const meta = sessions.get(id);
  if (meta?.tmuxSession) return meta.tmuxSession;
  const externalName = tmuxNameFromExternalSessionId(id);
  if (externalName) return externalName;
  return `${config.tmuxPrefix}-${id}`;
}

function sessionMetaForName(meta = {}, sessionName = '', cli = 'agent') {
  if (!isRustManagedTmuxSessionName(sessionName)) return meta;
  return {
    ...meta,
    ...rustManagedSessionFields(meta.runtime || cli),
    source: meta.source || 'tmux-external',
  };
}

function resolveSessionMeta(id) {
  return sessions.get(id) || {};
}

function isRustManagedReadOnlySession(meta = {}, id = '') {
  if (meta.readOnly === true && meta.externalOwner === 'rust-monitor') return true;
  try {
    return isRustManagedTmuxSessionName(resolveSessionName(id));
  } catch {
    return false;
  }
}

function requireMutableSession(id, reply) {
  const meta = resolveSessionMeta(id);
  if (isRustManagedReadOnlySession(meta, id)) {
    reply.code(403).send({ error: 'Session is rust-managed and read-only' });
    return null;
  }
  return meta;
}

function normalizeDisplayName(value) {
  return String(value || '').trim();
}

function rememberReadyAt(id, status, now) {
  const value = String(status || '');
  if (value === 'ready') {
    if (!lastReadyAt.has(id)) lastReadyAt.set(id, now);
    return;
  }
  if (value !== 'unknown') lastReadyAt.delete(id);
}

function syncAttention(id, session, state, content = '', now = Date.now()) {
  const status = String(state?.status || '');
  const previousStatus = lastAttentionStatus.get(id);
  const finishedWork = isFinishedWorkEdge(previousStatus, status);
  lastAttentionStatus.set(id, nextRememberedStatus(previousStatus, status));
  rememberReadyAt(id, status, now);

  const snippet = extractPromptReadySnippet(content);
  const existing = activeAttention.get(id);

  if (state?.capabilities?.needsAttention === true) {
    if (existing?.revision === state.revision) return existing;
    const seq = (attentionSeq.get(id) || 0) + 1;
    attentionSeq.set(id, seq);
    const attention = {
      active: true,
      key: `${id}:${seq}`,
      kind: state.interaction?.kind === 'free_text' ? 'attention' : (state.interaction?.kind || 'attention'),
      label: 'Needs Attention',
      detail: state.interaction?.detail || state.reason || snippet || 'Session needs attention',
      snippet,
      route: `/${config.id}/${id}`,
      target: session?.tmuxSession || session?.name || `${config.tmuxPrefix}-${id}`,
      createdAt: now,
      revision: state.revision,
    };
    activeAttention.set(id, attention);
    return attention;
  }

  // prompt_ready is the UI finished-work toast and *:alerts browser
  // notification. Telegram relay pages blocked interactions only.
  if (finishedWork) {
    const seq = (attentionSeq.get(id) || 0) + 1;
    attentionSeq.set(id, seq);
    const attention = {
      active: true,
      key: `${id}:${seq}`,
      kind: 'prompt_ready',
      label: 'Prompt Ready',
      detail: state.interaction?.detail || state.reason || snippet || 'Session finished work',
      snippet,
      route: `/${config.id}/${id}`,
      target: session?.tmuxSession || session?.name || `${config.tmuxPrefix}-${id}`,
      createdAt: now,
      revision: state.revision,
    };
    activeAttention.set(id, attention);
    return attention;
  }

  if (existing?.kind === 'prompt_ready' && (status === 'ready' || status === 'unknown')) {
    return existing;
  }

  activeAttention.delete(id);
  return null;
}

function sessionCreateAuditMetadata(req, body = {}) {
  const headers = req?.headers || {};
  return {
    route: req?.url || '',
    method: req?.method || '',
    ip: req?.ip || '',
    userAgent: String(headers['user-agent'] || '').slice(0, 240),
    hasWorkDir: Boolean(String(body.workDir || '').trim()),
    hasInitialPrompt: Boolean(String(body.initialPrompt || '').trim()),
    hasDisplayName: Boolean(String(body.displayName || '').trim()),
    argsCount: Array.isArray(body.args) ? body.args.length : 0,
    model: String(body.model || '').trim(),
    provider: String(body.provider || '').trim(),
    runtime: String(body.runtime || '').trim(),
    thinkingLevel: String(body.thinkingLevel || '').trim(),
  };
}

function hasSessionCreateInput(body = {}) {
  return Boolean(
    String(body.workDir || '').trim()
    || String(body.initialPrompt || '').trim()
    || String(body.displayName || '').trim()
    || String(body.model || '').trim()
    || String(body.provider || '').trim()
    || String(body.runtime || '').trim()
    || String(body.thinkingLevel || '').trim()
    || String(body.mcpProfile || '').trim()
    || String(body.promptProfile || '').trim()
    || (body.mcpServers && typeof body.mcpServers === 'object')
    || body.codexPlugins !== undefined
    || (Array.isArray(body.skills) && body.skills.length > 0)
    || (Array.isArray(body.args) && body.args.length > 0)
  );
}

function queueSessionCreateAudit({ req, body, outcome, code, detail = '', sessionId = '', sessionName = '' } = {}) {
  queueControlEvent({
    type: 'session_create',
    severity: outcome === 'failed' ? 'warning' : 'info',
    module: 'sessions',
    action: 'create_session',
    outcome,
    code,
    detail,
    message: `${config.displayName} session create ${outcome}`,
    metadata: {
      backend: config.id,
      ...sessionCreateAuditMetadata(req, body),
      sessionId,
      sessionName,
    },
  });
}

async function sessionsPlugin(app, {
  wsManager, sessionDeliveryAuditStore = null, credentialStore = null, attachmentStore = null,
}) {
  agentBusCredentialStore = credentialStore;
  const fleetAttachmentStore = attachmentStore || new AttachmentStore({
    rootDir: runtimeStatePath(`${config.id}_attachments`),
  });
  await fleetAttachmentStore.init();
  await loadPersistedSessions();
  const unregisterHookSessions = registerHookSessionRegistry(config.id, () => sessions);
  await sessionDeliveryAuditStore?.init?.();
  const interruptedTransactions = new Set();
  const recoveryEntries = sessionDeliveryAuditStore?.listAll?.({ kind: config.id })
    || sessionDeliveryAuditStore?.list?.({ kind: config.id, limit: 500 })
    || [];
  for (const entry of recoveryEntries) {
    const transactionId = String(entry.metadata?.transactionId || '');
    if (!transactionId || interruptedTransactions.has(transactionId)) continue;
    interruptedTransactions.add(transactionId);
    if (!['queued', 'sending', 'awaiting_response'].includes(entry.status)) continue;
    await recordSessionDeliveryAudit(sessionDeliveryAuditStore, {
      source: entry.source,
      kind: config.id,
      sessionId: entry.target?.sessionId,
      text: '',
      enter: entry.enter,
      status: 'dropped',
      error: 'server_restart_interrupted_transaction',
      metadata: {
        ...entry.metadata,
        recoveredFromStatus: entry.status,
        droppedAtStartup: true,
      },
    });
  }
  const scheduledSends = new Map();
  const registeredGateSessions = new Set();
  const queuedDialogFingerprints = new Set();

  function registerCommandGateSession(id) {
    const meta = resolveSessionMeta(id);
    const sessionName = resolveSessionName(id);
    const trackerId = canonicalSessionStateId(config.id, id);
    sessionCommandGate.register(trackerId, {
      refresh: async () => {
        const snapshot = await captureSessionSnapshot(id, sessionName, resolveSessionMeta(id));
        return snapshot;
      },
      execute: createTmuxCommandExecutor({
        execFn: exec,
        target: sessionName,
        delayMs: config.startupDelayMs,
        startupDelayMs: config.initialPromptDelayMs || config.startupDelayMs,
        bufferPrefix: config.bufferPrefix,
      }),
      audit: async (transition) => {
        try {
          await recordSessionDeliveryAudit(sessionDeliveryAuditStore, {
            source: transition.source,
            kind: config.id,
            sessionId: id,
            text: transition.text || '',
            enter: transition.enter,
            status: transition.state === 'completed' ? 'sent' : transition.state,
            error: transition.error || '',
            metadata: {
              ...transition.metadata,
              transactionId: transition.transactionId,
              operation: transition.operation,
              gateState: transition.state,
              ...(transition.confirmation ? { confirmation: transition.confirmation } : {}),
              at: transition.at,
            },
          });
        } catch (error) {
          app.log.warn({ id, transactionId: transition.transactionId, err: error.message }, 'Session delivery audit failed');
        }
      },
    });
    registeredGateSessions.add(trackerId);
    return trackerId;
  }

  function enqueueSessionCommand(id, input) {
    const trackerId = registerCommandGateSession(id);
    return sessionCommandGate.enqueue(trackerId, input);
  }
  _enqueueSessionCommand = enqueueSessionCommand;

  function submitSessionCommand(id, input) {
    const trackerId = registerCommandGateSession(id);
    return sessionCommandGate.submit(trackerId, input);
  }
  _submitSessionCommand = submitSessionCommand;

  function ensureDialogPolicy(id, state) {
    if (!['guardrail', 'trust', 'update'].includes(state?.interaction?.kind)) return;
    const fingerprint = String(state.interaction.fingerprint || '');
    if (!fingerprint) return;
    const trackerId = registerCommandGateSession(id);
    const key = `${trackerId}:${fingerprint}`;
    if (queuedDialogFingerprints.has(key)) return;
    queuedDialogFingerprints.add(key);
    sessionCommandGate.ensureDialogPolicy(trackerId, {
      source: `${config.id}_dialog_policy`,
      metadata: { interactionFingerprint: fingerprint },
    }).catch((error) => {
      queuedDialogFingerprints.delete(key);
      app.log.warn({ id, err: error.message }, 'Session dialog policy failed');
    });
  }
  _ensureDialogPolicy = ensureDialogPolicy;

  async function persistScheduledSends() {
    const data = [];
    for (const [sendId, entry] of scheduledSends) {
      data.push({
        sendId,
        text: entry.text,
        sendAt: entry.sendAt,
        sessionId: entry.sessionId,
        createdAt: entry.createdAt,
      });
    }
    await SCHEDULED_SEND_STORE.save(data).catch(() => {});
  }

  async function fireScheduledSend(sendId) {
    const entry = scheduledSends.get(sendId);
    if (!entry) return;
    try {
      await enqueueSessionCommand(entry.sessionId, {
        id: sendId,
        source: 'scheduled_send',
        operation: 'message',
        text: resolveHarnessUserText(entry.text),
        enter: true,
        metadata: { scheduledAt: entry.sendAt },
      });
      scheduledSends.delete(sendId);
      await persistScheduledSends();
    } catch (e) {
      app.log.warn({ sendId, sessionId: entry.sessionId, err: e.message }, 'Scheduled send failed');
    }
  }

  function scheduleSendTimer(sendId, entry) {
    const delay = Math.max(0, new Date(entry.sendAt).getTime() - Date.now());
    const timer = setTimeout(() => {
      fireScheduledSend(sendId).catch((err) => {
        app.log.warn({ sendId, err: err.message }, 'Scheduled send timer failed');
      });
    }, delay);
    timer.unref?.();
    scheduledSends.set(sendId, { ...entry, timer });
  }

  async function loadScheduledSends() {
    const data = await SCHEDULED_SEND_STORE.load().catch(() => []);
    if (!Array.isArray(data)) return;
    const now = Date.now();
    let changed = false;
    for (const entry of data) {
      const sendId = normalizeText(entry?.sendId);
      const sessionId = normalizeText(entry?.sessionId);
      const text = typeof entry?.text === 'string' ? entry.text : '';
      const sendAt = normalizeText(entry?.sendAt);
      const sendAtMs = new Date(sendAt).getTime();
      if (!sendId || !sessionId || !text || !Number.isFinite(sendAtMs)) {
        changed = true;
        continue;
      }
      if (sendAtMs <= now) {
        scheduledSends.set(sendId, { sendId, text, sendAt, sessionId, createdAt: entry.createdAt || new Date().toISOString(), timer: null });
        setTimeout(() => fireScheduledSend(sendId), 0).unref?.();
        continue;
      }
      scheduleSendTimer(sendId, { text, sendAt, sessionId, createdAt: entry.createdAt || new Date().toISOString() });
    }
    if (changed) await persistScheduledSends();
  }

  await loadScheduledSends();

  function residualProcesses(identities = []) {
    return identities.map((identity) => ({
      type: 'process',
      pid: Number(identity.pid),
      command: String(identity.cmdline || '').slice(0, 240),
    }));
  }

  async function stampedSessionProcesses(id) {
    return findProcessIdentitiesByEnvironment('DUENO_SESSION_ID', id);
  }

  async function terminateOwnedProcesses(initial, rescanFn) {
    let result = await terminateVerifiedProcesses(initial, { rescanFn });
    if (!result.ok) return result;

    let residual = await rescanFn([]);
    if (residual.length === 0) return result;
    result = await terminateVerifiedProcesses(residual, { rescanFn });
    if (!result.ok) return result;

    residual = await rescanFn([]);
    return residual.length === 0
      ? result
      : { ok: false, reason: 'processes_survived', residual: residualProcesses(residual) };
  }

  async function killTmuxSessionVerified(sessionName) {
    if (!sessionName) return { ok: true, status: 'already_gone', residual: [] };
    const killed = await exec('tmux', ['kill-session', '-t', sessionName]);
    if (killed.code !== 0 && !isTmuxMissingSessionError(killed.stderr)) {
      return {
        ok: false,
        reason: 'tmux_cleanup_failed',
        error: killed.stderr,
        residual: [{ type: 'tmux', id: sessionName }],
      };
    }
    const verified = await exec('tmux', ['has-session', '-t', sessionName]);
    if (verified.code === 0) {
      return { ok: false, reason: 'tmux_session_survived', residual: [{ type: 'tmux', id: sessionName }] };
    }
    if (!isTmuxMissingSessionError(verified.stderr)) {
      return {
        ok: false,
        reason: 'tmux_verification_failed',
        error: verified.stderr,
        residual: [{ type: 'tmux', id: sessionName }],
      };
    }
    return { ok: true, status: killed.code === 0 ? 'terminated' : 'already_gone', residual: [] };
  }

  async function terminateSessionRuntime(id, meta = null) {
    if (!meta) {
      return { ok: true, status: 'already_gone', reason: 'session_identity_absent', residual: [] };
    }
    if (meta && isRustManagedReadOnlySession(meta, id)) {
      return { ok: false, status: 'refused', reason: 'foreign_owned', residual: [] };
    }

    const recordedScope = normalizeText(meta?.agentScopeUnit);
    const expectedScope = agentScopeUnitName(config.id, id);
    if (recordedScope) {
      if (!expectedScope || recordedScope !== expectedScope) {
        return {
          ok: false,
          status: 'failed',
          reason: 'invalid_agent_scope',
          residual: [{ type: 'cgroup', id: recordedScope }],
        };
      }
    }

    if (['bare-process', 'orphan-process'].includes(meta?.source)) {
      return { ok: true, status: 'already_gone', reason: 'process_only_untracked', residual: [] };
    }

    const sessionName = String(meta?.tmuxSession || tmuxNameFromExternalSessionId(id) || '').trim();
    const exists = sessionName ? await exec('tmux', ['has-session', '-t', sessionName]) : { code: 1, stderr: 'session not found' };
    if (exists.code !== 0 && !isTmuxMissingSessionError(exists.stderr)) {
      return {
        ok: false,
        status: 'failed',
        reason: 'tmux_lookup_failed',
        error: exists.stderr,
        residual: [{ type: 'tmux', id: sessionName }],
      };
    }

    const scopeResult = recordedScope ? await stopAgentScope(recordedScope) : null;
    if (scopeResult?.ok) {
      const tmuxResult = await killTmuxSessionVerified(sessionName);
      return tmuxResult.ok
        ? { ok: true, status: 'terminated', reason: '', residual: [] }
        : { ...tmuxResult, status: 'failed' };
    }
    const stamped = await stampedSessionProcesses(id);
    let paneRoots = [];
    let allPanesDead = false;
    if (exists.code === 0) {
      const panes = await tmuxPaneRootPids(sessionName);
      if (panes.code !== 0) {
        return {
          ok: false,
          status: 'failed',
          reason: 'process_identity_unavailable',
          error: panes.stderr,
          residual: [{ type: 'tmux', id: sessionName }],
        };
      }
      paneRoots = panes.pids;
      allPanesDead = panes.allDead;
    }

    const initial = mergeProcessIdentities(await snapshotProcessRoots(paneRoots), stamped);
    if (initial.length === 0 && exists.code === 0 && !recordedScope && !allPanesDead) {
      return {
        ok: false,
        status: 'failed',
        reason: 'process_identity_unavailable',
        residual: [{ type: 'tmux', id: sessionName }],
      };
    }
    const tmuxResult = await killTmuxSessionVerified(sessionName);
    if (!tmuxResult.ok) return { ...tmuxResult, status: 'failed' };
    if (initial.length > 0) {
      const result = await terminateOwnedProcesses(initial, async (survivors) => mergeProcessIdentities(
        await snapshotProcessRoots(survivors.map((entry) => entry.pid)),
        await stampedSessionProcesses(id),
      ));
      if (!result.ok) return { ...result, status: 'failed' };
    }

    const finalStamped = await stampedSessionProcesses(id);
    if (finalStamped.length > 0) {
      return {
        ok: false,
        status: 'failed',
        reason: 'processes_survived',
        residual: residualProcesses(finalStamped),
      };
    }
    if (scopeResult && !scopeResult.ok) return { ...scopeResult, status: 'failed' };
    return {
      ok: true,
      status: exists.code === 0 || initial.length > 0 || recordedScope ? 'terminated' : 'already_gone',
      reason: exists.code === 0 ? '' : 'session_identity_absent',
      residual: [],
    };
  }

  const cleanupSession = createKeyedSingleFlight(async (id, { exitCode = 0, killTmux = true } = {}) => {
    const sessionName = resolveSessionName(id);
    const meta = sessions.get(id) || {};
    if (killTmux) {
      const result = await terminateSessionRuntime(id, meta);
      if (!result.ok) {
        const error = new Error(result.error || result.reason || `Failed to terminate ${sessionName}`);
        error.code = result.reason || 'termination_failed';
        error.statusCode = 409;
        error.residual = result.residual || [];
        throw error;
      }
    }
    let scheduledChanged = false;
    for (const [sendId, entry] of scheduledSends) {
      if (entry.sessionId === id) {
        if (entry.timer) clearTimeout(entry.timer);
        scheduledSends.delete(sendId);
        scheduledChanged = true;
      }
    }
    if (scheduledChanged) await persistScheduledSends();
    await cleanupMcpCapabilityLaunch({
      backendType: config.id,
      sessionId: id,
      credentialProfile: meta.mcpCredentialProfile || 'agent',
      reason: 'session_terminated',
      ...credentialStoreOptions(),
    }).catch((error) => {
      app.log.warn({ id, credentialProfile: meta.mcpCredentialProfile || 'agent', err: error.message }, 'Session credential cleanup failed');
      throw error;
    });
    forgetSession(id);
    invalidateSessionCaches();
    await persistSessions();
    broadcastSessionList(wsManager);
    void cleanupSessionArtifacts(id, meta, app.log).catch((error) => {
      app.log.warn({ id, path: meta.worktreePath || meta.launchLogPath, err: error.message }, 'Session artifact cleanup failed');
    });
  });

  app.get(`/api/${config.id}/sessions`, async (req) => {
    const includeReadOnly = parseIncludeReadOnly(req.query?.includeReadOnly);
    const list = await discoverSessions({ includeReadOnly });
    const sessionsWithState = await Promise.all(list.map(async (s) => {
      const { state, canonicalState, attention, pendingResponse } = await getSessionState(s);
      return { ...s, state, canonicalState, attention, pendingResponse };
    }));
    return { sessions: sessionsWithState };
  });

  app.post(`/api/${config.id}/sessions`, async (req, reply) => {
    const body = req.body || {};
    const { workDir, args, model, provider, runtime, thinkingLevel, displayName, initialPrompt, metadata, mcpProfile, mcpServers, codexPlugins, promptProfile, skills, sandbox } = body;
    const requestCoordinatorPolicy = normalizeCredentialCoordinatorPolicy(req.duenoAuth?.coordinatorPolicy);
    const principal = req.duenoAuth?.principal || null;
    const scheduledCoordinatorLaunch = principal?.type === 'service'
      && principal?.kind === 'scheduled-agent-pump'
      && requestCoordinatorPolicy;
    const loopRegistrationPolicy = operatorLoopRegistrationPolicy(principal);
    const trustedMetadata = {
      ...stripReservedCoordinatorMetadata(metadata),
      ...(scheduledCoordinatorLaunch
        ? coordinatorSessionMetadata(requestCoordinatorPolicy)
        : (principal?.type === 'agent' ? coordinatorOwnerMetadata(requestCoordinatorPolicy) : {})),
      ...loopRegistrationSessionMetadata(loopRegistrationPolicy),
    };
    queueSessionCreateAudit({
      req,
      body,
      outcome: 'requested',
      code: 'session.create.requested',
      detail: `/api/${config.id}/sessions`,
    });
    if (!hasSessionCreateInput(body)) {
      const message = 'Session create requires workDir, displayName, initialPrompt, model, runtime, thinkingLevel, provider, or args';
      queueSessionCreateAudit({
        req,
        body,
        outcome: 'failed',
        code: 'session.create.empty_request',
        detail: message,
      });
      return reply.code(400).send({ error: message });
    }

    try {
      const launchSourcePrompt = composeLaunchSourcePrompt({ skillIds: skills, initialPrompt });
      // Resolve before tmux/session creation so malformed nested launch skills
      // cannot leave an orphaned process behind.
      resolveHarnessUserText(launchSourcePrompt);
      const result = await createSession({
        sessionId: body.sessionId,
        initialPrompt: launchSourcePrompt,
        workDir,
        args,
        model,
        provider,
        runtime,
        thinkingLevel,
        source: 'dashboard',
        displayName,
        metadata: trustedMetadata,
        coordinatorPolicy: scheduledCoordinatorLaunch ? requestCoordinatorPolicy : null,
        loopRegistrationPolicy,
        mcpProfile,
        mcpServers,
        codexPlugins,
        promptProfile,
        skills,
        sandbox,
      });
      const injection = { injected: Boolean(launchSourcePrompt), error: null,
        resolution: { ...skillDeliveryResolution(launchSourcePrompt, resolveHarnessUserText(launchSourcePrompt)), channel: 'launch' } };
      broadcastSessionList(wsManager);
      queueSessionCreateAudit({
        req,
        body,
        outcome: 'succeeded',
        code: 'session.create.succeeded',
        detail: `/api/${config.id}/sessions`,
        sessionId: result.id,
        sessionName: result.sessionName,
      });
      return {
        ...result,
        initialPromptInjected: injection.injected,
        initialPromptError: injection.error,
        initialPromptDelivery: injection.resolution,
      };
    } catch (err) {
      queueSessionCreateAudit({
        req,
        body,
        outcome: 'failed',
        code: err.code || 'session.create.failed',
        detail: err.message || 'session create failed',
      });
      return reply.code(err.statusCode || 500).send({
        error: err.message,
        code: err.code || null,
      });
    }
  });

  app.post(`/api/${config.id}/sessions/:id/resume`, async (req, reply) => {
    const { id } = req.params;
    try {
      const result = await resumeSession(id, {
        loopRegistrationPolicy: operatorResumeLoopRegistrationPolicy(
          req.duenoAuth?.principal,
          sessions.get(id)?.metadata,
        ),
      });
      broadcastSessionList(wsManager);
      return result;
    } catch (err) {
      return reply.code(err.statusCode || 500).send({
        error: err.message,
        code: err.code || null,
        freshSession: err.freshSession || null,
      });
    }
  });

  app.put(`/api/${config.id}/sessions/:id`, async (req, reply) => {
    const { id } = req.params;
    if (!requireMutableSession(id, reply)) return reply;
    const meta = sessions.get(id);
    if (!meta) return reply.code(404).send({ error: `Session not found: ${id}` });

    meta.displayName = normalizeDisplayName(req.body?.displayName);
    sessions.set(id, meta);
    invalidateSessionCaches();
    await persistSessions();
    broadcastSessionList(wsManager);
    return { ok: true, id, displayName: meta.displayName };
  });

  app.get(`/api/${config.id}/sessions/:id`, async (req, reply) => {
    const { id } = req.params;
    const meta = sessions.get(id) || {};
    if (meta?.workDir && await refreshSessionCliMetadata(id, meta)) {
      await persistSessions();
    }

    if (['bare-process', 'orphan-process'].includes(meta.source)) {
      return reply.code(404).send({ error: `Session not found: ${id}` });
    }

    const sessionName = resolveSessionName(id);
    const detailMeta = sessionMetaForName(sessions.get(id) || meta, sessionName, config.id);
    const attachCommand = buildAttachCommand(sessionName, { socketPath: await resolveTmuxSocketPath() });
    const cliSessionId = normalizeText(detailMeta.cliSessionId || detailMeta.sessionId || detailMeta.metadata?.cliSessionId);
    const lines = Math.min(Math.max(parseInt(req.query?.lines) || 200, 50), 5000);
    try {
      const { content, state, canonicalState, attention, pendingResponse } = await captureSessionSnapshot(
        id,
        sessionName,
        detailMeta,
        { lines, cache: false, reuseInFlight: false },
      );
      return {
        id,
        sessionName,
        name: sessionName,
        tmuxSession: sessionName,
        attachCommand,
        displayName: detailMeta.displayName || '',
        content,
        workDir: detailMeta.workDir || '',
        args: detailMeta.args || [],
        provider: detailMeta.provider || config.defaultProvider,
        runtime: detailMeta.runtime || config.defaultRuntime,
        model: detailMeta.model || '',
        thinkingLevel: detailMeta.thinkingLevel || '',
        cliSessionId,
        canResume: Boolean(cliSessionId),
        resumeBlockedReason: cliSessionId ? '' : 'cli_session_id_unknown',
        source: detailMeta.source || 'dashboard',
        readOnly: Boolean(detailMeta.readOnly),
        externalOwner: detailMeta.externalOwner || null,
        interactive: detailMeta.interactive ?? true,
        state,
        canonicalState,
        attention,
        pendingResponse,
        lines,
        controlProvenance: sessionControlProvenance(detailMeta),
      };
    } catch (err) {
      if (err.code === 'session_not_found' || err.statusCode === 404) {
        const canonicalState = sessionStateTracker.get(canonicalSessionStateId(config.id, id));
        return {
          id,
          sessionName,
          name: sessionName,
          tmuxSession: sessionName,
          attachCommand,
          displayName: detailMeta.displayName || '',
          content: '',
          workDir: detailMeta.workDir || '',
          args: detailMeta.args || [],
          provider: detailMeta.provider || config.defaultProvider,
          runtime: detailMeta.runtime || config.defaultRuntime,
          model: detailMeta.model || '',
          thinkingLevel: detailMeta.thinkingLevel || '',
          cliSessionId,
          canResume: Boolean(cliSessionId),
          resumeBlockedReason: cliSessionId ? '' : 'cli_session_id_unknown',
          source: detailMeta.source || 'dashboard',
          readOnly: Boolean(detailMeta.readOnly),
          externalOwner: detailMeta.externalOwner || null,
          interactive: false,
          sessionEnded: true,
          error: err.message || `Session not found: ${sessionName}`,
          code: err.code || 'session_not_found',
          state: projectCanonicalState(canonicalState),
          canonicalState,
          attention: null,
          lines,
          controlProvenance: sessionControlProvenance(detailMeta),
        };
      }
      return reply.code(err.statusCode || 500).send({ error: err.message, code: err.code || null });
    }
  });

  if (config.id === 'claude') {
    app.post(`/api/${config.id}/sessions/:id/shift-tab`, async (req, reply) => {
      const { id } = req.params;
      if (!requireMutableSession(id, reply)) return reply;
      const snapshot = (await captureSessionSnapshot(
        id,
        resolveSessionName(id),
        resolveSessionMeta(id),
        { cache: false, reuseInFlight: false },
      )).canonicalState;
      try {
        const blocking = BLOCKING_INTERACTION_KINDS.has(snapshot.interaction.kind)
          && snapshot.interaction.fingerprint;
        if (blocking) {
          await authorizeInteractionRequest(
            req,
            id,
            snapshot,
            'tmux.shift_tab',
            sessionDeliveryAuditStore,
          );
        }
        return await enqueueSessionCommand(id, {
          source: 'ui_terminal_action',
          operation: blocking ? 'interaction' : 'terminal_keys',
          keys: ['BTab'],
          expectedRevision: blocking ? snapshot.revision : undefined,
          expectedFingerprint: blocking ? snapshot.interaction.fingerprint : undefined,
          expectedInteractionKind: blocking ? snapshot.interaction.kind : undefined,
        });
      } catch (error) {
        return reply.code(error.statusCode || 409).send({ error: error.message, code: error.code || null });
      }
    });
  }

  app.post(`/api/${config.id}/sessions/:id/escape`, async (req, reply) => {
    const { id } = req.params;
    if (!requireMutableSession(id, reply)) return reply;
    const snapshot = (await captureSessionSnapshot(
      id,
      resolveSessionName(id),
      resolveSessionMeta(id),
      { cache: false, reuseInFlight: false },
    )).canonicalState;
    try {
      const blocking = BLOCKING_INTERACTION_KINDS.has(snapshot.interaction.kind)
        && snapshot.interaction.fingerprint;
      if (blocking) {
        await authorizeInteractionRequest(
          req,
          id,
          snapshot,
          'tmux.escape',
          sessionDeliveryAuditStore,
        );
      }
      const operation = blocking
        ? 'interaction'
        : snapshot.capabilities.canInterrupt
          ? 'interrupt'
          : 'terminal_keys';
      return await enqueueSessionCommand(id, {
        source: 'ui_terminal_action',
        operation,
        keys: ['Escape'],
        expectedRevision: blocking ? snapshot.revision : undefined,
        expectedFingerprint: blocking ? snapshot.interaction.fingerprint : undefined,
        expectedInteractionKind: blocking ? snapshot.interaction.kind : undefined,
      });
    } catch (error) {
      return reply.code(error.statusCode || 409).send({ error: error.message, code: error.code || null });
    }
  });

  app.post(`/api/${config.id}/sessions/:id/keys`, async (req, reply) => {
    const { id } = req.params;
    if (!requireMutableSession(id, reply)) return reply;
    let { keys, expectedRevision, expectedFingerprint, expectedInteractionKind } = req.body || {};
    if (!keys) return reply.code(400).send({ error: 'Missing keys in request body' });

    try {
      const snapshot = (await captureSessionSnapshot(
        id,
        resolveSessionName(id),
        resolveSessionMeta(id),
        { cache: false, reuseInFlight: false },
      )).canonicalState;
      const liveBlocking = BLOCKING_INTERACTION_KINDS.has(snapshot.interaction.kind)
        && snapshot.interaction.fingerprint;
      if (!expectedFingerprint && liveBlocking) {
        expectedRevision = snapshot.revision;
        expectedFingerprint = snapshot.interaction.fingerprint;
        expectedInteractionKind = snapshot.interaction.kind;
      }
      if (liveBlocking || expectedFingerprint) {
        await authorizeInteractionRequest(
          req,
          id,
          snapshot,
          'tmux.keys',
          sessionDeliveryAuditStore,
        );
      }
      if (expectedInteractionKind === 'selection' && /^\d+$/.test(String(keys))) {
        const option = Number(keys);
        if (option > 0) keys = [...Array(option - 1).fill('Down'), 'Enter'].join(' ');
      }
      return await enqueueSessionCommand(id, {
        source: 'ui_dialog_key',
        operation: expectedFingerprint ? 'interaction' : 'terminal_keys',
        keys: keys.split(' '),
        expectedRevision,
        expectedFingerprint,
        expectedInteractionKind,
      });
    } catch (error) {
      return reply.code(error.statusCode || 409).send({ error: error.message, code: error.code || null });
    }
  });

  app.post(`/api/${config.id}/sessions/:id/input`, async (req, reply) => {
    const { id } = req.params;
    if (!requireMutableSession(id, reply)) return reply;
    const {
      text,
      enter,
      source = 'api',
      expectedRevision: requestedRevision,
      expectedFingerprint: requestedFingerprint,
      expectedInteractionKind: requestedInteractionKind,
      deadlineAt,
    } = req.body || {};
    try {
      const sourceText = text == null ? text : String(text);
      const resolvedText = text == null ? text : resolveHarnessUserText(text);
      const resolution = skillDeliveryResolution(sourceText, resolvedText);
      let expectedRevision = requestedRevision;
      let expectedFingerprint = requestedFingerprint;
      let expectedInteractionKind = requestedInteractionKind;
      const snapshot = (await captureSessionSnapshot(
        id,
        resolveSessionName(id),
        resolveSessionMeta(id),
        { cache: false, reuseInFlight: false },
      )).canonicalState;
      const liveBlocking = BLOCKING_INTERACTION_KINDS.has(snapshot.interaction.kind)
        && snapshot.interaction.fingerprint;
      if (!expectedFingerprint && liveBlocking) {
        expectedRevision = snapshot.revision;
        expectedFingerprint = snapshot.interaction.fingerprint;
        expectedInteractionKind = snapshot.interaction.kind;
      }
      if (liveBlocking || expectedFingerprint) {
        await authorizeInteractionRequest(
          req,
          id,
          snapshot,
          'tmux.input',
          sessionDeliveryAuditStore,
        );
      }
      if (expectedFingerprint) {
        return await enqueueSessionCommand(id, {
          source,
          operation: 'interaction',
          text: resolvedText,
          enter,
          expectedRevision,
          expectedFingerprint,
          expectedInteractionKind,
          deadlineAt,
        });
      }
      if (source === 'ui') {
        const sessionName = resolveSessionName(id);
        const result = await sendTmuxText(exec, {
          target: sessionName,
          text: resolvedText,
          enter,
          delayMs: config.startupDelayMs,
          bufferPrefix: config.bufferPrefix,
        });
        const sentAt = Date.now();
        const deliveryAudit = await recordSessionDeliveryAudit(sessionDeliveryAuditStore, {
          source,
          kind: config.id,
          sessionId: id,
          text: resolvedText,
          enter,
          status: 'sent',
        }).catch((auditError) => ({ error: auditError?.message || 'audit_write_failed' }));
        await broadcastSessionList(wsManager);
        return {
          ...result,
          sentAt,
          resolution,
          deliveryAudit: deliveryAudit?.id ? deliveryAudit : null,
          ...(deliveryAudit?.error ? { deliveryAuditError: deliveryAudit.error } : {}),
        };
      }
      const ticket = submitSessionCommand(id, {
        source,
        operation: enter === false ? 'terminal_text' : 'message',
        text: resolvedText,
        enter,
        // Telegram is an interactive operator channel. Providers such as
        // Codex can accept additional prompts while a turn is active and
        // queue them in the harness itself; do not strand those prompts in
        // Dueno waiting for an idle state that may never be observed.
        // Codex room messages steer into the running turn the same way.
        allowActiveQueue: source === 'telegram_answer' || (source === 'agent_bus' && config.id === 'codex'),
        resolveOnAwaiting: true,
        deadlineAt,
      });
      void ticket.completion
        .then(() => {
          void broadcastSessionList(wsManager).catch((error) => {
            app.log.warn({ id, transactionId: ticket.transactionId, err: error.message }, 'Completed session input broadcast failed');
          });
        })
        .catch((error) => app.log.warn({ id, transactionId: ticket.transactionId, err: error.message }, 'Queued session input failed'));
      const accepted = await ticket.accepted;
      void broadcastSessionList(wsManager).catch((error) => {
        app.log.warn({ id, transactionId: ticket.transactionId, err: error.message }, 'Queued session input broadcast failed');
      });
      reply.code(202);
      return { ...accepted, resolution };
    } catch (err) {
      return reply.code(err.statusCode || (err.code === 'command_deadline_expired' ? 409 : 400)).send({ error: err.message, code: err.code || null });
    }
  });

  app.post(`/api/${config.id}/sessions/:id/startup-input`, async (req, reply) => {
    const { id } = req.params;
    if (!requireMutableSession(id, reply)) return reply;
    const { text, enter, deadlineAt } = req.body || {};
    try {
      await waitForStartupPane(exec, resolveSessionName(id), resolveSessionMeta(id)?.launchLogPath);
      const sourceText = text == null ? text : String(text);
      const resolvedText = text == null ? text : resolveHarnessUserText(text);
      const resolution = skillDeliveryResolution(sourceText, resolvedText);
      const ticket = submitSessionCommand(id, {
        source: `${config.id}_startup_input`,
        operation: 'startup',
        text: resolvedText,
        enter,
        resolveOnAwaiting: true,
        deadlineAt,
      });
      await ticket.accepted;
      const accepted = await ticket.completion;
      reply.code(202);
      return { ...accepted, resolution };
    } catch (err) {
      const tail = await readLaunchLogTail(resolveSessionMeta(id)?.launchLogPath);
      return reply.code(409).send({
        error: isTmuxMissingSessionError(err.message) && tail ? `Agent process exited during startup:\n${tail}` : err.message,
        code: err.code || 'startup_input_failed',
      });
    }
  });

  app.post(`/api/${config.id}/sessions/:id/clear`, async (req, reply) => {
    const { id } = req.params;
    if (!requireMutableSession(id, reply)) return reply;
    try {
      const meta = resolveSessionMeta(id);
      const clearIssuedAt = Date.now();
      let before = await captureSessionSnapshot(id, resolveSessionName(id), meta);
      if (before.canonicalState.interaction.kind === 'free_text' && !before.canonicalState.capabilities.clear) {
        await sleep(25);
        before = await captureSessionSnapshot(id, resolveSessionName(id), meta);
      }
      await recordSessionRuntimeHook(id, meta, 'SessionClearRequested', {
        status: before.state.status,
        revision: before.state.revision,
        previousContentLength: before.content.length,
        clearIssuedAt,
      });
      const result = await enqueueSessionCommand(id, {
        source: `${config.id}_clear`,
        operation: 'clear',
        text: '/clear',
        enter: true,
        deadlineAt: req.body?.deadlineAt,
      });
      const confirmedAt = Date.now();
      let confirmed = await captureSessionSnapshot(id, resolveSessionName(id), meta);
      if (confirmed.canonicalState.interaction.kind === 'free_text' && !confirmed.canonicalState.capabilities.clear) {
        await sleep(25);
        confirmed = await captureSessionSnapshot(id, resolveSessionName(id), meta);
      }
      await recordSessionRuntimeHook(id, meta, 'SessionClearConfirmed', {
        status: confirmed.state.status,
        revision: confirmed.state.revision,
        confirmedContentLength: confirmed.content.length,
        clearIssuedAt,
        confirmedAt,
      });
      await recordSessionRuntimeHook(id, meta, 'SessionPromptReadyAfterClear', {
        status: confirmed.state.status,
        revision: confirmed.state.revision,
        clearIssuedAt,
        confirmedAt,
      });
      return {
        ...result,
        ok: true,
        clearConfirmed: true,
        clearIssuedAt,
        confirmedAt,
        previousContentLength: before.content.length,
        confirmedContentLength: confirmed.content.length,
        sessionState: confirmed.state.state,
        state: confirmed.state,
      };
    } catch (err) {
      const state = sessionStateTracker.get(canonicalSessionStateId(config.id, id));
      await recordSessionRuntimeHook(id, resolveSessionMeta(id), 'SessionClearRejected', {
        status: state.status,
        revision: state.revision,
        reason: state.reason,
        error: err.message,
      });
      return reply.code(err.statusCode || 409).send({
        error: err.message,
        code: err.code || null,
        safeToClear: false,
        sessionState: state.status,
        inputType: projectCompatibility(state).inputType,
        detail: state.reason,
      });
    }
  });

  app.post(`/api/${config.id}/sessions/:id/image`, async (req, reply) => {
    const { id } = req.params;
    if (!requireMutableSession(id, reply)) return reply;
    const {
      imageDataUrl, caption = '', instruction = '', filenameHint = '',
      allowCompatibilityDowngrade = false,
    } = req.body || {};
    const meta = resolveSessionMeta(id);
    try {
      const saved = await saveImageToWorkspace({
        workDir: meta.workDir || process.cwd(),
        imageDataUrl,
        sessionId: id,
        attachmentStore: fleetAttachmentStore,
        allowCompatibilityDowngrade: allowCompatibilityDowngrade === true,
        // The caption is now the whole composer draft, so it is no longer a
        // sensible filename: keep uploads on the deterministic session hint.
        filenameHint: filenameHint || `${config.id}-${id}-image`,
      });
      // The dashboard composes captions in the same skill-aware editor it uses
      // for /input, so captions must expand skill tokens on the same path.
      const prompt = buildAgentImagePrompt({
        imagePath: saved.imagePath,
        caption: resolveHarnessUserText(caption),
        instruction: resolveHarnessUserText(instruction),
      });
      await enqueueSessionCommand(id, {
        source: `${config.id}_image`,
        operation: 'message',
        text: prompt,
        enter: true,
        metadata: { imagePath: saved.imagePath, attachmentDigest: saved.digest, downgradeVisible: true },
      });
      return buildImageAttachmentResult({ ...saved, prompt });
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Scheduled/timed send
  app.post(`/api/${config.id}/sessions/:id/scheduled-send`, async (req, reply) => {
    const { id } = req.params;
    if (!requireMutableSession(id, reply)) return reply;
    const { text, delayMs, sendAt } = req.body || {};
    if (!text) return reply.code(400).send({ error: 'Missing text' });

    let delay = delayMs;
    if (!delay && sendAt) delay = Math.max(0, new Date(sendAt).getTime() - Date.now());
    if (!delay || delay < 0) return reply.code(400).send({ error: 'Missing delayMs or sendAt' });

    const sendId = `ss_${randomBytes(4).toString('hex')}`;
    const sendAtTime = new Date(Date.now() + delay).toISOString();
    const createdAt = new Date().toISOString();

    scheduleSendTimer(sendId, { text, sendAt: sendAtTime, sessionId: id, createdAt });
    await persistScheduledSends();
    return { ok: true, sendId, sendAt: sendAtTime, delayMs: delay };
  });

  app.delete(`/api/${config.id}/sessions/:id/scheduled-send/:sendId`, async (req, reply) => {
    const { id, sendId } = req.params;
    if (!requireMutableSession(id, reply)) return reply;
    const entry = scheduledSends.get(sendId);
    if (!entry) return reply.code(404).send({ error: 'Not found' });
    if (entry.sessionId !== id) return reply.code(403).send({ error: 'Send does not belong to this session' });
    if (entry.timer) clearTimeout(entry.timer);
    scheduledSends.delete(sendId);
    await persistScheduledSends();
    return { ok: true };
  });

  // Raw user/assistant transcript, read from the provider's own session log rather
  // than the tmux pane. The pane holds the CLI's *rendered* TUI output, which
  // strips LaTeX delimiters (\( -> (, \[ -> [) and consumes markdown emphasis
  // characters, so math cannot be recovered from it. The session log keeps the
  // model text verbatim.
  app.get(`/api/${config.id}/sessions/:id/transcript`, async (req, reply) => {
    const { id } = req.params;
    const meta = sessions.get(id) || {};
    const workDir = String(meta.workDir || '');
    if (!workDir) {
      return reply.code(404).send({ error: 'Session has no working directory', code: 'workdir_unknown' });
    }

    const runtime = meta.runtime || config.defaultRuntime;

    try {
      // Reuse the relay's binding resolver so this route inherits the same
      // originator/hook/identity anchors rather than re-guessing the mapping.
      const binding = await resolveBinding({ id, workDir, runtime, ...meta });
      if (!binding?.path) {
        return reply.code(404).send({
          error: 'No session log bound to this session',
          code: 'transcript_not_found',
          reason: binding?.reason || 'not_found',
        });
      }

      const filePath = binding.path;
      // The rendered view pages with `limit`; unpaged callers get the whole log.
      if (req.query?.limit) {
        return { id, runtime, filePath, ...(await readConversationPage(filePath, runtime, req.query)) };
      }
      const content = await readFile(binding.path, 'utf8');
      const text = runtime === 'codex'
        ? extractCodexConversationText(content)
        : extractClaudeConversationText(content);

      return { id, runtime, filePath, text, chars: text.length };
    } catch (error) {
      return reply.code(500).send({ error: error.message, code: 'transcript_read_failed' });
    }
  });

  app.get(`/api/${config.id}/sessions/:id/scheduled-sends`, async (req) => {
    const sends = [];
    for (const [sendId, entry] of scheduledSends) {
      if (entry.sessionId === req.params.id) {
        sends.push({ sendId, text: entry.text, sendAt: entry.sendAt, createdAt: entry.createdAt });
      }
    }
    return { sends };
  });

  app.post(`/api/${config.id}/sessions/:id/enter`, async (req, reply) => {
    const { id } = req.params;
    if (!requireMutableSession(id, reply)) return reply;
    try {
      return await enqueueSessionCommand(id, {
        source: `${config.id}_enter`,
        operation: 'message',
        text: '',
        enter: true,
      });
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.delete(`/api/${config.id}/sessions/:id`, async (req, reply) => {
    const { id } = req.params;
    if (!id || typeof id !== 'string') {
      return reply.code(400).send({ error: 'Invalid session ID', code: 'invalid_session_id' });
    }

    let meta = sessions.get(id) || null;
    if (!meta || meta.source === 'tmux-external') {
      await discoverSessions({ includeReadOnly: true, forceRefresh: true });
      meta = sessions.get(id) || null;
    }
    const terminal = async (status, reason = '') => {
      try {
        await cleanupSession(id, { exitCode: 1, killTmux: false });
      } catch (error) {
        return reply.code(error.statusCode || 409).send({
          ok: false,
          status: 'failed',
          kind: config.id,
          sessionId: id,
          residual: [],
          reason: 'cleanup_failed',
          error: error.message,
          code: error.code || 'cleanup_failed',
        });
      }
      await notifyAgentSessionDeleted({ kind: config.id, sessionId: id });
      return { ok: true, status, kind: config.id, sessionId: id, residual: [], reason };
    };
    const failed = (reason, residual = [], error = '') => reply.code(409).send({
      ok: false,
      status: 'failed',
      kind: config.id,
      sessionId: id,
      residual,
      reason,
      error: error || reason,
      code: 'termination_failed',
    });

    let result;
    try {
      result = await terminateSessionRuntime(id, meta);
    } catch (error) {
      return failed('signal_error', [], error.message);
    }
    if (!result.ok && result.status === 'refused') {
      return reply.code(403).send({
        ok: false,
        status: 'refused',
        kind: config.id,
        sessionId: id,
        residual: result.residual || [],
        reason: result.reason,
        error: 'Session is rust-managed and read-only',
        code: 'termination_refused',
      });
    }
    if (!result.ok) return failed(result.reason, result.residual, result.error);
    return terminal(result.status, result.reason);
  });

  const streamIntervals = new Map();
  const lastStreamPayloads = new Map();

  wsManager.onChannel(config.id, (socket, channel, data) => {
    const parts = channel.split(':');
    const { action } = data || {};

    if (parts.length >= 3 && parts[1] === 'session') {
      const id = parts[2];
      const sessionName = resolveSessionName(id);
      const intervalKey = channel;

      if (action === 'subscribe' && !streamIntervals.has(intervalKey)) {
        const wsLines = Math.min(Math.max(parseInt(data?.lines) || 200, 50), 5000);
        const interval = setInterval(async () => {
          const clients = wsManager.channels.get(channel);
          if (!clients || clients.size === 0) {
            clearInterval(interval);
            streamIntervals.delete(intervalKey);
            lastStreamPayloads.delete(intervalKey);
            return;
          }

          try {
            const { stdout, code, stderr } = await exec('tmux', ['capture-pane', '-t', sessionName, '-p', '-e', '-S', `-${wsLines}`]);
            if (code === 0) {
              const normalized = config.stripContent(stdout);
              const meta = resolveSessionMeta(id);
              const canonicalState = await observeSessionEvidence(id, meta, normalized);
              const state = projectCanonicalState(canonicalState);
              const pendingResponse = state.pendingResponse ? { sentAt: state.updatedAt } : null;
              const attention = syncAttention(id, { ...meta, name: sessionName, tmuxSession: sessionName }, state, normalized);
              const prev = lastStreamPayloads.get(intervalKey);
              const stateKey = `${canonicalState.revision}:${attention?.key || ''}`;
              if (!prev || prev.content !== normalized || prev.stateKey !== stateKey) {
                lastStreamPayloads.set(intervalKey, { content: normalized, stateKey });
                wsManager.broadcast(channel, 'content', { content: normalized, state, canonicalState, attention, pendingResponse });
              }
            } else {
              wsManager.broadcast(channel, 'error', { error: stderr || 'Failed to capture pane' });
              clearInterval(interval);
              streamIntervals.delete(intervalKey);
              lastStreamPayloads.delete(intervalKey);
            }
          } catch (err) {
            wsManager.broadcast(channel, 'error', { error: err.message || 'Exception during pane capture' });
            clearInterval(interval);
            streamIntervals.delete(intervalKey);
            lastStreamPayloads.delete(intervalKey);
          }
        }, 3000);

        streamIntervals.set(intervalKey, interval);
      }

      if (action === 'unsubscribe' && streamIntervals.has(intervalKey)) {
        clearInterval(streamIntervals.get(intervalKey));
        streamIntervals.delete(intervalKey);
        lastStreamPayloads.delete(intervalKey);
      }
    }
  });

  const discoverInterval = setInterval(async () => {
    try {
      const list = await discoverSessions({ includeReadOnly: true, forceRefresh: true });

      for (const s of list) {
        if (!sessions.has(s.id)) continue;
        if (['bare-process', 'orphan-process'].includes(s.source)) continue;
        try {
          const tn = s.tmuxSession || s.name;
          const { stdout, code } = await exec('tmux', ['capture-pane', '-t', tn, '-p', '-e']);
          if (code !== 0) continue;
          const now = Date.now();
          const normalized = config.stripContent(stdout);
          const canonicalState = await observeSessionEvidence(s.id, s, normalized, now);
          const state = projectCanonicalState(canonicalState);
          const pendingResponse = state.pendingResponse ? { sentAt: state.updatedAt } : null;
          const attention = syncAttention(s.id, { ...s, name: tn, tmuxSession: tn }, state, normalized, now);
          s.state = state;
          s.canonicalState = canonicalState;
          s.attention = attention;
          s.pendingResponse = pendingResponse;

          const prevState = lastStates.get(s.id);
          const autoCloseMode = String(s.autoCloseMode || sessions.get(s.id)?.autoCloseMode || 'never');
          const autoCloseAfterMs = Number(s.autoCloseAfterMs || sessions.get(s.id)?.autoCloseAfterMs || 0);
          const previousAttentionKey = lastBroadcastAttentionKey.get(s.id) || null;

          if (attention?.active && previousAttentionKey !== attention.key) {
            const lastAlert = lastAlertTime.get(s.id) || 0;
            if (now - lastAlert > 30000) {
              const alert = {
                sessionId: s.id,
                sessionName: s.displayName || s.name,
                status: state.status,
                reason: state.reason,
                revision: state.revision,
                lifecycle: state.lifecycle,
                execution: state.execution,
                interaction: state.interaction,
                capabilities: state.capabilities,
                runtime: state.runtime,
                state: state.state,
                detail: attention.detail || state.detail,
                snippet: attention.snippet || '',
                inputType: state.inputType,
                attentionKey: attention?.key || null,
                route: attention?.route || `/${config.id}/${s.id}`,
                target: attention?.target || tn,
                createdAt: attention?.createdAt || now,
              };
              wsManager.broadcast(`${config.id}:alerts`, 'alert', alert);
              void notifyPush(config, alert);
              lastAlertTime.set(s.id, now);
              lastBroadcastAttentionKey.set(s.id, attention.key);
            }
          }
          const idleSince = nextTranscriptIdleSince({
            execution: canonicalState.execution,
            executionSource: canonicalState.executionSource,
            previousIdleSince: firstTranscriptIdleAt.get(s.id) || 0,
            now,
          });
          if (idleSince) firstTranscriptIdleAt.set(s.id, idleSince);
          else firstTranscriptIdleAt.delete(s.id);
          const autoClose = shouldAutoCloseSession({
            autoCloseMode,
            autoCloseAfterMs,
            now,
            idleSince,
            execution: canonicalState.execution,
            executionSource: canonicalState.executionSource,
            lifecycle: canonicalState.lifecycle,
            paneExecution: latestPaneExecution(s.id),
          });
          if (autoClose.close) {
            await cleanupSession(s.id, { exitCode: 0, killTmux: true });
            continue;
          }
          lastStates.set(s.id, state.state);
        } catch {
          // Best effort
        }
      }

      await broadcastSessionList(wsManager, list.filter((s) => sessions.has(s.id)));
    } catch {
      // Best effort
    }
  }, PANE_OBSERVER_CADENCE_MS);

  async function broadcastSessionList(wsMgr, list) {
    if (!list) {
      list = await discoverSessions({ includeReadOnly: true });
    }
    const withState = await Promise.all(list.map(async (s) => {
      if (s.state) return s;
      const { state, canonicalState, attention, pendingResponse } = await getSessionState(s);
      return { ...s, state, canonicalState, attention, pendingResponse };
    }));
    wsMgr.broadcast(`${config.id}:sessions`, 'sessions', { sessions: withState });
  }

  _registerSession = () => {
    broadcastSessionList(wsManager);
  };

  app.addHook('onClose', async () => {
    unregisterHookSessions();
    clearInterval(discoverInterval);
    for (const interval of streamIntervals.values()) {
      clearInterval(interval);
    }
    streamIntervals.clear();
    lastStreamPayloads.clear();
    for (const entry of scheduledSends.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    for (const trackerId of registeredGateSessions) sessionCommandGate.unregister(trackerId);
    registeredGateSessions.clear();
    _ensureDialogPolicy = null;
    _enqueueSessionCommand = null;
    _submitSessionCommand = null;
    await persistSessions();
    await persistScheduledSends();
  });

  return undefined;
}

  return {
    createSession,
    plugin: sessionsPlugin,
    discoverSessions,
    getSessionState,
    getProviderHealth,
    enqueueCommand(id, input) {
      if (!_enqueueSessionCommand) throw new Error(`${config.id} session command gate is not ready`);
      return _enqueueSessionCommand(id, input);
    },
    submitCommand(id, input) {
      if (!_submitSessionCommand) throw new Error(`${config.id} session command gate is not ready`);
      return _submitSessionCommand(id, input);
    },
  };
}

const providerRegistry = new Map();

export function getAgentSessionsProvider(providerId) {
  const id = String(providerId || '').trim().toLowerCase();
  if (!providerRegistry.has(id)) {
    providerRegistry.set(id, createAgentSessionsProvider(id));
  }
  return providerRegistry.get(id);
}

export function enqueueAgentSessionCommand(providerId, sessionId, input) {
  return getAgentSessionsProvider(providerId).enqueueCommand(sessionId, input);
}

export async function createAgentSession(providerId, opts = {}) {
  return getAgentSessionsProvider(providerId).createSession(opts);
}
