import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { runtimeStatePath } from '../ops/runtime-state.mjs';
import { readHookEventsSince } from '../agent/hook-events.mjs';
import { readHookSessionMetadata } from '../session-state/providers/hook.mjs';
import { readTranscriptDelta } from './transcript.mjs';
import { buildBindingStore, resolveBinding } from './binding.mjs';
import { buildBusThreadIndex, busThreadParticipantKey, BusThreadIndex } from './bus-threads.mjs';
import { resolveTopicRoute } from './routing.mjs';
import { transcriptHash } from './relay-dedup.mjs';
import { readEnv } from '../platform/cadre-env.mjs';

const DEFAULT_STATE_DIR = join(homedir(), '.claude/telegram');
const DEFAULT_AGENT_BUS_STATE_PATHS = [
  join(runtimeStatePath('agent_bus'), 'state.json'),
  '.agent_bus/state.json',
];
const OPERATOR_QUESTION_CLOSED_EVENTS = new Set(['UserPromptSubmit', 'Stop', 'SessionEnd']);
const LEGACY_RELAYABLE_STATUSES = new Set(['ready', 'blocked']);
const DEFAULT_ORPHAN_DRAIN_SEC = 120;
const sentStoreWriteQueues = new Map();

async function readJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, data) {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(tmp, filePath);
}

async function serializeSentStoreWrite(filePath, operation) {
  const previous = sentStoreWriteQueues.get(filePath) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  sentStoreWriteQueues.set(filePath, current);
  try {
    return await current;
  } finally {
    if (sentStoreWriteQueues.get(filePath) === current) sentStoreWriteQueues.delete(filePath);
  }
}

function transcriptRangeKey({ path = '', ino = 0, startOffset = 0, nextOffset = 0 } = {}) {
  return JSON.stringify([String(path || ''), Number(ino || 0), Number(startOffset || 0), Number(nextOffset || 0)]);
}

function bindingSession(entry = {}) {
  return {
    id: String(entry.session_id || ''),
    tmuxSession: String(entry.tmux_session || ''),
    workDir: String(entry.work_dir || ''),
    runtime: String(entry.runtime || ''),
    state: null,
    name: String(entry.name || ''),
    created: Number(entry.created || 0),
    cliSessionId: String(entry.cli_session_id || ''),
    busThreadId: String(entry.bus_thread_id || ''),
    busThreadTitle: String(entry.bus_thread_title || ''),
  };
}

function canonicalRelayState(session = {}) {
  const snapshot = session.state;
  if (!snapshot || typeof snapshot !== 'object') return null;
  const status = String(snapshot.status || '');
  if (!status) return null;
  const hasCanonicalAttention = typeof snapshot.capabilities?.needsAttention === 'boolean';
  return {
    status,
    revision: Number(snapshot.revision || 0),
    reason: String(snapshot.reason || ''),
    interaction: snapshot.interaction && typeof snapshot.interaction === 'object'
      ? snapshot.interaction
      : { kind: 'none', detail: '', options: [], fingerprint: '' },
    // needsAttention is blocked/mismatch only. Finished-work prompt_ready is
    // a UI toast, not a Telegram page. deliverInteraction stays blocked-only.
    relayable: hasCanonicalAttention
      ? snapshot.capabilities.needsAttention === true
      : LEGACY_RELAYABLE_STATUSES.has(status),
  };
}

function transcriptLookupKey(session = {}) {
  const runtime = String(session.runtime || session.backend || '').toLowerCase();
  const workDir = String(session.workDir || '');
  return runtime && workDir ? `${runtime}\0${workDir}` : '';
}

function sessionHeader({ backend = '', short = '', tmux_session: tmuxSession = '' } = {}) {
  const parts = [backend, String(short || '').slice(0, 8), tmuxSession]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return parts.length ? `[${parts.join(' ')}]` : '';
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function choiceLabel(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  return firstNonEmptyString(value.label, value.text, value.title, value.value, value.name);
}

function findPromptText(value) {
  if (!value || typeof value !== 'object') return '';
  const direct = firstNonEmptyString(
    value.question,
    value.prompt,
    value.message,
    value.text,
    value.content,
    value.title,
  );
  if (direct) return direct;
  for (const key of ['notification', 'data', 'input', 'request']) {
    const nested = findPromptText(value[key]);
    if (nested) return nested;
  }
  return '';
}

function findChoiceValues(value) {
  if (!value || typeof value !== 'object') return [];
  for (const key of ['choices', 'options', 'selections', 'actions']) {
    const raw = value[key];
    if (!Array.isArray(raw)) continue;
    const labels = raw.map(choiceLabel).filter(Boolean);
    if (labels.length) return labels;
  }
  for (const key of ['notification', 'data', 'input', 'request']) {
    const nested = findChoiceValues(value[key]);
    if (nested.length) return nested;
  }
  return [];
}

function isOperatorQuestionNotification(event = {}, payload = {}) {
  const raw = [
    payload.subtype,
    payload.type,
    payload.notification_type,
    payload.notificationType,
    payload.kind,
    payload.tool_name,
    payload.tool?.name,
    event.subtype,
    event.type,
    event.notification_type,
    event.notificationType,
    event.kind,
  ].map((value) => String(value || '').toLowerCase()).join(' ');
  return /\b(ask[_ -]?user[_ -]?question|operator[_ -]?question|user[_ -]?question|choice[_ -]?prompt)\b/.test(raw);
}

function operatorQuestionFromEvent(event = {}) {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : event;
  const eventName = event.eventName || payload.hook_event_name || '';

  if (eventName === 'PreToolUse') {
    const toolName = payload.tool_name || payload.tool?.name || '';
    if (toolName !== 'AskUserQuestion') return null;
    const toolInput = payload.tool_input || payload.tool?.input || {};
    const firstQuestion = Array.isArray(toolInput.questions) ? toolInput.questions[0] : null;
    if (!firstQuestion) return null;
    const text = findPromptText(firstQuestion);
    const choices = findChoiceValues(firstQuestion);
    if (!text || choices.length === 0) return null;
    return { text, choices, recordedAt: Date.parse(event.loggedAt || '') || 0 };
  }

  if (eventName === 'Notification' && isOperatorQuestionNotification(event, payload)) {
    const text = findPromptText(payload);
    const choices = findChoiceValues(payload);
    if (!text || choices.length === 0) return null;
    return { text, choices, recordedAt: Date.parse(event.loggedAt || '') || 0 };
  }

  return null;
}

function isOperatorQuestionClosedEvent(event = {}) {
  if (OPERATOR_QUESTION_CLOSED_EVENTS.has(event.eventName)) return true;
  if (event.source === 'runtime' && ['SessionBusy', 'SessionToolStarted'].includes(event.eventName)) return true;
  return false;
}

function latestOpenOperatorQuestion(events = []) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] || {};
    if (isOperatorQuestionClosedEvent(event)) return null;
    const question = operatorQuestionFromEvent(event);
    if (question) return question;
  }
  return null;
}

function renderOperatorQuestion(question) {
  return [
    String(question?.text || '').trim(),
    ...(question?.choices || []).map((choice, index) => `${index + 1}. ${String(choice || '').trim()}`),
  ].filter(Boolean).join('\n');
}

function operatorQuestionButtons(question) {
  return (question?.choices || []).map((choice, index) => ({
    text: `${index + 1}. ${String(choice || '').trim()}`.slice(0, 64),
    callback_data: `answer:${index + 1}`,
  }));
}

export function buildSentStore({ stateDir = DEFAULT_STATE_DIR } = {}) {
  const filePath = join(stateDir, 'sent.json');
  let data = {};

  return {
    filePath,
    async load() {
      data = await readJsonFile(filePath, {});
      return data;
    },
    get(sessionId) {
      return data[String(sessionId || '')] || null;
    },
    async set(sessionId, entry) {
      const key = String(sessionId || '');
      await serializeSentStoreWrite(filePath, async () => {
        const persisted = await readJsonFile(filePath, {});
        data = {
          ...persisted,
          [key]: {
            ...(persisted[key] || {}),
            ...(entry || {}),
          },
        };
        await writeJsonAtomic(filePath, data);
      });
      return data[key];
    },
  };
}

function registryRootsFromEnv() {
  const sessionsDir = readEnv('DM_TELEGRAM_RELAY_SESSIONS_DIR');
  if (sessionsDir) return [sessionsDir];
  if (process.env.TELEGRAM_MONITOR_ROOTS) {
    return process.env.TELEGRAM_MONITOR_ROOTS
      .split(':')
      .map((root) => root.trim())
      .filter(Boolean);
  }
  return [process.cwd()];
}

function sessionParticipantKey(session = {}) {
  return busThreadParticipantKey(session.runtime || session.backend || session.provider, session.id);
}

async function readFirstAgentBusState(paths = DEFAULT_AGENT_BUS_STATE_PATHS) {
  for (const filePath of paths || []) {
    const state = await readJsonFile(filePath, null);
    if (state && Array.isArray(state.threads)) return state;
  }
  return null;
}

async function enrichSessionsWithBusThreads(sessions, agentBusStatePaths) {
  const state = await readFirstAgentBusState(agentBusStatePaths);
  if (!state) return sessions;
  const byParticipant = buildBusThreadIndex(state);
  return sessions.map((session) => {
    const thread = byParticipant.get(sessionParticipantKey(session));
    if (!thread) return session;
    return {
      ...session,
      busThreadId: thread.id,
      busThreadTitle: thread.title,
    };
  });
}

export async function listSessionsFromRegistry({ sessionsDir = null, roots = null, agentBusStatePaths = DEFAULT_AGENT_BUS_STATE_PATHS } = {}) {
  const registryRoots = roots || (sessionsDir ? [sessionsDir] : registryRootsFromEnv());
  const sessionsById = new Map();

  for (const root of registryRoots) {
    const files = [
      { path: join(root, '.claude_sessions.json'), fallbackRuntime: 'claude' },
      { path: join(root, '.codex_sessions.json'), fallbackRuntime: 'codex' },
      { path: join(root, '.pi_sessions.json'), fallbackRuntime: 'pi' },
      { path: join(root, '.dueno/state/claude_sessions.json'), fallbackRuntime: 'claude' },
      { path: join(root, '.dueno/state/codex_sessions.json'), fallbackRuntime: 'codex' },
      { path: join(root, '.dueno/state/pi_sessions.json'), fallbackRuntime: 'pi' },
    ];
    for (const file of files) {
      const entries = await readJsonFile(file.path, []);
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || !entry.id) continue;
        const session = {
          id: entry.id,
          tmuxSession: entry.tmuxSession || entry.name || '',
          workDir: entry.workDir || '',
          runtime: entry.runtime || entry.backend || entry.provider || file.fallbackRuntime,
          state: entry.state || null,
          name: entry.displayName || entry.name || '',
          created: Number(entry.created || 0),
          cliSessionId: entry.cliSessionId || '',
        };
        const previous = sessionsById.get(String(session.id));
        if (!previous || session.created >= previous.created) sessionsById.set(String(session.id), session);
      }
    }
  }

  return enrichSessionsWithBusThreads([...sessionsById.values()], agentBusStatePaths);
}

export class TelegramRelayLoop {
  constructor({
    config = {},
    sender,
    sentStore,
    bindingStore = buildBindingStore(),
    listSessions = () => listSessionsFromRegistry(),
    readHookSessionMetadata: readHookSessionMetadataImpl = readHookSessionMetadata,
    resolveBinding: resolveBindingImpl = resolveBinding,
    bindingDeps = {},
    readTranscriptDelta: readTranscriptDeltaImpl = readTranscriptDelta,
    readHookEvents: readHookEventsImpl = readHookEventsSince,
    agentBusStatePaths = DEFAULT_AGENT_BUS_STATE_PATHS,
    now = () => Date.now(),
    logger = console,
  } = {}) {
    this.config = {
      enabled: false,
      tickIntervalSec: 5,
      orphanDrainSec: DEFAULT_ORPHAN_DRAIN_SEC,
      ...config,
    };
    this.sender = sender;
    this.sentStore = sentStore;
    this.bindingStore = bindingStore;
    this.listSessions = listSessions;
    this.readHookSessionMetadata = readHookSessionMetadataImpl;
    this.resolveBinding = resolveBindingImpl;
    this.bindingDeps = bindingDeps;
    this.readTranscriptDelta = readTranscriptDeltaImpl;
    this.readHookEvents = readHookEventsImpl;
    this.agentBusStatePaths = agentBusStatePaths;
    this.busThreadIndex = new BusThreadIndex();
    this.importedLegacyOffsets = false;
    this.now = now;
    this.logger = logger;
    this.timer = null;
    this.lastTickAt = null;
    this.lastError = null;
    this.sessionsSeen = 0;
    this.terminalSessionsSeen = 0;
    this.orphanSessionsSeen = 0;
    this.unresolvedSessions = 0;
    this.pendingPartialBytes = 0;
    this.transcriptDeliveries = 0;
    this.transcriptBytesAdvanced = 0;
    this.lastErrorAt = null;
    this.errorCount = 0;
    this.lastSuccessAt = null;
    this.lastCanonicalStateById = new Map();
    this.stepInProgress = false;
    this.skippedOverlappingTicks = 0;
  }

  get running() {
    return this.timer !== null;
  }

  start() {
    if (!this.config.enabled || this.timer) return false;
    this.timer = setInterval(() => {
      this.step().catch((error) => {
        this.recordError(error, 'telegram relay tick failed');
      });
    }, Number(this.config.tickIntervalSec || 5) * 1000);
    this.timer.unref?.();
    return true;
  }

  stop() {
    if (!this.timer) return false;
    clearInterval(this.timer);
    this.timer = null;
    return true;
  }

  status() {
    return {
      enabled: Boolean(this.config.enabled),
      running: this.running,
      lastTickAt: this.lastTickAt,
      sessionsSeen: this.sessionsSeen,
      terminalSessionsSeen: this.terminalSessionsSeen,
      orphanSessionsSeen: this.orphanSessionsSeen,
      unresolvedSessions: this.unresolvedSessions,
      pendingPartialBytes: this.pendingPartialBytes,
      transcriptDeliveries: this.transcriptDeliveries,
      transcriptBytesAdvanced: this.transcriptBytesAdvanced,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      errorCount: this.errorCount,
      lastSuccessAt: this.lastSuccessAt,
      stepInProgress: this.stepInProgress,
      skippedOverlappingTicks: this.skippedOverlappingTicks,
    };
  }

  async step() {
    if (this.stepInProgress) {
      this.skippedOverlappingTicks += 1;
      return false;
    }
    this.stepInProgress = true;
    this.lastTickAt = this.now();
    this.lastError = null;
    try {
      await this.sentStore.load();
      await this.bindingStore.load();
      await this.importLegacyOffsets();
      const sessions = (await this.listSessions())
        .filter((session) =>
          session?.id
          && session?.tmuxSession
          && session?.workDir
        );
      const liveSessions = sessions;
      this.sessionsSeen = liveSessions.length;
      this.terminalSessionsSeen = liveSessions.filter((session) =>
        session.state?.status === 'ended'
        || session.state?.lifecycle === 'ended'
        || session.state?.lifecycle === 'missing'
      ).length;
      this.unresolvedSessions = 0;
      this.pendingPartialBytes = 0;
      const busState = await readFirstAgentBusState(this.agentBusStatePaths);
      const busIndex = busState ? this.busThreadIndex.update(busState) : this.busThreadIndex.current();
      const tenantCounts = new Map();
      for (const session of liveSessions) {
        const key = transcriptLookupKey(session);
        if (key) tenantCounts.set(key, (tenantCounts.get(key) || 0) + 1);
      }

      for (const session of liveSessions) {
        try {
          const key = transcriptLookupKey(session);
          // API-stamped busThreadId is authoritative when present; the file
          // index is the offline path and last-good cache for transient misses.
          const busThread = busThreadFromSession(session) || busIndex.get(sessionParticipantKey(session));
          await this.processSession(session, {
            busThread,
            liveTenantCount: key ? tenantCounts.get(key) || 1 : 1,
          });
        } catch (error) {
          this.recordError(error, `telegram relay session ${session.id} failed`);
        }
      }
      const presentIds = new Set(liveSessions.map((session) => String(session.id)));
      const drainWindowMs = Math.max(Number(this.config.orphanDrainSec || 0), 0) * 1000;
      const orphanEntries = typeof this.bindingStore.entries === 'function'
        ? this.bindingStore.entries().filter((entry) =>
          entry?.relay_managed
          && entry?.session_id
          && !presentIds.has(String(entry.session_id))
        )
        : [];
      this.orphanSessionsSeen = 0;
      for (const candidate of orphanEntries) {
        const entry = await this.bindingStore.markMissing(candidate.session_id);
        if (!entry || this.now() - Number(entry.orphaned_at_ms || 0) > drainWindowMs) continue;
        const orphanSession = bindingSession(entry);
        if (!orphanSession.id || !orphanSession.tmuxSession || !orphanSession.workDir) continue;
        this.orphanSessionsSeen += 1;
        try {
          await this.processSession(orphanSession, {
            busThread: busThreadFromSession(orphanSession),
            liveTenantCount: 1,
            orphaned: true,
          });
        } catch (error) {
          this.recordError(error, `telegram relay orphan ${orphanSession.id} failed`);
        }
      }
      if (!this.lastError) this.lastSuccessAt = this.now();
      return true;
    } finally {
      this.stepInProgress = false;
    }
  }

  recordError(error, prefix) {
    this.lastError = error?.message || String(error);
    this.lastErrorAt = this.now();
    this.errorCount += 1;
    this.logger?.warn?.(`${prefix}: ${this.lastError}`);
  }

  routeFor(session, busThread) {
    return {
      ...resolveTopicRoute({ session, busThread }),
      short: String(session.id).slice(0, 8),
      cwd: session.workDir,
      tmux_session: session.tmuxSession,
      backend: session.runtime || '',
    };
  }

  async processSession(session, { busThread = null, liveTenantCount = 1, orphaned = false } = {}) {
    const routedSession = busThread ? {
      ...session,
      busThreadId: busThread.id,
      busThreadTitle: busThread.title || '',
    } : session;
    const state = canonicalRelayState(routedSession);
    if (state) {
      this.lastCanonicalStateById.set(routedSession.id, {
        status: state.status,
        revision: state.revision,
        interaction: {
          kind: state.interaction.kind,
          fingerprint: state.interaction.fingerprint,
        },
        relayable: state.relayable,
      });
    }
    const route = this.routeFor(routedSession, busThread);
    await this.deliverTranscriptDelta(routedSession, {
      route,
      liveTenantCount,
      orphaned,
    });
    if (state?.status === 'blocked' && state.relayable) {
      await this.deliverInteraction(routedSession, { state, route });
    }
  }

  async deliverTranscriptDelta(session, { route, liveTenantCount = 1, orphaned = false } = {}) {
    const runtime = String(session.runtime || '').toLowerCase();
    const previousBinding = this.bindingStore.get(session.id);
    const binding = await this.resolveBinding(session, {
      previous: previousBinding,
      liveTenantCount,
      deps: {
        ...this.bindingDeps,
        readHookSessionMetadata: this.readHookSessionMetadata,
      },
    });
    if (!binding?.path) {
      this.unresolvedSessions += 1;
      this.logger?.warn?.(`unresolved_transcript ${session.id}: ${binding?.reason || 'not_found'}`);
      return false;
    }
    if (!binding.reused) {
      const offset = previousBinding?.transcript_path === binding.path
        ? Number(previousBinding.offset) || 0
        : 0;
      await this.bindingStore.bind(session.id, {
        path: binding.path,
        anchor: binding.anchor,
        cliSessionId: binding.cliSessionId || '',
        ino: binding.ino || 0,
        runtime,
        workDir: session.workDir,
        offset,
        session: orphaned ? null : session,
      });
    }
    if (!orphaned && typeof this.bindingStore.observe === 'function') {
      await this.bindingStore.observe(session.id, session);
    }
    const currentBinding = this.bindingStore.get(session.id);
    const currentOffset = Number(currentBinding?.offset || 0);
    const delta = await this.readTranscriptDelta(binding.path, currentOffset, runtime);
    this.pendingPartialBytes += Math.max(Number(delta.pendingBytes || 0), 0);
    const startOffset = Number.isFinite(Number(delta.startOffset))
      ? Number(delta.startOffset)
      : currentOffset;
    const nextOffset = Number(delta.nextOffset);
    if (!Number.isFinite(nextOffset) || nextOffset <= startOffset) return false;
    const range = {
      path: binding.path,
      ino: Number(binding.ino || currentBinding?.ino || 0),
      startOffset,
      nextOffset,
    };
    const deliveryKey = transcriptRangeKey(range);
    const previous = this.sentStore.get(session.id);
    if (previous?.transcript_delivery_key === deliveryKey) {
      await this.advanceTranscriptOffset(session.id, { path: binding.path, nextOffset });
      this.transcriptBytesAdvanced += nextOffset - startOffset;
      return false;
    }
    const body = String(delta.text || '').trim();
    if (!body) {
      await this.advanceTranscriptOffset(session.id, { path: binding.path, nextOffset });
      this.transcriptBytesAdvanced += nextOffset - startOffset;
      return false;
    }
    const delivery = await this.sender.deliver({
      route,
      header: sessionHeader({
        session_id: session.id,
        short: String(session.id).slice(0, 8),
        tmux_session: session.tmuxSession,
        backend: session.runtime || '',
      }),
      text: body,
    });
    const hash = transcriptHash(session.id, body);
    await this.sentStore.set(session.id, {
      ...(previous || {}),
      session_id: session.id,
      transcript_hash: hash,
      transcript_delivery_key: deliveryKey,
      transcript_path: range.path,
      transcript_ino: range.ino,
      transcript_start_offset: range.startOffset,
      transcript_end_offset: range.nextOffset,
      message_id: delivery.msgId,
      thread_id: delivery.threadId,
      topic_key: delivery.topicKey,
      ts: this.now() / 1000,
    });
    await this.advanceTranscriptOffset(session.id, { path: binding.path, nextOffset });
    this.transcriptDeliveries += 1;
    this.transcriptBytesAdvanced += nextOffset - startOffset;
    return true;
  }

  async deliverInteraction(session, { state, route } = {}) {
    const previous = this.sentStore.get(session.id);
    const interactionIdentity = String(
      state.interaction?.fingerprint
      || state.interaction?.detail
      || state.reason
      || '',
    );
    const interactionKey = `${state.status}:${state.interaction?.kind || 'none'}:${interactionIdentity}`;
    if (previous?.last_interaction_key === interactionKey) return false;
    const runtime = String(session.runtime || '').toLowerCase();
    const answerableInteraction = ['permission', 'confirmation', 'selection'].includes(state.interaction?.kind);
    let body = '';
    let buttons;

    try {
      const hookResult = await this.readHookEvents({
        workDir: session.workDir,
        provider: runtime || 'claude',
        sessionId: session.id,
        cursor: 0,
      });
      const question = latestOpenOperatorQuestion(hookResult.events || []);
      const answeredAfterQuestion = question?.recordedAt
        && previous?.answer_consumed_at_ms
        && Number(previous.answer_consumed_at_ms) > question.recordedAt;
      if (question && !answeredAfterQuestion && answerableInteraction) {
        body = renderOperatorQuestion(question);
        buttons = operatorQuestionButtons(question);
      }
    } catch {
      // Hook events are best-effort; fall through to canonical interaction details.
    }

    if (['guardrail', 'trust', 'update'].includes(state.interaction?.kind)) {
      body = '';
      buttons = undefined;
    }

    if (!body) {
      const detail = String(state.interaction?.detail || state.reason || 'Session needs attention').trim();
      const interactionOptions = Array.isArray(state.interaction?.options) ? state.interaction.options : [];
      const labels = interactionOptions.map(choiceLabel).filter(Boolean);
      body = [detail, ...labels.map((label, index) => `${index + 1}. ${label}`)].filter(Boolean).join('\n');
      buttons = ['guardrail', 'trust', 'update'].includes(state.interaction?.kind) ? undefined : interactionOptions.map((option, index) => {
        const label = choiceLabel(option);
        const key = typeof option === 'object' && option
          ? firstNonEmptyString(String(option.key ?? ''), String(option.value ?? ''), String(option.index ?? ''))
          : String(index + 1);
        return label ? {
          text: label.slice(0, 64),
          callback_data: `answer:${key || index + 1}`,
        } : null;
      }).filter(Boolean);
      if (!buttons?.length) buttons = undefined;
    }

    if (!body.trim()) return false;
    const delivery = await this.sender.deliver({
      route,
      header: sessionHeader({
        session_id: session.id,
        short: String(session.id).slice(0, 8),
        tmux_session: session.tmuxSession,
        backend: session.runtime || '',
      }),
      text: body,
      buttons,
    });

    await this.sentStore.set(session.id, {
      ...(previous || {}),
      session_id: session.id,
      message_id: delivery.msgId,
      interaction_message_id: delivery.msgId,
      thread_id: delivery.threadId,
      topic_key: delivery.topicKey,
      interaction_revision: buttons?.length ? state.revision : null,
      interaction_kind: buttons?.length ? state.interaction?.kind || '' : '',
      interaction_fingerprint: buttons?.length ? state.interaction?.fingerprint || '' : '',
      last_interaction_key: interactionKey,
      answer_consumed: false,
      ts: this.now() / 1000,
    });
    return true;
  }

  async advanceTranscriptOffset(sessionId, offsetUpdate) {
    if (!offsetUpdate) return;
    const advanced = await this.bindingStore.advance(sessionId, {
      path: offsetUpdate.path,
      offset: offsetUpdate.nextOffset,
    });
    if (!advanced) {
      throw new Error(`transcript cursor advance refused for ${sessionId}`);
    }
    return advanced;
  }

  async importLegacyOffsets() {
    if (this.importedLegacyOffsets || typeof this.bindingStore.importLegacyOffsets !== 'function') return;
    this.importedLegacyOffsets = true;
    const bindingsDir = dirname(this.bindingStore.filePath || '');
    if (!bindingsDir) return;
    const legacy = await readJsonFile(join(bindingsDir, 'transcript_offsets.json'), {});
    await this.bindingStore.importLegacyOffsets(legacy);
  }
}

function busThreadFromSession(session = {}) {
  const id = String(session.busThreadId || session.bus_thread_id || '').trim();
  if (!id) return null;
  return {
    id,
    title: String(session.busThreadTitle || session.bus_thread_title || '').trim(),
  };
}
