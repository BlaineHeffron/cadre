import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const COORDINATOR_POLICY_METADATA_KEY = 'coordinatorControlPolicy';
export const COORDINATOR_SESSION_METADATA_KEY = 'duenoCoordinatorControl';
export const COORDINATOR_OWNER_METADATA_KEY = 'duenoCoordinatorOwner';
export const LOOP_REGISTRATION_METADATA_KEY = 'duenoLoopRegistration';
export const COORDINATOR_POLICY_VERSION = 1;
export const LOOP_REGISTRATION_POLICY_VERSION = 1;
export const COORDINATOR_SCHEDULE_PROFILE = 'coordinator-v1';
export const DEFAULT_PROTECTED_SESSION_IDS = Object.freeze([]);
export const COORDINATOR_CONTROL_TOOL_SCOPES = Object.freeze([
  'list_scheduled_agents',
  'cancel_scheduled_agent',
  'monitor_list_codex_sessions',
  'monitor_list_pi_sessions',
  'monitor_get_session_output',
  'monitor_list_threads',
  'monitor_send_to_session',
  'monitor_terminate_session',
]);

const COORDINATOR_CONTROL_TOOL_SET = new Set(COORDINATOR_CONTROL_TOOL_SCOPES);
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_COORDINATOR_REPOSITORIES = 8;
const MAX_COORDINATOR_PROJECT_ROOTS = 8;
const BLOCKING_INTERACTIONS = new Set([
  'permission',
  'trust',
  'guardrail',
  'approval',
  'confirmation',
  'selection',
]);

function text(value) {
  return String(value || '').trim();
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))];
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function policyError(message, reason = 'coordinator_policy_invalid') {
  const error = new Error(message);
  error.code = 'mcp_forbidden';
  error.reason = reason;
  error.statusCode = 403;
  return error;
}

export function operatorLoopRegistrationPolicy(principal = {}) {
  if (text(principal?.type).toLowerCase() !== 'ui') return null;
  return Object.freeze({
    version: LOOP_REGISTRATION_POLICY_VERSION,
    issuedBy: 'authenticated-operator',
    operatorKind: text(principal?.kind) || 'operator',
    operatorSessionId: text(principal?.sessionId) || 'unknown',
  });
}

export function normalizeLoopRegistrationPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Number(value.version) !== LOOP_REGISTRATION_POLICY_VERSION) return null;
  if (text(value.issuedBy) !== 'authenticated-operator') return null;
  return {
    version: LOOP_REGISTRATION_POLICY_VERSION,
    issuedBy: 'authenticated-operator',
    operatorKind: text(value.operatorKind) || 'operator',
    operatorSessionId: text(value.operatorSessionId) || 'unknown',
  };
}

export function loopRegistrationPolicyForContext(context = {}) {
  return normalizeLoopRegistrationPolicy(context?.loopRegistrationPolicy);
}

export function loopRegistrationSessionMetadata(policy) {
  const normalized = normalizeLoopRegistrationPolicy(policy);
  if (!normalized) return {};
  return { [LOOP_REGISTRATION_METADATA_KEY]: clone(normalized) };
}

export function storedLoopRegistrationPolicy(metadata = {}) {
  return normalizeLoopRegistrationPolicy(metadata?.[LOOP_REGISTRATION_METADATA_KEY]);
}

export function operatorResumeLoopRegistrationPolicy(principal, metadata = {}) {
  if (!storedLoopRegistrationPolicy(metadata)) return null;
  return operatorLoopRegistrationPolicy(principal);
}

function normalizeAbsoluteRoots(values = []) {
  const roots = uniqueStrings(values);
  if (roots.length === 0 || roots.length > MAX_COORDINATOR_PROJECT_ROOTS || roots.some((entry) => !isAbsolute(entry))) {
    throw policyError('Coordinator policy requires one to eight absolute project roots', 'coordinator_project_roots_missing');
  }
  return roots.map((entry) => resolve(entry));
}

function normalizeRepositories(source = {}) {
  const hasRepositories = Object.hasOwn(source, 'repositories');
  if (hasRepositories && !Array.isArray(source.repositories)) {
    throw policyError('Coordinator repositories must be an array', 'coordinator_repositories_invalid');
  }
  const legacyRepository = text(source.repository).toLowerCase();
  const repositories = uniqueStrings(
    (hasRepositories ? source.repositories : [legacyRepository]).map((entry) => text(entry).toLowerCase()),
  );
  if (repositories.length === 0) {
    throw policyError('Coordinator repository allowlist requires one to eight owner/repo entries', 'coordinator_repository_missing');
  }
  if (repositories.length > MAX_COORDINATOR_REPOSITORIES) {
    throw policyError('Coordinator repository allowlist requires one to eight owner/repo entries', 'coordinator_repositories_limit');
  }
  if (repositories.some((entry) => !REPOSITORY_PATTERN.test(entry))) {
    throw policyError('Coordinator repository allowlist requires one to eight owner/repo entries', 'coordinator_repository_invalid');
  }
  if (hasRepositories && legacyRepository && !repositories.includes(legacyRepository)) {
    throw policyError('Coordinator repository must be included in repositories', 'coordinator_repository_conflict');
  }
  return {
    repositories,
    repository: legacyRepository && repositories.includes(legacyRepository)
      ? legacyRepository
      : repositories[0],
  };
}

function sameRepositories(left = [], right = []) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * Resolve the only policy selector accepted for a fresh privileged coordinator.
 * The caller must pass metadata read by the server from its scheduled-task store;
 * this function must never be called on an agent request body.
 */
export function resolveScheduledCoordinatorPolicy(metadata, { scheduleId, workDir } = {}) {
  const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata[COORDINATOR_POLICY_METADATA_KEY]
    : null;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;

  const policyId = text(source.policyId);
  const normalizedScheduleId = text(scheduleId);
  const { repositories, repository } = normalizeRepositories(source);
  const taskWorkDir = text(workDir);
  if (!policyId) throw policyError('Coordinator policy ID is required', 'coordinator_policy_id_missing');
  if (!normalizedScheduleId) throw policyError('Coordinator schedule ID is required', 'coordinator_schedule_id_missing');
  if (!taskWorkDir || !isAbsolute(taskWorkDir)) {
    throw policyError('Coordinator scheduled task requires an absolute workDir', 'coordinator_workdir_missing');
  }

  const projectRoots = normalizeAbsoluteRoots(source.projectRoots);

  return Object.freeze({
    version: COORDINATOR_POLICY_VERSION,
    policyId,
    scheduleId: normalizedScheduleId,
    repository,
    repositories: Object.freeze([...repositories]),
    projectRoots: Object.freeze([...projectRoots]),
    protectedSessionIds: Object.freeze(uniqueStrings([
      ...DEFAULT_PROTECTED_SESSION_IDS,
      ...(Array.isArray(source.protectedSessionIds) ? source.protectedSessionIds : []),
    ])),
  });
}

export function scheduledCoordinatorLaunchAuthContext(metadata, { scheduleId, workDir } = {}) {
  const coordinatorPolicy = resolveScheduledCoordinatorPolicy(metadata, { scheduleId, workDir });
  if (!coordinatorPolicy) return null;
  return {
    authenticated: true,
    legacyUntrusted: false,
    principal: { type: 'service', kind: 'scheduled-agent-pump', sessionId: coordinatorPolicy.scheduleId },
    toolScopes: ['spawn_session'],
    threadAllowlist: [],
    serverAllowlist: ['dueno'],
    coordinatorPolicy,
  };
}

export function normalizeCredentialCoordinatorPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const policyId = text(value.policyId);
  const scheduleId = text(value.scheduleId);
  if (Number(value.version) !== COORDINATOR_POLICY_VERSION || !policyId || !scheduleId) return null;
  let repositories;
  let repository;
  let projectRoots;
  try {
    ({ repositories, repository } = normalizeRepositories(value));
    projectRoots = normalizeAbsoluteRoots(value.projectRoots);
  } catch {
    return null;
  }
  return {
    version: COORDINATOR_POLICY_VERSION,
    policyId,
    scheduleId,
    repository,
    repositories: Object.freeze([...repositories]),
    projectRoots,
    protectedSessionIds: uniqueStrings([
      ...DEFAULT_PROTECTED_SESSION_IDS,
      ...(Array.isArray(value.protectedSessionIds) ? value.protectedSessionIds : []),
    ]),
  };
}

export function coordinatorPolicyForContext(context = {}) {
  return normalizeCredentialCoordinatorPolicy(context?.coordinatorPolicy);
}

export function isCoordinatorControlTool(name) {
  return COORDINATOR_CONTROL_TOOL_SET.has(text(name));
}

export function coordinatorSessionMetadata(policy) {
  const normalized = normalizeCredentialCoordinatorPolicy(policy);
  if (!normalized) throw policyError('Valid coordinator policy is required', 'coordinator_policy_missing');
  return {
    [COORDINATOR_SESSION_METADATA_KEY]: {
      ...clone(normalized),
      issuedBy: 'scheduled-agent-pump',
    },
    [COORDINATOR_OWNER_METADATA_KEY]: coordinatorOwnerMetadata(normalized)[COORDINATOR_OWNER_METADATA_KEY],
  };
}

export function coordinatorOwnerMetadata(policy) {
  const normalized = normalizeCredentialCoordinatorPolicy(policy);
  if (!normalized) return {};
  return {
    [COORDINATOR_OWNER_METADATA_KEY]: {
      version: COORDINATOR_POLICY_VERSION,
      policyId: normalized.policyId,
      scheduleId: normalized.scheduleId,
      repository: normalized.repository,
      repositories: [...normalized.repositories],
      issuedBy: 'coordinator-control',
    },
  };
}

export const SPAWN_RESULT_NOTE = 'Cadre returns your final message of each turn with no background work or returnResults workers outstanding to the agent that spawned you. End your turn with your answer; do not message it separately.';

// The agent bus returns each finished turn of a spawn_session child to this authenticated spawner.
// The caller only opts in; the identity always comes from the credential.
export function spawnerMetadata(principal, metadata = {}) {
  return { spawnedBy: principal?.type === 'agent' && metadata?.returnToSpawner === true
    ? { kind: String(principal.kind), sessionId: String(principal.sessionId) } : undefined };
}

export function storedCoordinatorPolicy(metadata = {}) {
  const stored = metadata?.[COORDINATOR_SESSION_METADATA_KEY];
  if (stored?.issuedBy !== 'scheduled-agent-pump') return null;
  return normalizeCredentialCoordinatorPolicy(stored);
}

export function stripReservedCoordinatorMetadata(metadata = {}) {
  const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  const {
    [COORDINATOR_POLICY_METADATA_KEY]: _policySelector,
    [COORDINATOR_SESSION_METADATA_KEY]: _sessionPolicy,
    [COORDINATOR_OWNER_METADATA_KEY]: _owner,
    [LOOP_REGISTRATION_METADATA_KEY]: _loopRegistration,
    ...safe
  } = source;
  return safe;
}

export async function buildDelegatedScheduledAgentInput(input = {}, context = {}) {
  const delegation = loopRegistrationPolicyForContext(context);

  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (text(source.type) === 'inject') {
    return {
      type: 'inject',
      targetSession: source.targetSession ?? source.target_session,
      prompt: source.prompt,
      intervalSeconds: source.intervalSeconds ?? source.interval_seconds,
      maxIterations: source.maxIterations ?? source.max_iterations,
      metadata: {
        ...(
          text(source.metadata?.title) || text(source.metadata?.displayName)
            ? {
              ...(text(source.metadata?.title) ? { title: text(source.metadata.title) } : {}),
              ...(text(source.metadata?.displayName) ? { displayName: text(source.metadata.displayName) } : {}),
            }
            : {}
        ),
        loopRegistration: delegation ? {
          issuedBy: delegation.issuedBy,
          operatorKind: delegation.operatorKind,
          operatorSessionId: delegation.operatorSessionId,
        } : {
          issuedBy: 'fleet-session-launch',
          parentKind: text(context?.principal?.kind) || 'agent',
          parentSessionId: text(context?.principal?.sessionId) || 'unknown',
        },
      },
    };
  }
  const {
    controlProfile,
    control_profile: controlProfileAlias,
    coordinator,
    metadata: _callerMetadata,
    workDir: workDirField,
    work_dir: workDirAlias,
    prompt,
    intervalSeconds,
    interval_seconds: intervalSecondsAlias,
    provider,
    model,
    maxIterations,
    max_iterations: maxIterationsAlias,
    parentThreadId,
    parent_thread_id: parentThreadIdAlias,
    startImmediately,
    start_immediately: startImmediatelyAlias,
    mcpProfile: selectedProfileField,
    mcpServers: selectedServers,
  } = source;
  const profile = text(controlProfile ?? controlProfileAlias);
  const workDir = text(workDirField ?? workDirAlias);
  const selectedProfile = text(selectedProfileField);
  if (!delegation) {
    if (profile) {
      throw policyError('Operator delegation is required to register spawn schedules', 'loop_registration_delegation_missing');
    }
    return delegatedScheduleFields({
      workDir,
      prompt,
      intervalSeconds: intervalSeconds ?? intervalSecondsAlias,
      provider,
      model,
      maxIterations: maxIterations ?? maxIterationsAlias,
      parentThreadId: parentThreadId ?? parentThreadIdAlias,
      startImmediately: startImmediately ?? startImmediatelyAlias,
      mcpProfile: selectedProfileField,
      mcpServers: selectedServers,
      metadata: {
        loopRegistration: {
          issuedBy: 'fleet-session-launch',
          parentKind: text(context?.principal?.kind) || 'agent',
          parentSessionId: text(context?.principal?.sessionId) || 'unknown',
        },
      },
    });
  }
  if ((selectedProfile && selectedProfile !== 'dueno')
    || selectedServers?.remove?.length
    || (Array.isArray(selectedServers?.add) && selectedServers.add.some((id) => id !== 'dueno'))) {
    throw policyError('Delegated schedules may use only the dueno MCP profile', 'loop_registration_mcp_selection_denied');
  }
  const registrationMetadata = {
    issuedBy: delegation.issuedBy,
    operatorKind: delegation.operatorKind,
    operatorSessionId: delegation.operatorSessionId,
  };
  if (!profile) {
    const ordinaryPolicy = {
      version: COORDINATOR_POLICY_VERSION,
      policyId: 'delegated-workdir-validation',
      scheduleId: 'delegated-registration',
      repository: 'dueno/delegated',
      repositories: ['dueno/delegated'],
      projectRoots: [workDir],
      protectedSessionIds: [],
    };
    const canonicalWorkDir = await assertCoordinatorPath(ordinaryPolicy, workDir, 'scheduled workDir');
    return delegatedScheduleFields({
      workDir: canonicalWorkDir,
      prompt,
      intervalSeconds: intervalSeconds ?? intervalSecondsAlias,
      provider,
      model,
      maxIterations: maxIterations ?? maxIterationsAlias,
      parentThreadId: parentThreadId ?? parentThreadIdAlias,
      startImmediately: startImmediately ?? startImmediatelyAlias,
      metadata: { loopRegistration: registrationMetadata },
    });
  }
  if (profile !== COORDINATOR_SCHEDULE_PROFILE) {
    throw policyError('Unknown scheduled-agent control profile', 'loop_registration_profile_invalid');
  }
  if (!coordinator || typeof coordinator !== 'object' || Array.isArray(coordinator)) {
    throw policyError('Coordinator control profile requires coordinator settings', 'loop_registration_coordinator_missing');
  }

  const resolved = resolveScheduledCoordinatorPolicy({
    [COORDINATOR_POLICY_METADATA_KEY]: coordinator,
  }, { scheduleId: 'delegated-registration', workDir });
  const projectRoots = [];
  for (const root of resolved.projectRoots) {
    projectRoots.push(await assertCoordinatorPath(resolved, root, 'coordinator.projectRoots'));
  }
  const canonicalWorkDir = await assertCoordinatorPath({ ...resolved, projectRoots }, workDir, 'scheduled workDir');

  return delegatedScheduleFields({
    workDir: canonicalWorkDir,
    prompt,
    intervalSeconds: intervalSeconds ?? intervalSecondsAlias,
    provider,
    model,
    maxIterations: maxIterations ?? maxIterationsAlias,
    parentThreadId: parentThreadId ?? parentThreadIdAlias,
    startImmediately: startImmediately ?? startImmediatelyAlias,
    metadata: {
      [COORDINATOR_POLICY_METADATA_KEY]: {
        policyId: resolved.policyId,
        repository: resolved.repository,
        repositories: [...resolved.repositories],
        projectRoots,
        protectedSessionIds: [...resolved.protectedSessionIds],
      },
      loopRegistration: registrationMetadata,
    },
  });
}

function delegatedScheduleFields({
  workDir,
  prompt,
  intervalSeconds,
  provider,
  model,
  maxIterations,
  parentThreadId,
  startImmediately,
  mcpProfile = 'dueno',
  mcpServers = { add: ['dueno'], remove: [] },
  metadata,
}) {
  return {
    workDir,
    prompt,
    ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(parentThreadId !== undefined ? { parentThreadId } : {}),
    ...(startImmediately !== undefined ? { startImmediately } : {}),
    mcpProfile,
    mcpServers,
    metadata,
  };
}

export function sessionControlProvenance(meta = {}) {
  const owner = meta.metadata?.[COORDINATOR_OWNER_METADATA_KEY];
  let trustedOwner = null;
  if (owner?.issuedBy === 'coordinator-control'
    && Number(owner.version) === COORDINATOR_POLICY_VERSION
    && text(owner.policyId)
    && text(owner.scheduleId)) {
    try {
      const normalizedOwner = normalizeRepositories(owner);
      trustedOwner = {
        policyId: text(owner.policyId),
        scheduleId: text(owner.scheduleId),
        repository: normalizedOwner.repository,
        repositories: normalizedOwner.repositories,
      };
    } catch {
      trustedOwner = null;
    }
  }
  const github = meta.source === 'github-agent'
    && text(meta.metadata?.github_repo)
    && ['pr', 'issue'].includes(text(meta.metadata?.github_kind).toLowerCase())
    && Number.isInteger(Number(meta.metadata?.github_number))
    && Number(meta.metadata?.github_number) > 0
    ? {
        repository: text(meta.metadata.github_repo).toLowerCase(),
        kind: text(meta.metadata.github_kind).toLowerCase(),
        number: Number(meta.metadata.github_number),
      }
    : null;
  const coordinatorSession = meta.metadata?.[COORDINATOR_SESSION_METADATA_KEY]?.issuedBy === 'scheduled-agent-pump'
    && Boolean(normalizeCredentialCoordinatorPolicy(meta.metadata[COORDINATOR_SESSION_METADATA_KEY]));
  return {
    protected: meta.protected === true || meta.metadata?.protected === true,
    coordinatorSession,
    coordinatorOwner: trustedOwner,
    github,
  };
}

export function pathWithinRoot(candidate, root) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function pathContainsSymlink(absolutePath) {
  const parsed = resolve(absolutePath);
  const parts = parsed.split(sep).filter(Boolean);
  let cursor = sep;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}

export async function assertCoordinatorPath(policy, value, label = 'path') {
  const normalizedPolicy = normalizeCredentialCoordinatorPolicy(policy);
  const raw = text(value);
  if (!normalizedPolicy) throw policyError('Coordinator policy is missing or invalid', 'coordinator_policy_missing');
  if (!raw || !isAbsolute(raw)) throw policyError(`${label} must be an absolute path`, 'coordinator_target_path_missing');
  if (raw.split(/[\\/]+/).includes('..')) throw policyError(`${label} may not contain parent traversal`, 'coordinator_target_path_traversal');
  if (await pathContainsSymlink(raw).catch(() => true)) {
    throw policyError(`${label} must not traverse a symbolic link`, 'coordinator_target_path_symlink');
  }
  const canonical = await realpath(raw).catch(() => '');
  if (!canonical) throw policyError(`${label} does not resolve to an existing path`, 'coordinator_target_path_missing');
  if (canonical.split(sep).some((part) => part === 'cadre-live' || part === 'dueno-fleet-live')) {
    throw policyError(`${label} may not target the live deployment checkout`, 'coordinator_live_checkout_denied');
  }
  if (!normalizedPolicy.projectRoots.some((root) => pathWithinRoot(canonical, root))) {
    throw policyError(`${label} is outside coordinator project roots`, 'coordinator_cross_project_denied');
  }
  return canonical;
}

export function assertCoordinatorSessionTarget(policy, session, {
  operation = 'read',
  requireFinished = false,
} = {}) {
  const normalized = normalizeCredentialCoordinatorPolicy(policy);
  const sessionId = text(session?.id || session?.sessionId);
  if (!normalized) throw policyError('Coordinator policy is missing or invalid', 'coordinator_policy_missing');
  if (!sessionId) throw policyError('Coordinator target session identity is missing', 'coordinator_target_identity_missing');
  if (normalized.protectedSessionIds.includes(sessionId) || session?.controlProvenance?.protected === true) {
    throw policyError('Protected sessions cannot be controlled by coordinators', 'coordinator_protected_session_denied');
  }

  const owner = session?.controlProvenance?.coordinatorOwner;
  const github = session?.controlProvenance?.github;
  const owned = owner?.policyId === normalized.policyId
    && owner?.scheduleId === normalized.scheduleId
    && sameRepositories(owner?.repositories || [owner?.repository], normalized.repositories);
  const matchingGithub = normalized.repositories.includes(github?.repository)
    && ['pr', 'issue'].includes(github?.kind)
    && Number(github?.number) > 0;
  if (!owned && !matchingGithub) {
    throw policyError('Session is not owned by this coordinator or its configured GitHub repository', 'coordinator_session_not_owned');
  }

  const interactionKind = text(session?.state?.interaction?.kind || session?.canonicalState?.interaction?.kind).toLowerCase();
  if (operation === 'prompt' && BLOCKING_INTERACTIONS.has(interactionKind)) {
    throw policyError('Coordinator prompts cannot answer blocking interactions', 'coordinator_interaction_authority_denied');
  }

  if (requireFinished) {
    const lifecycle = text(session?.state?.lifecycle || session?.canonicalState?.lifecycle).toLowerCase();
    const finished = session?.sessionEnded === true || ['ended', 'missing'].includes(lifecycle);
    if (!owned || !finished) {
      throw policyError('Coordinator may terminate only finished sessions owned by its schedule', 'coordinator_session_not_finished_owned');
    }
  }

  return { owned, matchingGithub, sessionId };
}

export function sessionVisibleToCoordinator(policy, session, options = {}) {
  try {
    assertCoordinatorSessionTarget(policy, session, options);
    return true;
  } catch {
    return false;
  }
}

export function filterCoordinatorSessions(policy, sessions = []) {
  return (Array.isArray(sessions) ? sessions : []).filter((session) => (
    sessionVisibleToCoordinator(policy, session, { operation: 'read' })
  ));
}

export function filterCoordinatorSchedules(policy, tasks = []) {
  const normalized = normalizeCredentialCoordinatorPolicy(policy);
  if (!normalized) return [];
  return (Array.isArray(tasks) ? tasks : []).filter((task) => text(task?.id) === normalized.scheduleId);
}

export function threadVisibleToCoordinator(policy, thread = {}) {
  const normalized = normalizeCredentialCoordinatorPolicy(policy);
  if (!normalized) return false;
  const owner = thread?.metadata?.[COORDINATOR_OWNER_METADATA_KEY] || thread?.controlProvenance?.coordinatorOwner;
  if (owner?.issuedBy === 'coordinator-control'
    && text(owner.policyId) === normalized.policyId
    && text(owner.scheduleId) === normalized.scheduleId
  ) {
    try {
      if (sameRepositories(normalizeRepositories(owner).repositories, normalized.repositories)) return true;
    } catch {
      // Invalid owner provenance is not trusted; project-root checks still apply.
    }
  }
  const projectKey = text(thread?.projectKey);
  if (!projectKey || !isAbsolute(projectKey) || projectKey.split(/[\\/]+/).includes('..')) return false;
  return normalized.projectRoots.some((root) => pathWithinRoot(projectKey, root));
}

export function filterCoordinatorThreads(policy, threads = []) {
  return (Array.isArray(threads) ? threads : []).filter((thread) => threadVisibleToCoordinator(policy, thread));
}

export async function assertCoordinatorOptionalPath(policy, value, label = 'path') {
  if (!text(value)) return null;
  return assertCoordinatorPath(policy, value, label);
}

export function coordinatorAuditTarget(tool, args = {}) {
  const name = text(tool);
  if (name === 'cancel_scheduled_agent') return text(args.id) || 'missing';
  if (name === 'spawn_loop_session') return `${text(args.kind) || 'unknown'}:${text(args.session_id) || 'missing'}`;
  if (name === 'monitor_send_to_session' || name === 'monitor_get_session_output') {
    return `${text(args.type) || 'unknown'}:${text(args.sessionId) || 'missing'}`;
  }
  if (name === 'monitor_terminate_session') return text(args.session_id) || 'missing';
  if (name === 'register_scheduled_agent') return text(args.workDir || args.work_dir) || 'missing';
  return name;
}
