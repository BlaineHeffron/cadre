import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { config } from '../../config.mjs';
import { exec } from '../../lib/exec.mjs';
import { buildInternalBypassHeaders } from '../platform/auth.mjs';
import { resolveAgentProviderSelection } from '../agent/provider-interface.mjs';
import { createAgentSession } from '../sessions/index.mjs';
import { buildFleetIncidentStore } from './incidents.mjs';
import { buildFleetDeploymentNotifier } from './deployment-notifier.mjs';
import { FleetPoller } from './poller.mjs';
import { loadFleetRegistry } from './registry.mjs';
import { createInvestigationWorktree, reapWorktrees } from './git-worktree.mjs';

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeStatus(value) {
  const status = normalizeText(value).toLowerCase();
  return ['open', 'ack', 'resolved'].includes(status) ? status : '';
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expandHomePath(value = '') {
  const text = normalizeText(value);
  if (!text) return '';
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return resolve(homedir(), text.slice(2));
  return text;
}

function sanitizedErrorCode(error) {
  const code = normalizeText(error?.code || '').toLowerCase();
  if (code.startsWith('fleet_registry_')) return code;
  if (code.includes('enoent')) return 'registry_missing';
  if (code.includes('json')) return 'registry_invalid_json';
  return 'registry_load_failed';
}

function safeSnapshot(snapshot = null) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    deploymentId: normalizeText(snapshot.deploymentId),
    displayName: normalizeText(snapshot.displayName || '') || null,
    buildSha: normalizeText(snapshot.buildSha || snapshot.build_sha || '') || null,
    status: normalizeText(snapshot.status || 'unknown').toLowerCase() || 'unknown',
    markers: Array.isArray(snapshot.markers) ? snapshot.markers.map(normalizeText).filter(Boolean) : [],
    reachable: snapshot.reachable !== false,
    lastPollMs: Number.isFinite(Number(snapshot.lastPollMs)) ? Number(snapshot.lastPollMs) : null,
    error: normalizeText(snapshot.error || '') || null,
    debugCounts: snapshot.debugCounts && typeof snapshot.debugCounts === 'object' ? clone(snapshot.debugCounts) : null,
  };
}

function safeDeployment(deployment = {}, snapshot = null) {
  return {
    deploymentId: normalizeText(deployment.deploymentId),
    profile: normalizeText(deployment.profile),
    environment: normalizeText(deployment.environment),
    baseUrl: normalizeText(deployment.baseUrl || '') || null,
    healthContract: normalizeText(deployment.healthContract),
    enabledModules: Array.isArray(deployment.enabledModules)
      ? deployment.enabledModules.map(normalizeText).filter(Boolean)
      : [],
    pollingIntervalSeconds: Number(deployment.pollingIntervalSeconds || 0) || null,
    debugFetchOnDegraded: deployment.debugFetchOnDegraded !== false,
    latestSnapshot: safeSnapshot(snapshot),
  };
}

function safeIncident(incident = null) {
  if (!incident || typeof incident !== 'object') return null;
  return {
    id: normalizeText(incident.id),
    deploymentId: normalizeText(incident.deploymentId),
    status: normalizeText(incident.status),
    markers: Array.isArray(incident.markers) ? incident.markers.map(normalizeText).filter(Boolean) : [],
    markerHistory: Array.isArray(incident.markerHistory)
      ? incident.markerHistory.map((entry) => ({
        marker: normalizeText(entry?.marker),
        firstSeenMs: Number(entry?.firstSeenMs || 0) || 0,
        lastSeenMs: Number(entry?.lastSeenMs || 0) || 0,
      })).filter((entry) => entry.marker)
      : [],
    openedAtMs: Number(incident.openedAtMs || 0) || null,
    updatedAtMs: Number(incident.updatedAtMs || 0) || null,
    resolvedAtMs: Number(incident.resolvedAtMs || 0) || null,
    occurrenceCount: Number(incident.occurrenceCount || 0),
    evidenceRef: normalizeText(incident.evidenceRef || '') || null,
    lastInvestigationSessionId: normalizeText(incident.lastInvestigationSessionId || '') || null,
    investigationSessionIds: Array.isArray(incident.investigationSessionIds)
      ? incident.investigationSessionIds.map(normalizeText).filter(Boolean)
      : [],
  };
}

function safeEvidence(evidence = null) {
  if (!evidence || typeof evidence !== 'object') return null;
  return {
    incidentId: normalizeText(evidence.incidentId),
    deploymentId: normalizeText(evidence.deploymentId),
    capturedAtMs: Number(evidence.capturedAtMs || 0) || null,
    healthSnapshot: safeSnapshot(evidence.healthSnapshot),
    debugCounts: evidence.debugCounts && typeof evidence.debugCounts === 'object' ? clone(evidence.debugCounts) : null,
  };
}

function safeEvents(events = []) {
  return (Array.isArray(events) ? events : []).map((event) => ({
    type: normalizeText(event?.type),
    incidentId: normalizeText(event?.incidentId),
    deploymentId: normalizeText(event?.deploymentId),
  })).filter((event) => event.type);
}

function histogramBlock(title, values = {}) {
  const entries = values && typeof values === 'object' ? Object.entries(values) : [];
  if (entries.length === 0) return `- ${title}: none`;
  return [`- ${title}:`, ...entries.map(([key, count]) => `  - ${normalizeText(key)}: ${Number(count || 0)}`)].join('\n');
}

function debugGroupBlock(groups = []) {
  const safeGroups = Array.isArray(groups) ? groups.slice(0, 12) : [];
  if (safeGroups.length === 0) return '- groups: none';
  return [
    '- groups:',
    ...safeGroups.map((group) => [
      `  - id: ${normalizeText(group?.id) || 'unknown'}`,
      `    dismissKey: ${normalizeText(group?.dismissKey || group?.id) || 'unknown'}`,
      `    count: ${Number(group?.count || 0)}`,
      `    source: ${normalizeText(group?.source || '') || 'unknown'}`,
      `    severity: ${normalizeText(group?.severity || '') || 'unknown'}`,
      `    category: ${normalizeText(group?.category || '') || 'unknown'}`,
      `    errorCode: ${normalizeText(group?.errorCode || '') || 'unknown'}`,
      `    messageHash: ${normalizeText(group?.messageHash || '') || 'none'}`,
      `    bucketMs: ${Number(group?.bucketMs || 0)}`,
    ].join('\n')),
  ].join('\n');
}

function configuredRepoPath(repoPaths = {}, deploymentId = '') {
  const entry = repoPaths && typeof repoPaths === 'object' ? repoPaths[deploymentId] : null;
  if (!entry || typeof entry !== 'object') return null;
  const primary = normalizeText(entry.primary);
  const companions = Array.isArray(entry.companions)
    ? entry.companions.map(normalizeText).filter(Boolean)
    : [];
  return primary ? { primary, companions } : null;
}

function configuredPrimaryRepoPaths(repoPaths = {}) {
  if (!repoPaths || typeof repoPaths !== 'object') return [];
  return [...new Set(Object.values(repoPaths)
    .map((entry) => normalizeText(entry?.primary))
    .filter(Boolean))];
}

export function buildFleetInvestigationPrompt({
  incident = {},
  evidence = {},
  deployment = {},
  repoContext = null,
} = {}) {
  const health = evidence?.healthSnapshot || {};
  const debugCounts = evidence?.debugCounts || {};
  const markers = Array.isArray(incident.markers) ? incident.markers : [];
  const openedAt = Number(incident.openedAtMs || 0)
    ? new Date(Number(incident.openedAtMs)).toISOString()
    : 'unknown';
  return [
    'Fleet incident investigation request.',
    '',
    'Scope:',
    `- deploymentId: ${normalizeText(incident.deploymentId)}`,
    `- displayName: ${normalizeText(health.displayName || deployment.displayName || '') || 'unknown'}`,
    `- environment: ${normalizeText(deployment.environment || '') || 'unknown'}`,
    `- baseUrl: ${normalizeText(deployment.baseUrl || '') || 'unknown'}`,
    `- openedAt: ${openedAt}`,
    `- currentStatus: ${normalizeText(incident.status || '') || 'unknown'}`,
    `- currentMarkers: ${markers.length ? markers.map(normalizeText).join(', ') : 'none'}`,
    `- occurrenceCount: ${Number(incident.occurrenceCount || 0)}`,
    '',
    'Code context:',
    repoContext?.worktreePath
      ? `- repoWorktree: ${normalizeText(repoContext.worktreePath)}`
      : '- repoWorktree: scratch/no configured repository',
    repoContext?.repoPath ? `- sourceRepo: ${normalizeText(repoContext.repoPath)}` : '- sourceRepo: none',
    repoContext?.sourceBranch ? `- sourceBranch: ${normalizeText(repoContext.sourceBranch)}` : '- sourceBranch: unknown',
    repoContext?.sourceHead ? `- sourceHead: ${normalizeText(repoContext.sourceHead)}` : '- sourceHead: unknown',
    repoContext?.branch ? `- worktreeBranch: ${normalizeText(repoContext.branch)}` : '- worktreeBranch: none',
    repoContext?.fallbackReason ? `- repoFallbackReason: ${normalizeText(repoContext.fallbackReason)}` : '- repoFallbackReason: none',
    Array.isArray(repoContext?.companions) && repoContext.companions.length
      ? `- relatedReposReadOnly: ${repoContext.companions.map(normalizeText).join(', ')}`
      : '- relatedReposReadOnly: none',
    '',
    'Debug counts, safe histograms only:',
    `- total: ${Number(debugCounts.total || 0)}`,
    `- capped: ${debugCounts.capped === true}`,
    `- unavailable: ${normalizeText(debugCounts.unavailable || '') || 'none'}`,
    histogramBlock('bySource', debugCounts.bySource),
    histogramBlock('bySeverity', debugCounts.bySeverity),
    histogramBlock('byCategory', debugCounts.byCategory),
    histogramBlock('byErrorCode', debugCounts.byErrorCode),
    debugGroupBlock(debugCounts.debugGroups),
    '',
    'Safety rules:',
    '- Raw backtraces and raw provider error text are not included in this prompt.',
    '- /api/debug may be disabled for this deployment.',
    '- Deeper evidence must be fetched through the authenticated fleet evidence endpoint.',
    `- Evidence endpoint: /api/fleet/incidents/${normalizeText(incident.id)}/evidence`,
    '- Read and analyze first. Do not auto-commit, push, open PRs, or deploy from this investigation.',
    '- Any BusinessOS, provider, or system mutation requires explicit human approval before execution.',
    '- Stay scoped to this deployment and incident.',
  ].join('\n');
}

async function resolveInvestigationWorkDir(baseDir, incidentId) {
  const base = expandHomePath(baseDir || '~/.dueno-fleet/investigations');
  const dir = resolve(base, normalizeText(incidentId) || 'incident');
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function defaultSessionLauncher({
  prompt,
  workDir,
  displayName,
  provider,
  model,
  thinkingLevel,
  metadata,
  mcpProfile,
  mcpServers,
  source = 'fleet-investigation',
} = {}) {
  const selection = resolveAgentProviderSelection({
    provider: provider || 'codex',
    model,
    fallbackProvider: 'codex',
  });
  const args = normalizeText(prompt) ? [prompt] : [];
  const result = await createAgentSession(selection.backendType, {
    workDir,
    args,
    displayName,
    model: selection.model,
    provider: selection.backendProvider,
    runtime: selection.runtime,
    thinkingLevel,
    source,
    metadata,
    ...(mcpProfile !== undefined ? { mcpProfile } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
  });
  return {
    ...result,
    provider: selection.provider,
    backendType: selection.backendType,
    runtime: selection.runtime,
  };
}

export async function fleetPlugin(app, opts = {}) {
  const sourceConfig = opts.config || config.fleet || {};
  const wsManager = opts.wsManager || null;
  const loadRegistryImpl = opts.loadRegistryImpl || loadFleetRegistry;
  const latestSnapshots = opts.latestSnapshots || new Map();
  const sessionLauncher = opts.sessionLauncher || defaultSessionLauncher;
  const createWorktree = opts.createWorktree || createInvestigationWorktree;
  const reapWorktreesImpl = opts.reapWorktreesImpl || reapWorktrees;
  const log = opts.log || app.log;

  let registry = { schemaVersion: 1, deployments: [] };
  try {
    registry = opts.registry || await loadRegistryImpl({
      registryPath: sourceConfig.registryPath,
      registryInlineJson: sourceConfig.registryInlineJson,
      remoteRefsEnabled: sourceConfig.remoteRefsEnabled,
      privateHostAllowedRef: sourceConfig.privateHostAllowedRef,
      env: opts.env || process.env,
    });
  } catch (error) {
    log.warn({ code: sanitizedErrorCode(error) }, 'Fleet registry unavailable; starting with zero deployments');
  }

  const incidentStore = opts.incidentStore || buildFleetIncidentStore({
    healthyPollsToResolve: sourceConfig.healthyPollsToResolve,
    env: opts.env || process.env,
  });
  const agentTaskRunner = opts.agentTaskRunner || (async (body) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/tasks',
      headers: buildInternalBypassHeaders(),
      payload: body,
    });
    const payload = response.body ? JSON.parse(response.body) : {};
    if (response.statusCode >= 400) {
      const error = new Error(payload.error || 'agent_task_failed');
      error.statusCode = response.statusCode;
      throw error;
    }
    return payload;
  });
  const deploymentNotifyEnabled = sourceConfig.deploymentNotifyEnabled === true;
  const deploymentNotifier = opts.deploymentNotifier || buildFleetDeploymentNotifier({
    enabled: deploymentNotifyEnabled,
    stateStore: opts.deploymentNotifyStateStore,
    fetchImpl: opts.fetchImpl || globalThis.fetch,
    agentTaskRunner,
    execImpl: opts.execImpl || exec,
    log,
    now: opts.now || (() => Date.now()),
    repoPath: sourceConfig.deploymentNotifyBusinessOsRepoPath,
    webhookPath: sourceConfig.deploymentNotifyWebhookPath,
    provider: sourceConfig.deploymentNotifyProvider,
    model: sourceConfig.deploymentNotifyModel,
    thinkingLevel: sourceConfig.deploymentNotifyThinkingLevel,
    agentTimeoutMs: sourceConfig.deploymentNotifyAgentTimeoutMs,
    gitTimeoutMs: sourceConfig.deploymentNotifyGitTimeoutMs,
  });

  async function handleSnapshot(result) {
    const snapshot = safeSnapshot(result);
    if (!snapshot?.deploymentId) return null;
    latestSnapshots.set(snapshot.deploymentId, snapshot);
    const transition = await incidentStore.applyPollResult(snapshot);
    const payload = {
      snapshot,
      incident: safeIncident(transition.incident),
      events: safeEvents(transition.events),
    };
    if (wsManager && typeof wsManager.broadcast === 'function') {
      wsManager.broadcast('fleet:snapshot', 'snapshot', payload);
    }
    if (deploymentNotifyEnabled) {
      const deployment = registry.deployments.find((item) => item.deploymentId === snapshot.deploymentId) || {};
      void deploymentNotifier.observeDeploymentBuild({ deployment, snapshot }).catch((error) => {
        log.warn({
          deploymentId: snapshot.deploymentId,
          code: normalizeText(error?.code || error?.message || 'release_note_notify_failed') || 'release_note_notify_failed',
        }, 'Fleet release note notification failed');
      });
    }
    return payload;
  }

  const poller = opts.poller || new FleetPoller({
    registry,
    fetchImpl: opts.fetchImpl || globalThis.fetch,
    now: opts.now || (() => Date.now()),
    timeoutMs: opts.timeoutMs,
    onSnapshot: handleSnapshot,
    beforePoll: async () => {
      if (sourceConfig.investigationWorktreeReapEnabled !== true) return;
      await reapWorktreesImpl({
        enabled: true,
        sourceRepos: configuredPrimaryRepoPaths(sourceConfig.repoPaths),
        baseDirs: [expandHomePath(sourceConfig.investigationWorkDir || '~/.dueno-fleet/investigations')],
        minAgeSec: sourceConfig.investigationWorktreeReapMinAgeSec ?? 300,
        maxPerPass: sourceConfig.investigationWorktreeReapMaxPerPass ?? 20,
        force: true,
        now: opts.now || (() => Date.now()),
        log,
      });
    },
  });

  app.decorate('fleet', {
    registry,
    latestSnapshots,
    incidentStore,
    deploymentNotifier,
    poller,
    handleSnapshot,
  });

  if (sourceConfig.livePollingEnabled && registry.deployments.length > 0) {
    void poller.pollOnce().catch((error) => {
      log.warn({ code: sanitizedErrorCode(error) }, 'Fleet initial poll failed');
    });
    poller.start();
  }

  app.addHook('onClose', async () => {
    if (typeof poller.stop === 'function') poller.stop();
    if (typeof incidentStore.close === 'function') await incidentStore.close();
    if (typeof deploymentNotifier.close === 'function') await deploymentNotifier.close();
  });

  app.get('/api/fleet/deployments', async () => ({
    deployments: registry.deployments.map((deployment) =>
      safeDeployment(deployment, latestSnapshots.get(deployment.deploymentId))
    ),
  }));

  app.get('/api/fleet/incidents', async (req) => {
    const incidents = await incidentStore.listIncidents({
      status: normalizeStatus(req.query?.status),
      deploymentId: normalizeText(req.query?.deploymentId),
    });
    return { incidents: incidents.map(safeIncident) };
  });

  app.get('/api/fleet/incidents/:id', async (req, reply) => {
    const incident = await incidentStore.getIncident(req.params.id);
    if (!incident) return reply.code(404).send({ error: 'Incident not found' });
    return { incident: safeIncident(incident) };
  });

  app.get('/api/fleet/incidents/:id/evidence', async (req, reply) => {
    const incident = await incidentStore.getIncident(req.params.id);
    if (!incident) return reply.code(404).send({ error: 'Incident not found' });
    const evidence = await incidentStore.getEvidence(incident.id);
    if (!evidence) return reply.code(404).send({ error: 'Evidence not found' });
    return { evidence: safeEvidence(evidence) };
  });

  app.post('/api/fleet/incidents/:id/ack', async (req, reply) => {
    const incident = await incidentStore.ackIncident(req.params.id, {
      actor: normalizeText(req.body?.actor || '') || 'operator',
    });
    if (!incident) return reply.code(404).send({ error: 'Incident not found' });
    return { incident: safeIncident(incident) };
  });

  app.post('/api/fleet/incidents/:id/investigate', async (req, reply) => {
    const incident = await incidentStore.getIncident(req.params.id);
    if (!incident) return reply.code(404).send({ error: 'Incident not found' });
    const evidence = await incidentStore.getEvidence(incident.id);
    if (!evidence) return reply.code(404).send({ error: 'Evidence not found' });
    const deployment = registry.deployments.find((item) => item.deploymentId === incident.deploymentId) || {};
    const baseInvestigationDir = expandHomePath(sourceConfig.investigationWorkDir || '~/.dueno-fleet/investigations');
    const repoConfig = configuredRepoPath(sourceConfig.repoPaths, incident.deploymentId);
    let repoContext = repoConfig ? { companions: repoConfig.companions } : { fallbackReason: 'repo_not_configured' };
    let workDir = '';
    if (repoConfig?.primary) {
      try {
        repoContext = await createWorktree({
          repoPath: repoConfig.primary,
          baseDir: baseInvestigationDir,
          incidentId: incident.id,
        });
        repoContext.companions = repoConfig.companions;
        workDir = repoContext.worktreePath;
      } catch (error) {
        repoContext = {
          repoPath: repoConfig.primary,
          companions: repoConfig.companions,
          fallbackReason: normalizeText(error?.code || error?.message || 'worktree_create_failed') || 'worktree_create_failed',
        };
      }
    }
    if (!workDir) workDir = await resolveInvestigationWorkDir(baseInvestigationDir, incident.id);
    const prompt = buildFleetInvestigationPrompt({ incident, evidence, deployment, repoContext });
    const metadata = {
      fleet_incident_id: incident.id,
      deployment_id: incident.deploymentId,
      fleet_marker_set: Array.isArray(incident.markers) ? incident.markers.map(normalizeText).filter(Boolean) : [],
      fleet_repo_worktree_path: normalizeText(repoContext?.worktreePath || '') || null,
      fleet_repo_source_path: normalizeText(repoContext?.repoPath || '') || null,
      fleet_repo_worktree_branch: normalizeText(repoContext?.branch || '') || null,
      fleet_repo_source_branch: normalizeText(repoContext?.sourceBranch || '') || null,
      fleet_repo_source_head: normalizeText(repoContext?.sourceHead || '') || null,
      fleet_repo_companions: Array.isArray(repoContext?.companions) ? repoContext.companions.map(normalizeText).filter(Boolean) : [],
      fleet_repo_fallback_reason: normalizeText(repoContext?.fallbackReason || '') || null,
    };
    try {
      const session = await sessionLauncher({
        prompt,
        workDir,
        displayName: `Fleet ${incident.deploymentId}`,
        provider: sourceConfig.investigationProvider,
        model: sourceConfig.investigationModel,
        thinkingLevel: sourceConfig.investigationThinkingLevel,
        metadata,
        ...(req.body?.mcpProfile !== undefined ? { mcpProfile: req.body.mcpProfile } : {}),
        ...(req.body?.mcpServers !== undefined ? { mcpServers: req.body.mcpServers } : {}),
      });
      const sessionId = normalizeText(session.id || session.sessionId || '');
      const annotated = await incidentStore.annotateInvestigation(incident.id, { sessionId });
      return {
        sessionId,
        backendType: normalizeText(session.backendType || ''),
        incident: safeIncident(annotated || incident),
      };
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ error: error.message || 'Investigation launch failed' });
    }
  });
}
