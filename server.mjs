import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyRateLimit from '@fastify/rate-limit';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { assertDistinctAuthSecrets, config, loadTlsOptions } from './config.mjs';
import { authPlugin, buildInternalBypassHeaders, evaluateInternalBypass, trustProxyHop, verifyBrowserSessionRequest, verifyToken } from './modules/platform/auth.mjs';
import { summarizeReadiness } from './modules/ops/health-controls.mjs';
import { WsManager } from './modules/platform/ws-manager.mjs';
import { tmuxPlugin } from './modules/platform/tmux.mjs';
import { threatPlugin } from './modules/platform/threat.mjs';
import { filesPlugin } from './modules/platform/files.mjs';
import { skillsPlugin } from './modules/integrations/skills.mjs';
import { claudeSessionsPlugin } from './modules/sessions/claude-sessions.mjs';
import { codexSessionsPlugin } from './modules/sessions/codex-sessions.mjs';
import { createCodexAppServerSessionProvider } from './modules/sessions/codex-app-server-sessions.mjs';
import { getPiProviderHealth, piSessionsPlugin } from './modules/sessions/pi-sessions.mjs';
import { deepseekSessionsPlugin, getDeepSeekProviderHealth } from './modules/sessions/deepseek-sessions.mjs';
import { agentInterfacePlugin } from './modules/agent/interface.mjs';
import { agentBusPlugin } from './modules/agent-bus/index.mjs';
import { opsObservabilityPlugin } from './modules/ops/observability.mjs';
import { commandCenterAIPlugin } from './modules/integrations/command-center-ai.mjs';
import { agentProviderPreferencesPlugin } from './modules/agent/provider-preferences.mjs';
import { fleetPlugin } from './modules/fleet/index.mjs';
import { githubAgentsPlugin } from './modules/integrations/github-agents-plugin.mjs';
import { scheduledAgentsPlugin } from './modules/integrations/scheduled-agents-plugin.mjs';
import { buildScheduledAgentStore, SchedulerLoop } from './modules/integrations/scheduled-agents.mjs';
import { audioPlugin } from './modules/audio/index.mjs';
import { quickCapturePlugin } from './modules/integrations/quick-capture.mjs';
import { researchWorkbenchPlugin } from './modules/integrations/research-workbench.mjs';
import { buildSessionDeliveryAuditStore, sessionDeliveryAuditPlugin } from './modules/sessions/delivery-audit.mjs';
import { buildMonitorMcpServer } from './modules/platform/monitor-mcp.mjs';
import { startAgentBusMcpHttpServer } from './modules/agent-bus/mcp-http.mjs';
import {
  buildInProcessAgentBusMcpServer,
  buildInProcessFastifyRequest,
} from './modules/agent-bus/in-process-mcp.mjs';
import { createBusinessOsMcpProxy } from './modules/integrations/businessos-mcp.mjs';
import { createRemoteMcpProxy } from './modules/integrations/mcp-remote-credentials.mjs';
import { mcpOauthPlugin } from './modules/integrations/mcp-oauth-plugin.mjs';
import { collectReplayEligibleDeliveriesFromState } from './modules/agent-bus/replay-eligible.mjs';
import {
  assertCoordinatorPath,
  scheduledCoordinatorLaunchAuthContext,
} from './modules/agent-bus/coordinator-policy.mjs';
import { buildTelegramSender } from './modules/telegram/sender.mjs';
import { speechSynthesisAvailable } from './modules/telegram/tts.mjs';
import { buildTelegramBridgeLoop } from './modules/telegram/bridge-loop.mjs';
import { buildSentStore, TelegramRelayLoop } from './modules/telegram/relay.mjs';
import { buildBindingStore } from './modules/telegram/binding.mjs';
import { BusThreadIndex, busThreadParticipantKey } from './modules/telegram/bus-threads.mjs';
import {
  shouldEnableTelegramBridge,
  shouldStartAgentBusMcpHttp,
  shouldSuppressSideEffectLoops,
} from './modules/platform/side-effect-loops.mjs';
import {
  applyRevalidatedCacheHeader,
  isProtectedRoutePath,
  isRevalidatedStaticAsset,
} from './modules/platform/static-cache.mjs';

let tlsOpts = null;
try {
  tlsOpts = loadTlsOptions();
} catch (err) {
  console.error(`Server bootstrap failed during TLS setup: ${err.message}`);
  process.exit(1);
}
try {
  assertDistinctAuthSecrets();
} catch (err) {
  console.error(`Server bootstrap failed during auth setup: ${err.message}`);
  process.exit(1);
}

const sideEffectLoopsSuppressed = shouldSuppressSideEffectLoops({ port: config.port });
if (sideEffectLoopsSuppressed) {
  config.githubAgents.enabled = false;
  config.scheduledAgents.enabled = false;
  config.telegramRelay.enabled = false;
}

const app = Fastify({
  logger: { level: config.logLevel },
  bodyLimit: 12 * 1024 * 1024,
  trustProxy: trustProxyHop,
  ...(tlsOpts ? { https: tlsOpts } : {}),
});
if (sideEffectLoopsSuppressed) {
  app.log.warn('Side-effect loops disabled for non-service/test server; set CADRE_ALLOW_SIDE_EFFECTS=1 to override');
}

// Rate limiting — applies to ALL clients (no allowList bypass)
await app.register(fastifyRateLimit, {
  max: 200,
  timeWindow: '1 minute',
  allowList: (request) => {
    if (evaluateInternalBypass(request).allowed) return true;
    if (verifyBrowserSessionRequest(request)) return true;
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
    return verifyToken(authHeader.slice(7));
  },
});

// WebSocket support
await app.register(fastifyWebsocket);

// Auth
await app.register(authPlugin);
await app.register(agentProviderPreferencesPlugin);

// WebSocket manager (must be after websocket plugin)
const wsManager = new WsManager(app);
const sessionDeliveryAuditStore = buildSessionDeliveryAuditStore();

// Tmux integration
await app.register(tmuxPlugin, { wsManager });

// Threat detection
await app.register(threatPlugin, { wsManager, sideEffectLoopsSuppressed });

// File browser
await app.register(filesPlugin);

// Skills registry
await app.register(skillsPlugin);

// Claude Code sessions
await app.register(claudeSessionsPlugin, { wsManager, sessionDeliveryAuditStore });

// Codex sessions
await app.register(codexSessionsPlugin, { wsManager, sessionDeliveryAuditStore });

// Explicit task provider; ordinary Codex sessions continue using tmux.
const codexAppServer = await createCodexAppServerSessionProvider({
  logger: app.log, deliveryAuditStore: sessionDeliveryAuditStore,
});
app.addHook('onClose', () => codexAppServer.close());

// Pi coding-agent sessions (multi-provider, non-Anthropic models)
await app.register(piSessionsPlugin, { wsManager, sessionDeliveryAuditStore });

// DeepSeek Harness sessions (ACP JSON-RPC over stdio; no tmux transport)
await app.register(deepseekSessionsPlugin, { wsManager, sessionDeliveryAuditStore });

// Direct session delivery audit
await app.register(sessionDeliveryAuditPlugin, { store: sessionDeliveryAuditStore });

// Unified agent interface for provider selection and one-off execution
await app.register(agentInterfacePlugin);

// Local Zotero/Nodus research bridge. Dedicated auth; Codex-only fixed profile.
await app.register(researchWorkbenchPlugin, { wsManager });

// Agent collaboration bus
await app.register(agentBusPlugin, { wsManager });

await app.register(opsObservabilityPlugin);

// Command center AI (persistent overseer session)
await app.register(commandCenterAIPlugin, { wsManager });

// BusinessOS fleet monitoring
await app.register(fleetPlugin, { wsManager });

const scheduledAgentStore = buildScheduledAgentStore({ env: process.env });
const scheduledAgentLoop = new SchedulerLoop({
  config: config.scheduledAgents,
  store: scheduledAgentStore,
  sessionLauncher: launchScheduledAgentSession,
  lookupSessionState: lookupScheduledAgentSessionState,
  logger: app.log,
});

// Scheduled recurring agents
await app.register(scheduledAgentsPlugin, {
  store: scheduledAgentStore,
  loop: scheduledAgentLoop,
  config: config.scheduledAgents,
  rootConfig: config,
  sessionLauncher: launchScheduledAgentSession,
  lookupSessionState: lookupScheduledAgentSessionState,
});

// GitHub PR/issue listener agents
await app.register(githubAgentsPlugin, { wsManager });

// Audio recording transcript/summary evidence ingestion
await app.register(audioPlugin, { wsManager });

// Phone-friendly quick capture notes
await app.register(quickCapturePlugin);

await app.register(mcpOauthPlugin);

app.addHook('onSend', async (request, reply, payload) => {
  const { pathname } = new URL(request.raw.url || '/', 'http://localhost');
  if (isRevalidatedStaticAsset(pathname)) {
    reply.header('Cache-Control', 'no-cache, must-revalidate');
  }
  return payload;
});

// Static files
await app.register(fastifyStatic, {
  root: resolve('node_modules'),
  prefix: '/vendor/npm/',
  decorateReply: false,
  setHeaders(res, path) {
    applyRevalidatedCacheHeader(res, path);
  },
});

await app.register(fastifyStatic, {
  root: resolve('public'),
  prefix: '/',
  setHeaders(res, path) {
    // Prevent aggressive caching of JS modules and HTML so updates are seen immediately
    applyRevalidatedCacheHeader(res, path);
  },
});

// SPA fallback for deep links (e.g. /claude/:id, /tmux/pane/:target)
app.setNotFoundHandler((request, reply) => {
  const method = request.raw.method || 'GET';
  const rawUrl = request.raw.url || '/';
  const { pathname } = new URL(rawUrl, 'http://localhost');

  // Preserve API/WS and non-GET behavior as real 404s.
  if (isProtectedRoutePath(rawUrl) || (method !== 'GET' && method !== 'HEAD')) {
    return reply.code(404).send({ error: 'Not Found' });
  }

  // Missing static assets should stay 404, not index fallback.
  const staticExt = /\.(?:mjs|js|css|map|json|svg|png|jpg|jpeg|gif|webp|ico|txt|xml|woff|woff2|ttf|eot)$/i;
  if (staticExt.test(pathname)) {
    return reply.code(404).send({ error: 'Not Found' });
  }

  return reply.type('text/html').sendFile('index.html');
});

async function runInternalProbe(url) {
  const response = await app.inject({
    method: 'GET',
    url,
    headers: {
      accept: 'application/json',
      ...buildInternalBypassHeaders(),
    },
  });
  let payload = null;
  try {
    payload = response.body ? JSON.parse(response.body) : null;
  } catch {
    payload = null;
  }
  return { statusCode: response.statusCode, payload };
}

const internalRequest = buildInProcessFastifyRequest({ app, buildHeaders: buildInternalBypassHeaders });

let inProcessMonitorMcp = null;

function getInProcessMonitorMcpServer() {
  if (!inProcessMonitorMcp) {
    inProcessMonitorMcp = buildMonitorMcpServer({ requestImpl: internalRequest });
  }
  return inProcessMonitorMcp;
}

async function launchScheduledAgentSession({
  type,
  prompt,
  targetSession,
  workDir,
  provider,
  model,
  displayName,
  parentThreadId,
  taskId,
  trustedCoordinatorMetadata,
  mcpProfile,
  mcpServers,
} = {}) {
  if (type === 'inject') {
    await internalRequest(`/api/${encodeURIComponent(targetSession.kind)}/sessions/${encodeURIComponent(targetSession.sessionId)}/input`, {
      method: 'POST',
      body: { text: prompt, enter: true, source: 'scheduled_loop' },
    });
    return { id: targetSession.sessionId };
  }
  const authContext = trustedCoordinatorMetadata
    ? scheduledCoordinatorLaunchAuthContext(trustedCoordinatorMetadata, { scheduleId: taskId, workDir })
    : null;
  if (authContext) {
    await assertCoordinatorPath(authContext.coordinatorPolicy, workDir, 'scheduled workDir');
  }
  return getInProcessMonitorMcpServer().handleToolCall('spawn_session', {
    provider,
    workDir,
    displayName,
    model,
    initialPrompt: prompt,
    parentThreadId,
    mcpProfile,
    mcpServers,
  }, authContext ? { authContext } : null);
}

async function lookupScheduledAgentSessionState(sessionId, targetKind = '') {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const kinds = targetKind ? [String(targetKind).trim().toLowerCase()] : await listEnabledAgentBackendKinds();
  for (const kind of kinds) {
    let payload;
    try {
      payload = await internalRequest(`/api/${kind}/sessions`);
    } catch (error) {
      if (targetKind) throw error;
      continue;
    }
    const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
    const session = sessions.find((entry) => entry?.id === id);
    if (session) {
      const state = session.state && typeof session.state === 'object' ? session.state : {};
      return {
        ...state,
        lifecycle: state.lifecycle || (session.lifecycle || ''),
        capabilities: state.capabilities || session.capabilities || {},
      };
    }
  }
  return targetKind
    ? { status: 'ended', lifecycle: 'missing', error: `Target ${targetKind}:${id} not found` }
    : null;
}

async function listEnabledAgentBackendKinds() {
  const payload = await internalRequest('/api/agents/providers').catch(() => null);
  const kinds = (payload?.providers || [])
    .filter((entry) => entry?.enabled !== false)
    .map((entry) => String(entry?.backendType || entry?.sessionKind || '').trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(kinds.length > 0 ? kinds : ['claude', 'codex', 'pi'])];
}

const telegramBusThreads = new BusThreadIndex();

async function listTelegramBusThreadsBySession() {
  const payload = await internalRequest('/api/agent-bus/state?messageLimit=0&deliveryLimit=0')
    .catch((error) => {
      app.log.warn(`telegram bus thread discovery failed: ${error.message || error}`);
      return null;
    });
  // A transient bus failure must not flip sessions back to session-scoped
  // topics, so reuse the last successful mapping.
  if (!payload) return telegramBusThreads.current();
  return telegramBusThreads.update(payload);
}

async function listTelegramSessions() {
  const output = [];
  const busThreads = await listTelegramBusThreadsBySession();
  for (const kind of await listEnabledAgentBackendKinds()) {
    const payload = await internalRequest(`/api/${kind}/sessions?includeReadOnly=true`).catch((error) => {
      app.log.warn(`telegram session discovery ${kind} failed: ${error.message || error}`);
      return null;
    });
    const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
    for (const session of sessions) {
      if (!session?.id || !session?.tmuxSession || !session?.workDir) continue;
      const busThread = busThreads.get(busThreadParticipantKey(kind, session.id)) || null;
      output.push({
        id: session.id,
        tmuxSession: session.tmuxSession,
        workDir: session.workDir,
        runtime: kind,
        state: session.state || null,
        name: session.displayName || session.name || '',
        created: Number(session.created || 0),
        cliSessionId: session.cliSessionId || '',
        busThreadId: busThread?.id || '',
        busThreadTitle: busThread?.title || '',
      });
    }
  }
  return output;
}

async function getStorageHealth() {
  try {
    const response = await runInternalProbe('/api/agent-bus/state?status=open&messageLimit=0&deliveryLimit=0');
    if (response.statusCode >= 400) {
      return {
        status: 'failed',
        detail: `agent_bus_state_${response.statusCode}`,
        data: response.payload,
      };
    }
    return {
      status: 'ok',
      detail: 'agent_bus_store_ready',
    };
  } catch (error) {
    return {
      status: 'failed',
      detail: error.message || 'storage_probe_failed',
    };
  }
}

async function getReadinessReport() {
  const [storage, agentBusMcp, piProvider, deepseekProvider] = await Promise.all([
    getStorageHealth(),
    getAgentBusMcpHealth().then((health) => {
      const detail = health.enabled === false
        ? 'mcp_http_disabled'
        : (health.ok ? 'mcp_http_ready' : (health.error || 'mcp_http_unreachable'));
      return {
        status: health.ok ? 'ok' : 'degraded',
        detail,
        data: health,
      };
    }),
    getPiProviderHealth(),
    Promise.resolve(getDeepSeekProviderHealth()).then((health) => ({
      status: 'ok',
      detail: health.ok ? 'deepseek_acp_ready' : `deepseek_optional_${health.detail || 'unavailable'}`,
      data: health,
    })),
  ]);
  return summarizeReadiness({
    storage,
    agentBusMcp,
    piProvider,
    deepseekProvider,
  });
}

function sumCounter(metrics, name, predicate = null) {
  return (metrics?.counters || [])
    .filter((item) => item?.name === name)
    .filter((item) => (typeof predicate === 'function' ? predicate(item) : true))
    .reduce((sum, item) => sum + Number(item?.value || 0), 0);
}

function gaugeValue(metrics, name) {
  const gauge = (metrics?.gauges || []).find((item) => item?.name === name);
  const value = gauge?.value;
  return typeof value === 'number' ? value : null;
}

function buildOpsHighlights({ readiness, agentBus, controls }) {
  const highlights = [];
  const replayEligibleCount = Number(agentBus?.replayEligibleCount || 0);
  const activeKillSwitches = Array.isArray(controls?.killSwitchesActive) ? controls.killSwitchesActive.length : 0;

  if (readiness?.ready === false || readiness?.status === 'failed') {
    highlights.push({
      key: 'readiness',
      severity: 'p0',
      message: readiness?.summary || 'Readiness checks are failing.',
    });
  } else if (readiness?.status === 'degraded') {
    highlights.push({
      key: 'readiness',
      severity: 'p1',
      message: readiness?.summary || 'Readiness is degraded.',
    });
  }

  if (replayEligibleCount > 0) {
    highlights.push({
      key: 'agent_bus_replay',
      severity: 'p1',
      message: `${replayEligibleCount} agent-bus deliveries are eligible for replay.`,
    });
  }

  if (activeKillSwitches > 0) {
    highlights.push({
      key: 'kill_switches',
      severity: 'p1',
      message: `${activeKillSwitches} production-control kill switches are active.`,
    });
  }

  return highlights;
}

app.get('/api/health/live', async () => ({
  status: 'ok',
  uptime: process.uptime(),
}));

app.get('/api/health/ready', async (_req, reply) => {
  const readiness = await getReadinessReport();
  if (!readiness.ready) reply.code(503);
  return readiness;
});

// Compatibility endpoint
app.get('/api/health', async () => ({ status: 'ok' }));

app.get('/api/ops/summary', async () => {
  const [readiness, metrics, agentBusState, opsStatus, controlEvents] = await Promise.all([
    getReadinessReport(),
    runInternalProbe('/api/ops/metrics').then((response) => response.payload).catch(() => null),
    runInternalProbe('/api/agent-bus/state?status=open&includeMessages=false&messageLimit=0&deliveryLimit=20')
      .then((response) => response.payload)
      .catch(() => null),
    runInternalProbe('/api/ops/status').then((response) => response.payload).catch(() => null),
    runInternalProbe('/api/ops/events?limit=10&sinceHours=24').then((response) => response.payload).catch(() => null),
  ]);
  const replayEligibleDeliveries = collectReplayEligibleDeliveriesFromState(agentBusState, { limit: 10 });
  const agentBus = {
    openThreadCount: Number(agentBusState?.threadCount || 0),
    replayEligibleCount: replayEligibleDeliveries.length,
    replayEligibleDeliveries,
  };

  return {
    readiness,
    controls: opsStatus?.controls || null,
    controlAudit: opsStatus?.controlAudit || null,
    metrics,
    agentBus,
    controlEvents,
    highlights: buildOpsHighlights({
      readiness,
      agentBus,
      controls: opsStatus?.controls || null,
    }),
  };
});

// Telegram bridge sidecar
let telegramBridge = null;
let telegramBridgeRestartTimer = null;
let telegramBridgeEnabled = shouldEnableTelegramBridge({ sideEffectLoopsSuppressed });
const agentBusMcpHttpEnabled = shouldStartAgentBusMcpHttp({ sideEffectLoopsSuppressed });
let agentBusMcpHttpServer = null;
let telegramRelayLoop = null;

async function getAgentBusMcpHealth() {
  const url = `http://${config.agentBusMcpHttp.host}:${config.agentBusMcpHttp.port}${config.agentBusMcpHttp.path}`;

  if (!agentBusMcpHttpEnabled) {
    return {
      ok: true,
      enabled: false,
      listening: false,
      reachable: false,
      url,
      reason: 'side_effect_loops_suppressed',
    };
  }

  const listening = Boolean(agentBusMcpHttpServer?.listening);

  if (!listening) {
    return {
      ok: false,
      enabled: true,
      listening: false,
      reachable: false,
      url,
      error: 'MCP HTTP listener is not running',
    };
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(1500),
    });

    return {
      ok: response.ok,
      enabled: true,
      listening: true,
      reachable: response.ok,
      url,
      status: response.status,
    };
  } catch (err) {
    return {
      ok: false,
      enabled: true,
      listening: true,
      reachable: false,
      url,
      error: err.message || 'Failed to reach MCP HTTP listener',
    };
  }
}

app.get('/api/agent-bus/mcp-health', async () => getAgentBusMcpHealth());

function createInProcessAgentBusMcpServer() {
  // Build monitor MCP tools and inject them as extra tools into the agent-bus MCP server
  const monitorMcp = getInProcessMonitorMcpServer();

  return buildInProcessAgentBusMcpServer({ requestImpl: internalRequest, monitorMcp });
}

function clearTelegramBridgeRestartTimer() {
  if (!telegramBridgeRestartTimer) return;
  clearTimeout(telegramBridgeRestartTimer);
  telegramBridgeRestartTimer = null;
}

function scheduleTelegramBridgeRestart(delayMs = 5000) {
  if (sideEffectLoopsSuppressed) return false;
  if (!telegramBridgeEnabled || telegramBridge || telegramBridgeRestartTimer) return false;
  app.log.warn(`Telegram bridge will retry start in ${delayMs}ms`);
  telegramBridgeRestartTimer = setTimeout(() => {
    telegramBridgeRestartTimer = null;
    startTelegramBridge();
  }, delayMs);
  telegramBridgeRestartTimer.unref?.();
  return true;
}

function startTelegramBridge() {
  if (sideEffectLoopsSuppressed) {
    telegramBridgeEnabled = false;
    return false;
  }
  if (telegramBridge) return false;
  clearTelegramBridgeRestartTimer();
  const stateDir = join(homedir(), '.claude/telegram');
  telegramBridge = buildTelegramBridgeLoop({
    stateDir,
    sender: buildTelegramSender({ stateDir, logger: app.log, ttsAvailable: speechSynthesisAvailable }),
    listSessions: listTelegramSessions,
    requestImpl: internalRequest,
    logger: app.log,
  });
  const started = telegramBridge.start();
  if (!started) {
    telegramBridge = null;
    return false;
  }
  app.log.info('Telegram bridge started in-process');
  return true;
}

function stopTelegramBridge() {
  if (!telegramBridge) return false;
  telegramBridge.stop();
  telegramBridge = null;
  return true;
}

// Telegram bridge API
app.get('/api/telegram/bridge', async () => ({
  enabled: telegramBridgeEnabled,
  running: Boolean(telegramBridge?.running),
  restartPending: telegramBridgeRestartTimer !== null,
  status: telegramBridge?.status?.() || null,
}));

app.post('/api/telegram/bridge/start', async (req, reply) => {
  if (sideEffectLoopsSuppressed) {
    telegramBridgeEnabled = false;
    return reply.code(403).send({ error: 'Side-effect loops are disabled' });
  }
  telegramBridgeEnabled = true;
  if (telegramBridge) return reply.code(409).send({ error: 'Bridge already running' });
  const ok = startTelegramBridge();
  if (!ok) return reply.code(500).send({ error: 'Failed to start bridge' });
  return { ok: true };
});

app.post('/api/telegram/bridge/stop', async () => {
  telegramBridgeEnabled = false;
  clearTelegramBridgeRestartTimer();
  stopTelegramBridge();
  return { ok: true };
});

function buildTelegramRelayLoop() {
  const stateDir = join(homedir(), '.claude/telegram');
  return new TelegramRelayLoop({
    config: config.telegramRelay,
    sender: buildTelegramSender({ stateDir, logger: app.log, ttsAvailable: speechSynthesisAvailable }),
    sentStore: buildSentStore({ stateDir }),
    bindingStore: buildBindingStore({ stateDir }),
    listSessions: listTelegramSessions,
    logger: app.log,
  });
}

function startTelegramRelay() {
  if (!telegramRelayLoop) telegramRelayLoop = buildTelegramRelayLoop();
  return telegramRelayLoop.start();
}

app.get('/api/telegram/relay', async () => {
  if (!telegramRelayLoop) {
    return {
      enabled: Boolean(config.telegramRelay.enabled),
      running: false,
      lastTickAt: null,
      sessionsSeen: 0,
      terminalSessionsSeen: 0,
      orphanSessionsSeen: 0,
      unresolvedSessions: 0,
      pendingPartialBytes: 0,
      transcriptDeliveries: 0,
      transcriptBytesAdvanced: 0,
      lastError: null,
      lastErrorAt: null,
      errorCount: 0,
      lastSuccessAt: null,
    };
  }
  return telegramRelayLoop.status();
});

app.addHook('onClose', async () => {
  telegramRelayLoop?.stop();
});

// Graceful shutdown
async function shutdown() {
  app.log.info('Shutting down...');
  telegramBridgeEnabled = false;
  clearTelegramBridgeRestartTimer();
  stopTelegramBridge();
  telegramRelayLoop?.stop();
  if (agentBusMcpHttpServer) {
    await new Promise((resolveClose) => agentBusMcpHttpServer.close(resolveClose));
    agentBusMcpHttpServer = null;
  }
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start
try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Server listening on ${tlsOpts ? 'https' : 'http'}://${config.host}:${config.port}`);

  if (agentBusMcpHttpEnabled) {
    agentBusMcpHttpServer = startAgentBusMcpHttpServer({
      metaUrl: import.meta.url,
      host: config.agentBusMcpHttp.host,
      port: config.agentBusMcpHttp.port,
      path: config.agentBusMcpHttp.path,
      log: app.log,
      serverFactory: createInProcessAgentBusMcpServer(),
      businessOsMcpProxy: createBusinessOsMcpProxy({ log: app.log }),
      mcpServerProxy: createRemoteMcpProxy({ log: app.log }),
    });
  } else {
    app.log.warn('Agent Bus MCP HTTP listener disabled by side-effect suppression');
  }

  // Start telegram bridge by default (disable with TELEGRAM_BRIDGE=0)
  if (telegramBridgeEnabled) {
    startTelegramBridge();
  }

  if (config.telegramRelay.enabled) {
    startTelegramRelay();
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

export { app, wsManager };
