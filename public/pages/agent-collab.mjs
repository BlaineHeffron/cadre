import { h } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import { useSignal } from '../app/use-signal.mjs';
import { route } from 'preact-router';
import { api } from '../app/api.mjs';
import { getAdaptivePollMs } from '../app/network-profile.mjs';
import { buildBootstrapPrompt, buildQuickInsertOptions, buildQuickInsertPrompt } from '../app/agent-bus-ui.mjs';
import { subscribe } from '../app/ws-client.mjs';
import { addToast, agentThreads, agentBusAlerts, agentBusMcpHealth } from '../app/state.mjs';
import { FolderPicker } from '../components/folder-picker.mjs';
import {
  DEFAULT_CONFERENCE_PROVIDERS,
  agentLabel,
  agentRefKey,
  bootstrapStatusClass,
  bootstrapStatusLabel,
  createConferenceParticipant,
  defaultConferenceParticipants,
  fmtTime,
  isActiveThread,
  mcpHealthBadgeClass,
  mcpHealthLabel,
  normalizeConferenceProvider,
  normalizeSearchText,
  participantSummary,
  providerLabel,
  providerRuntime,
  roomLabel,
  sessionDisplayName,
  sessionKindForProvider,
  threadMatchesSearch,
  threadStatusClass,
  transcriptStageLabel,
  uniqueProviders,
} from './agent-collab/format.mjs';
import { MarkdownMath } from '../components/markdown-math.mjs';
import { McpCapabilitySelector } from '../components/mcp-capability-selector.mjs';

// Bootstrap answers 200 with warnings when a participant joined without a usable bus channel;
// dropping them on the floor is how a mute thread looked like a healthy one.
function reportBootstrapWarnings(data) {
  const warnings = Array.isArray(data?.warnings) ? data.warnings : [];
  for (const warning of warnings) {
    addToast(warning?.message || warning?.code || 'Thread bootstrap warning', 'warning');
  }
  if (data?.bootstrapOk === false) {
    const failed = Array.isArray(data.failedParticipants) ? data.failedParticipants : [];
    addToast(
      failed.length > 0
        ? `Bootstrap incomplete for ${failed.map((entry) => `${entry?.participant?.kind || entry?.kind || 'participant'}:${entry?.participant?.sessionId || entry?.sessionId || '?'}`).join(', ')}`
        : 'Thread bootstrap did not complete for every participant',
      'error'
    );
  }
}


const THREAD_FOCUS_KEY = 'dueno_collab_thread_focus_v1';
const FOCUSABLE_SECTION_IDS = ['collab-messages', 'collab-send-message', 'collab-bootstrap-status'];

function loadLastBootstrapThreadId() {
  try {
    return localStorage.getItem('dueno_last_bootstrap_thread_id') || '';
  } catch {
    return '';
  }
}

function saveLastBootstrapThreadId(threadId) {
  try {
    if (threadId) localStorage.setItem('dueno_last_bootstrap_thread_id', threadId);
  } catch {
    // ignore storage failures
  }
}

const LAST_BOOTSTRAP_CONFIG_KEY = 'dueno_last_bootstrap_config';
function saveLastBootstrapConfig(form) {
  try {
    const config = {
      title: form.title.value.trim(),
      projectKey: form.projectKey.value.trim(),
      workDir: form.workDir.value.trim(),
      initialTask: form.initialTask.value.trim(),
      participants: (form.bootstrapParticipants?.value || []).map((participant) => ({
        provider: normalizeConferenceProvider(participant.provider),
        mode: participant.mode || 'new',
        sessionId: String(participant.sessionId || '').trim(),
        model: String(participant.model || '').trim(),
        thinkingLevel: String(participant.thinkingLevel || '').trim(),
        initialTask: String(participant.initialTask || '').trim(),
        mcpProfile: participant.mcpProfile || 'dueno',
        mcpServers: participant.mcpServers || { add: [], remove: [] },
      })),
    };
    localStorage.setItem(LAST_BOOTSTRAP_CONFIG_KEY, JSON.stringify(config));
  } catch { /* ignore */ }
}

function loadLastBootstrapConfig() {
  try {
    const raw = localStorage.getItem(LAST_BOOTSTRAP_CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function getLastBootstrapConfigLabel() {
  const cfg = loadLastBootstrapConfig();
  if (!cfg) return null;
  const parts = [];
  if (cfg.projectKey) parts.push(cfg.projectKey.replace(/^.*\//, ''));
  else if (cfg.workDir) parts.push(cfg.workDir.replace(/^.*\//, ''));
  if (Array.isArray(cfg.participants) && cfg.participants.length > 0) {
    parts.push(cfg.participants.map((participant) => providerLabel(participant.provider)).join('+'));
  } else if (cfg.oneKind && cfg.twoKind) {
    parts.push(`${cfg.oneKind}+${cfg.twoKind}`);
  }
  return parts.join(' ') || 'previous config';
}

function goToThreadHistory(threadId) {
  if (!threadId) return;
  route(`/collab/${threadId}#collab-messages`);
}

function hashTargetId() {
  if (typeof window === 'undefined') return '';
  const hash = String(window.location.hash || '').replace(/^#/, '').trim();
  return FOCUSABLE_SECTION_IDS.includes(hash) ? hash : '';
}

function loadThreadFocusMap() {
  try {
    return JSON.parse(localStorage.getItem(THREAD_FOCUS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveThreadFocus(threadId, targetId) {
  if (!threadId || !targetId) return;
  try {
    const next = loadThreadFocusMap();
    next[threadId] = targetId;
    localStorage.setItem(THREAD_FOCUS_KEY, JSON.stringify(next));
  } catch {
    // ignore storage failures
  }
}

function loadThreadFocus(threadId) {
  if (!threadId) return '';
  return loadThreadFocusMap()[threadId] || '';
}

async function loadThreads(loading, query = '') {
  loading.value = true;
  try {
    const search = normalizeSearchText(query);
    const data = await api.get(`/agent-bus/threads${search ? `?q=${encodeURIComponent(search)}` : ''}`);
    agentThreads.value = data.threads || [];
  } catch (e) {
    addToast(`Failed to load threads: ${e.message}`, 'error');
  } finally {
    loading.value = false;
  }
}

async function loadThread(id, threadState, messages, deliveries, detailLoading) {
  if (!id) {
    threadState.value = null;
    messages.value = [];
    deliveries.value = [];
    return;
  }

  detailLoading.value = true;
  try {
    const data = await api.get(`/agent-bus/threads/${encodeURIComponent(id)}`);
    threadState.value = data.thread;
    messages.value = data.messages || [];
    deliveries.value = data.deliveries || [];
  } catch (e) {
    addToast(`Failed to load thread: ${e.message}`, 'error');
  } finally {
    detailLoading.value = false;
  }
}

async function loadParticipants(participantsState, participantsLoading) {
  participantsLoading.value = true;
  try {
    const data = await api.get('/agent-bus/participants');
    participantsState.value = data;
  } catch (e) {
    addToast(`Failed to load participants: ${e.message}`, 'error');
  } finally {
    participantsLoading.value = false;
  }
}

async function loadAgentProviderPreferences(providerSettings) {
  try {
    const data = await api.get('/agent-provider-preferences');
    providerSettings.value = {
      loading: false,
      ...data,
    };
  } catch (e) {
    providerSettings.value = {
      ...providerSettings.value,
      loading: false,
    };
    addToast(`Failed to load provider settings: ${e.message}`, 'error');
  }
}

async function loadModelCatalog(modelCatalogState, modelCatalogLoading) {
  modelCatalogLoading.value = true;
  try {
    const data = await api.get('/agent-bus/model-catalog');
    modelCatalogState.value = data || { providers: [], models: {} };
  } catch (e) {
    addToast(`Failed to load model catalog: ${e.message}`, 'error');
  } finally {
    modelCatalogLoading.value = false;
  }
}

async function loadMcpHealth() {
  try {
    agentBusMcpHealth.value = await api.get('/agent-bus/mcp-health');
  } catch (e) {
    agentBusMcpHealth.value = {
      ok: false,
      listening: false,
      reachable: false,
      error: e.message,
    };
  }
}

function makeCreateThread(form, createLoading) {
  return async function createThread() {
    if (createLoading.value) return;
    const title = form.title.value.trim();
    const projectKey = form.projectKey.value.trim();
    const participants = [
      { kind: form.participantOneKind.value.trim(), sessionId: form.participantOneId.value.trim() },
      { kind: form.participantTwoKind.value.trim(), sessionId: form.participantTwoId.value.trim() },
    ].filter((item) => item.kind && item.sessionId);

    if (participants.length < 2) {
      addToast('Two participants are required', 'warning');
      return;
    }

    createLoading.value = true;
    try {
      const data = await api.post('/agent-bus/threads', {
        title,
        projectKey,
        participants,
      });
      form.title.value = '';
      form.projectKey.value = '';
      form.participantOneId.value = '';
      form.participantTwoId.value = '';
      route(`/collab/${data.thread.id}`);
    } catch (e) {
      addToast(`Failed to create thread: ${e.message}`, 'error');
    } finally {
      createLoading.value = false;
    }
  };
}

function makeBootstrap(form, createLoading, getProviderCatalog = () => []) {
  return async function bootstrap() {
    if (createLoading.value) return;
    const title = form.title.value.trim();
    const projectKey = form.projectKey.value.trim();
    const workDir = form.workDir.value.trim();
    const initialTask = form.initialTask.value.trim();
    const participants = (form.bootstrapParticipants?.value || [])
      .map((participant) => {
        const provider = normalizeConferenceProvider(participant.provider);
        const mode = participant.mode === 'existing' ? 'existing' : 'new';
        return {
          kind: sessionKindForProvider(provider, getProviderCatalog()),
          provider,
          sessionId: mode === 'existing' ? String(participant.sessionId || '').trim() : '',
          create: mode === 'new',
          model: mode === 'new' ? String(participant.model || '').trim() : '',
          thinkingLevel: mode === 'new' ? String(participant.thinkingLevel || '').trim() : '',
          initialTask: String(participant.initialTask || '').trim(),
          mcpProfile: participant.mcpProfile || 'dueno',
          mcpServers: participant.mcpServers || { add: [], remove: [] },
        };
      })
      .filter((participant) => participant.kind && (participant.create || participant.sessionId));

    if (participants.length < 2) {
      addToast('At least two conference participants are required', 'warning');
      return;
    }
    createLoading.value = true;
    try {
      const data = await api.post('/agent-bus/bootstrap', {
        title,
        projectKey,
        workDir,
        initialTask,
        participants,
      });
      reportBootstrapWarnings(data);
      saveLastBootstrapConfig(form);
      saveLastBootstrapThreadId(data.thread.id);
      form.title.value = '';
      form.projectKey.value = '';
      form.workDir.value = '';
      form.initialTask.value = '';
      form.bootstrapParticipants.value = defaultConferenceParticipants(
        getProviderCatalog().map((entry) => entry?.id).filter(Boolean)
      );
      route(`/collab/${data.thread.id}`);
    } catch (e) {
      addToast(`Failed to bootstrap collaboration: ${e.message}`, 'error');
    } finally {
      createLoading.value = false;
    }
  };
}

function makeSendMessage(id, messages, deliveries, compose, sending) {
  return async function sendMessage() {
    if (!id) {
      addToast('Select a thread first', 'warning');
      return;
    }

    const body = compose.body.value.trim();
    if (!body) {
      addToast('Message body is required', 'warning');
      return;
    }

    const from = { kind: compose.fromKind.value.trim(), sessionId: compose.fromId.value.trim() };
    if (!from.kind || !from.sessionId) {
      addToast('From participant is required', 'warning');
      return;
    }

    sending.value = true;
    try {
      const data = await api.post('/agent-bus/messages', {
        threadId: id,
        from,
        type: compose.type.value.trim() || 'message',
        body,
      });
      compose.body.value = '';
      const nextMessages = data.message ? [data.message] : [];
      const nextDeliveries = Array.isArray(data.deliveries) ? data.deliveries : [];
      messages.value = [...messages.value, ...nextMessages.filter((item) => !messages.value.some((existing) => existing.id === item.id))];
      deliveries.value = [...deliveries.value, ...nextDeliveries.filter((item) => !deliveries.value.some((existing) => existing.id === item.id))];
    } catch (e) {
      addToast(`Failed to send message: ${e.message}`, 'error');
    } finally {
      sending.value = false;
    }
  };
}

function syncComposeFromThread(thread, compose) {
  const participants = thread?.participants || [];
  compose.threadParticipants.value = participants;
  const selected = participants.find((participant) => agentRefKey(participant) === agentRefKey({
    kind: compose.fromKind.value,
    sessionId: compose.fromId.value,
  })) || participants[0];
  compose.fromKind.value = selected?.kind || '';
  compose.fromId.value = selected?.sessionId || '';
}

export function AgentCollabPage({ id }) {
  const loading = useSignal(false);
  const detailLoading = useSignal(false);
  const createLoading = useSignal(false);
  const participantsLoading = useSignal(false);
  const modelCatalogLoading = useSignal(false);
  const sending = useSignal(false);
  const showManualThread = useSignal(false);
  const showBootstrapPanel = useSignal(false);
  const showHistoryPanel = useSignal(false);
  const showFolderPicker = useSignal(false);
  const showBootstrapTranscript = useSignal(false);
  const lastBootstrapThreadId = useSignal(loadLastBootstrapThreadId());
  const threadSearch = useSignal('');
  const folderTarget = useSignal('projectKey');
  const threadState = useSignal(null);
  const messages = useSignal([]);
  const deliveries = useSignal([]);
  const endReport = useSignal('');
  const rawMessageIds = useSignal(new Set());
  const providerSettings = useSignal({
    loading: true,
    claudeEnabled: true,
    codexEnabled: true,
    collabEnabled: true,
    providerCatalog: [],
  });
  const participantsState = useSignal({ supportedKinds: ['codex', 'claude', 'pi'], sessions: {} });
  const modelCatalogState = useSignal({ providers: [], models: {} });
  const createForm = useMemo(() => ({
    title: signal(''),
    projectKey: signal(''),
    workDir: signal(''),
    initialTask: signal(''),
    participantOneKind: signal('codex'),
    participantOneId: signal(''),
    participantTwoKind: signal('claude'),
    participantTwoId: signal(''),
    bootstrapParticipants: signal(defaultConferenceParticipants()),
  }), []);
  const compose = useMemo(() => ({
    fromKind: signal(''),
    fromId: signal(''),
    type: signal('message'),
    body: signal(''),
    threadParticipants: signal([]),
  }), []);
  const detailRef = useRef(null);
  const autoFocusRef = useRef({ threadId: '', done: false });
  const pendingThreadFocusRef = useRef({ threadId: '', targetId: '' });

  const createThread = useMemo(() => makeCreateThread(createForm, createLoading), []);
  const rawBootstrap = useMemo(
    () => makeBootstrap(createForm, createLoading, () => selectableProviderOptions),
    [providerSettings.value, modelCatalogState.value],
  );
  const sendMessage = useMemo(() => makeSendMessage(id, messages, deliveries, compose, sending), [id]);

  function toggleRawMessage(messageId) {
    const next = new Set(rawMessageIds.value);
    if (next.has(messageId)) next.delete(messageId);
    else next.add(messageId);
    rawMessageIds.value = next;
  }

  async function bootstrap() {
    const before = loadLastBootstrapThreadId();
    await rawBootstrap();
    const after = loadLastBootstrapThreadId();
    if (after && after !== before) {
      showBootstrapPanel.value = false;
      showHistoryPanel.value = false;
    }
  }

  function prefillLastBootstrap() {
    const cfg = loadLastBootstrapConfig();
    if (!cfg) return;
    if (cfg.title) createForm.title.value = cfg.title;
    if (cfg.projectKey) createForm.projectKey.value = cfg.projectKey;
    if (cfg.workDir) createForm.workDir.value = cfg.workDir;
    if (cfg.initialTask) createForm.initialTask.value = cfg.initialTask;
    if (Array.isArray(cfg.participants) && cfg.participants.length > 0) {
      createForm.bootstrapParticipants.value = cfg.participants.map((participant) => ({
        ...createConferenceParticipant(normalizeConferenceProvider(participant.provider)),
        mode: participant.mode === 'existing' ? 'existing' : 'new',
        sessionId: String(participant.sessionId || '').trim(),
        model: String(participant.model || '').trim(),
        thinkingLevel: String(participant.thinkingLevel || '').trim(),
        initialTask: String(participant.initialTask || '').trim(),
        mcpProfile: participant.mcpProfile || 'dueno',
        mcpServers: participant.mcpServers || { add: [], remove: [] },
      }));
      return;
    }
    createForm.bootstrapParticipants.value = [
      {
        ...createConferenceParticipant(cfg.oneKind || 'codex'),
        mode: 'new',
        initialTask: String(cfg.oneInitialTask || '').trim(),
      },
      {
        ...createConferenceParticipant(cfg.twoKind || 'claude'),
        mode: 'new',
        initialTask: String(cfg.twoInitialTask || '').trim(),
      },
    ];
  }

  async function endThread() {
    if (!id || !confirm('Close this room, cancel queued deliveries, and terminate participant sessions that are not active in another room?')) return;
    try {
      const data = await api.post(`/agent-bus/threads/${encodeURIComponent(id)}/end`, {
        reason: 'ended from collab ui',
      });
      const skipped = (data.skipped || []).map(agentLabel);
      const failed = (data.results || []).filter((item) => item.status === 'failed');
      endReport.value = [
        skipped.length ? `Skipped (active in another room): ${skipped.join(', ')}` : 'Skipped: none',
        failed.length ? `Failed: ${failed.map((item) => `${agentLabel(item.participant)} (${item.reason || 'unknown error'})`).join(', ')}` : '',
      ].filter(Boolean).join(' · ');
      addToast(data.ok ? 'Room ended.' : 'Room closed with session termination failures.', data.ok ? 'success' : 'warning');
      await loadThread(id, threadState, messages, deliveries, detailLoading);
      loadThreads(loading, threadSearch.value);
    } catch (e) {
      addToast(`Failed to end thread: ${e.message}`, 'error');
    }
  }

  async function closeThread() {
    if (!id || !confirm('Close this room and preserve its participant sessions?')) return;
    try {
      await api.post(`/agent-bus/threads/${encodeURIComponent(id)}/close`, { reason: 'closed from collab ui' });
      endReport.value = '';
      addToast('Room closed. Participant sessions were preserved.', 'success');
      await loadThread(id, threadState, messages, deliveries, detailLoading);
      loadThreads(loading, threadSearch.value);
    } catch (e) {
      addToast(`Failed to close room: ${e.message}`, 'error');
    }
  }

  useEffect(() => {
    loadThreads(loading, threadSearch.value);
    loadParticipants(participantsState, participantsLoading);
    loadModelCatalog(modelCatalogState, modelCatalogLoading);
    loadAgentProviderPreferences(providerSettings);
    loadMcpHealth();

    let timer = null;
    let cancelled = false;

    const schedule = () => {
      if (cancelled) return;
      const delay = getAdaptivePollMs({
        activeMs: 10000,
        reducedMs: 30000,
        hiddenMs: 60000,
      });
      timer = setTimeout(async () => {
        await loadMcpHealth();
        schedule();
      }, delay);
    };

    schedule();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    endReport.value = '';
    loadThread(id, threadState, messages, deliveries, detailLoading);
  }, [id]);

  useEffect(() => {
    if (!id) {
      autoFocusRef.current = { threadId: '', done: false };
      return;
    }
    autoFocusRef.current = { threadId: id, done: false };
  }, [id]);

  useEffect(() => {
    syncComposeFromThread(threadState.value, compose);
  }, [threadState.value]);

  useEffect(() => {
    const currentThread = agentThreads.value.find((thread) => thread.id === id);
    if (currentThread?.metadata?.source === 'bootstrap') {
      lastBootstrapThreadId.value = currentThread.id;
      saveLastBootstrapThreadId(currentThread.id);
    }
  }, [id, agentThreads.value]);

  useEffect(() => {
    const unsubscribeThreads = subscribe('agent-bus:threads', (type, data) => {
      if (type === 'threads' && data?.threads) {
        agentThreads.value = data.threads;
      }
      if ((type === 'thread_created' || type === 'thread_updated') && data?.thread) {
        const next = [...agentThreads.value];
        const idx = next.findIndex(t => t.id === data.thread.id);
        if (idx === -1) next.unshift(data.thread);
        else next[idx] = data.thread;
        agentThreads.value = next.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      }
      if (type === 'thread_deleted' && data?.threadId) {
        agentThreads.value = agentThreads.value.filter(t => t.id !== data.threadId);
      }
    });

    return () => unsubscribeThreads();
  }, []);

  useEffect(() => {
    if (!id) return undefined;
    const channel = `agent-bus:thread:${id}`;
    const unsubscribeThread = subscribe(channel, (type, data) => {
      if (type === 'snapshot' && data) {
        threadState.value = data.thread || null;
        messages.value = data.messages || [];
        deliveries.value = data.deliveries || [];
      }
      if (type === 'thread_updated' && data?.thread) {
        threadState.value = data.thread;
      }
      if (type === 'thread_deleted' && data?.threadId === id) {
        route('/collab');
      }
      if (type === 'message_created' && data?.message) {
        const exists = messages.value.some(item => item.id === data.message.id);
        if (!exists) messages.value = [...messages.value, data.message];
        const fresh = (data.deliveries || []).filter(item => !deliveries.value.some(existing => existing.id === item.id));
        if (fresh.length) {
          deliveries.value = [...deliveries.value, ...fresh];
        }
      }
      if (type === 'delivery_updated' && data?.delivery) {
        deliveries.value = deliveries.value.map(item => item.id === data.delivery.id ? data.delivery : item);
      }
    });

    return () => unsubscribeThread();
  }, [id]);

  useEffect(() => {
    if (!id || !threadState.value || autoFocusRef.current.threadId !== id || autoFocusRef.current.done) return undefined;
    const run = () => {
      const requestedTarget = pendingThreadFocusRef.current.threadId === id
        ? pendingThreadFocusRef.current.targetId
        : '';
      const targetId = requestedTarget && requestedTarget !== '__top__'
        ? requestedTarget
        : (requestedTarget ? '' : (hashTargetId() || loadThreadFocus(id)));
      if (targetId) {
        const section = document.getElementById(targetId);
        if (section) {
          section.scrollIntoView({ behavior: 'smooth', block: 'start' });
          pendingThreadFocusRef.current = { threadId: '', targetId: '' };
          autoFocusRef.current.done = true;
          return;
        }
      }

      detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      pendingThreadFocusRef.current = { threadId: '', targetId: '' };
      autoFocusRef.current.done = true;
    };

    const handle = requestAnimationFrame(() => requestAnimationFrame(run));
    return () => cancelAnimationFrame(handle);
  }, [id, threadState.value, messages.value.length]);

  useEffect(() => {
    if (!id || !threadState.value) return undefined;
    const sections = FOCUSABLE_SECTION_IDS
      .map((sectionId) => document.getElementById(sectionId))
      .filter(Boolean);
    if (sections.length === 0) return undefined;

    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => Math.abs(a.boundingClientRect.top) - Math.abs(b.boundingClientRect.top));
      if (visible[0]?.target?.id) saveThreadFocus(id, visible[0].target.id);
    }, {
      root: null,
      threshold: 0.35,
      rootMargin: '-72px 0px -35% 0px',
    });

    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [id, threadState.value]);

  const sessionOptions = participantsState.value.sessions || {};
  const providerOptions = modelCatalogState.value.providers?.length
    ? modelCatalogState.value.providers
    : [
      { id: 'codex', label: 'Codex', runtime: 'codex', sessionKind: 'codex' },
      { id: 'claude', label: 'Claude', runtime: 'claude', sessionKind: 'claude' },
    ];
  const enabledProviderIds = uniqueProviders(
    (providerSettings.value.providerCatalog || [])
      .filter((entry) => entry.enabled)
      .map((entry) => entry.id)
  );
  const selectableProviderOptions = providerOptions.filter((option) =>
    (enabledProviderIds.length === 0 || enabledProviderIds.includes(option.id))
      && (providerSettings.value.providerCatalog || []).find((entry) => entry.id === option.id)?.supportsCollaboration !== false
  );
  const defaultBootstrapProviders = selectableProviderOptions.length > 0
    ? selectableProviderOptions.map((option) => option.id)
    : DEFAULT_CONFERENCE_PROVIDERS;
  const searchedThreads = normalizeSearchText(threadSearch.value)
    ? agentThreads.value
    : agentThreads.value.filter((thread) => threadMatchesSearch(thread, threadSearch.value));
  const activeThreads = searchedThreads.filter(isActiveThread);
  const historicalThreads = searchedThreads.filter(thread => !isActiveThread(thread));
  const threadParticipants = threadState.value?.participants || [];
  const selectedFromKey = agentRefKey({ kind: compose.fromKind.value, sessionId: compose.fromId.value });
  const quickInsertOptions = buildQuickInsertOptions({
    threads: activeThreads,
    linkedThreads: activeThreads.filter((thread) => thread.id === id),
    sessionsByKind: sessionOptions,
  });

  function updateBootstrapParticipant(index, patch) {
    const next = [...(createForm.bootstrapParticipants.value || [])];
    if (!next[index]) return;
    next[index] = { ...next[index], ...patch };
    createForm.bootstrapParticipants.value = next;
  }

  function addBootstrapParticipant(provider = 'codex') {
    createForm.bootstrapParticipants.value = [
      ...(createForm.bootstrapParticipants.value || []),
      createConferenceParticipant(provider),
    ];
  }

  function removeBootstrapParticipant(index) {
    const current = createForm.bootstrapParticipants.value || [];
    if (current.length <= 2) return;
    createForm.bootstrapParticipants.value = current.filter((_, currentIndex) => currentIndex !== index);
  }

  function modelsForProvider(provider) {
    return modelCatalogState.value.models?.[normalizeConferenceProvider(provider)] || [];
  }

  function sessionChoicesForProvider(provider) {
    const normalized = normalizeConferenceProvider(provider);
    const kind = sessionKindForProvider(normalized, providerOptions);
    const sessions = sessionOptions[kind] || [];
    return sessions.filter((session) => {
      const sessionProvider = normalizeConferenceProvider(session.provider || kind);
      return sessionProvider === normalized;
    });
  }

  function openFolderPicker(target) {
    folderTarget.value = target;
    showFolderPicker.value = true;
  }

  function handleFolderSelect(path) {
    if (folderTarget.value === 'workDir') {
      createForm.workDir.value = path;
      if (!createForm.projectKey.value) createForm.projectKey.value = path;
    } else {
      createForm.projectKey.value = path;
      if (!createForm.workDir.value) createForm.workDir.value = path;
    }
    showFolderPicker.value = false;
  }

  function openThreadTab(threadId) {
    if (!threadId) return;
    if (id === threadId) {
      const savedTarget = loadThreadFocus(threadId);
      const target = document.getElementById(savedTarget || 'collab-message-tail');
      target?.scrollIntoView({ behavior: 'smooth', block: savedTarget ? 'start' : 'end' });
      return;
    }
    pendingThreadFocusRef.current = { threadId, targetId: '__top__' };
    route(`/collab/${threadId}`);
  }

  function navigateToThread(event, threadId) {
    if (!threadId) return;
    event?.preventDefault?.();
    openThreadTab(threadId);
  }

  function appendComposeTemplate(template) {
    if (!template) return;
    compose.body.value = compose.body.value.trim()
      ? `${compose.body.value.trim()}\n\n${template}`
      : template;
  }

  function insertBootstrapPrompt() {
    appendComposeTemplate(buildBootstrapPrompt());
  }

  function insertQuickItem(selectedValue) {
    if (!selectedValue) return;
    const option = quickInsertOptions.find((item) => item.key === selectedValue);
    if (!option) return;

    appendComposeTemplate(buildQuickInsertPrompt({
      option,
      activeThreads,
      currentThreadId: threadState.value?.id || id || '',
    }));
  }

  useEffect(() => {
    if (providerSettings.value.loading) return;
    const allowed = new Set(selectableProviderOptions.map((option) => option.id));
    const fallbackProviders = defaultBootstrapProviders;
    const current = createForm.bootstrapParticipants.value || [];
    const sanitized = current.map((participant, index) => {
      const provider = normalizeConferenceProvider(participant.provider);
      if (allowed.size === 0 || allowed.has(provider)) return participant;
      return {
        ...participant,
        provider: fallbackProviders[index] || fallbackProviders[0] || 'codex',
        sessionId: '',
        model: '',
      };
    });

    if (sanitized.length < 2) {
      createForm.bootstrapParticipants.value = defaultConferenceParticipants(fallbackProviders);
      return;
    }

    const changed = sanitized.some((participant, index) => participant !== current[index]);
    if (changed) createForm.bootstrapParticipants.value = sanitized;
  }, [providerSettings.value, modelCatalogState.value]);


  function ThreadTabStrip() {
    return html`
<div class="collab-toprail">
        <div class="collab-tab-strip">
          ${activeThreads.length === 0 ? html`
            <div class="collab-empty-tabs">No active threads yet</div>
          ` : activeThreads.map((thread) => html`
            <button
              key=${thread.id}
              type="button"
              class="collab-thread-tab ${thread.id === id ? 'collab-thread-tab-active' : ''}"
              onclick=${() => openThreadTab(thread.id)}>
              <span class="collab-thread-tab-title">${roomLabel(thread)}</span>
              <span class="badge ${threadStatusClass(thread.status)}">${thread.status}</span>
            </button>
          `)}
        </div>
      </div>
    `;
  }

  function BootstrapPanel() {
    return showBootstrapPanel.value ? html`
        <div class="card collab-drawer-card">
            <div class="card-header">
              <span class="card-title">Bootstrap Conference</span>
              <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap">
                <span class="badge ${mcpHealthBadgeClass(agentBusMcpHealth.value)}">${mcpHealthLabel(agentBusMcpHealth.value)}</span>
                ${participantsLoading.value ? html`<span style="font-size:11px; color:var(--text-muted)">Loading sessions...</span>` : null}
                ${modelCatalogLoading.value ? html`<span style="font-size:11px; color:var(--text-muted)">Loading models...</span>` : null}
              </div>
            </div>
            <p class="collab-helper">
              Create a multi-agent conference in one step. Each provider uses the backend and runtime reported by the server catalog.
            </p>
            ${getLastBootstrapConfigLabel() ? html`
              <button
                type="button"
                class="btn"
                style="margin-bottom:10px; font-size:11px; padding:4px 10px"
                onclick=${prefillLastBootstrap}
                title="Prefill form with last bootstrap config"
              >Repeat last: ${getLastBootstrapConfigLabel()}</button>
            ` : null}

            <div class="collab-section">
              <div class="collab-section-title">Project Setup</div>
              <div class="collab-form-grid">
                <label class="collab-field">
                  <span>Thread title</span>
                  <input class="input" placeholder="Auth review and patching" value=${createForm.title.value} onInput=${e => { createForm.title.value = e.target.value; }} />
                </label>
                <label class="collab-field">
                  <span>Project path</span>
                  <div style="display:flex; gap:8px">
                    <input class="input" placeholder="/path/to/project" value=${createForm.projectKey.value} onInput=${e => { createForm.projectKey.value = e.target.value; }} autocomplete="off" />
                    <button type="button" class="btn" onclick=${() => openFolderPicker('projectKey')}>Browse</button>
                  </div>
                  ${showFolderPicker.value && folderTarget.value === 'projectKey' ? html`
                    <div class="collab-inline-picker">
                      <${FolderPicker}
                        onSelect=${handleFolderSelect}
                        onCancel=${() => { showFolderPicker.value = false; }}
                      />
                    </div>
                  ` : null}
                </label>
                <label class="collab-field">
                  <span>Workdir for new sessions</span>
                  <div style="display:flex; gap:8px">
                    <input class="input" placeholder="/path/to/project" value=${createForm.workDir.value} onInput=${e => { createForm.workDir.value = e.target.value; }} autocomplete="off" />
                    <button type="button" class="btn" onclick=${() => openFolderPicker('workDir')}>Browse</button>
                  </div>
                  ${showFolderPicker.value && folderTarget.value === 'workDir' ? html`
                    <div class="collab-inline-picker">
                      <${FolderPicker}
                        onSelect=${handleFolderSelect}
                        onCancel=${() => { showFolderPicker.value = false; }}
                      />
                    </div>
                  ` : null}
                </label>
              </div>
            </div>

            <div class="collab-section">
              <div class="collab-section-title">Participants</div>
              <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px">
                ${selectableProviderOptions.map((option) => html`
                  <button type="button" class="btn" onclick=${() => addBootstrapParticipant(option.id)}>
                    + ${option.label}
                  </button>
                `)}
              </div>
              ${providerSettings.value.claudeEnabled === false ? html`
                <div class="collab-inline-note" style="margin-bottom:10px">
                  Claude-backed providers are disabled in Settings, so they are excluded from new conference participants.
                </div>
              ` : null}
              <div class="collab-participant-grid">
                ${(createForm.bootstrapParticipants.value || []).map((participant, index) => {
                  const provider = normalizeConferenceProvider(participant.provider);
                  const sessionChoices = sessionChoicesForProvider(provider);
                  const modelChoices = modelsForProvider(provider);
                  const providerMeta = providerOptions.find((item) => item.id === provider) || null;
                  return html`
                    <div class="collab-participant-card">
                      <div class="collab-participant-header">
                        <span class="card-title">Participant ${index + 1}</span>
                        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end">
                          <span class="badge badge-info">${providerLabel(provider)}</span>
                          <span class="badge">${providerMeta?.runtime || providerRuntime(provider, providerOptions)}</span>
                          ${(createForm.bootstrapParticipants.value || []).length > 2 ? html`
                            <button type="button" class="btn btn-sm" onclick=${() => removeBootstrapParticipant(index)}>Remove</button>
                          ` : null}
                        </div>
                      </div>
                      <label class="collab-field">
                        <span>Provider</span>
                        <select
                          class="input"
                          value=${provider}
                          onInput=${e => updateBootstrapParticipant(index, {
                            provider: normalizeConferenceProvider(e.target.value),
                            sessionId: '',
                            model: '',
                          })}>
                          ${selectableProviderOptions.map((option) => html`
                            <option value=${option.id}>${option.label}</option>
                          `)}
                        </select>
                      </label>
                      <label class="collab-field">
                        <span>Session source</span>
                        <select
                          class="input"
                          value=${participant.mode || 'new'}
                          onInput=${e => updateBootstrapParticipant(index, {
                            mode: e.target.value,
                            sessionId: '',
                          })}>
                          <option value="new">Create new session</option>
                          <option value="existing">Use existing session</option>
                        </select>
                      </label>
                      ${participant.mode === 'existing' ? html`
                        <label class="collab-field">
                          <span>Existing session</span>
                          <select
                            class="input"
                            value=${participant.sessionId || ''}
                            onInput=${e => updateBootstrapParticipant(index, { sessionId: e.target.value })}>
                            <option value="">Select existing session</option>
                            ${sessionChoices.map((session) => html`
                              <option value=${session.id}>${sessionDisplayName(session)}</option>
                            `)}
                          </select>
                        </label>
                      ` : html`
                        <label class="collab-field">
                          <span>Model</span>
                          <select
                            class="input"
                            value=${participant.model || ''}
                            onInput=${e => updateBootstrapParticipant(index, { model: e.target.value })}>
                            <option value="">Use default model</option>
                            ${modelChoices.map((model) => html`
                              <option value=${model.id || model}>${model.label || model.id || model}</option>
                            `)}
                          </select>
                        </label>
                      `}
                      ${participant.mode === 'new' ? html`
                        <label class="collab-field">
                          <span>Thinking level</span>
                          <input
                            class="input"
                            placeholder="medium"
                            value=${participant.thinkingLevel || ''}
                            onInput=${e => updateBootstrapParticipant(index, { thinkingLevel: e.target.value })} />
                        </label>
                      ` : null}
                      <label class="collab-field">
                        <span>Participant task</span>
                        <textarea
                          class="input collab-textarea"
                          placeholder="Optional task just for this participant..."
                          value=${participant.initialTask || ''}
                          onInput=${e => updateBootstrapParticipant(index, { initialTask: e.target.value })} />
                      </label>
                      ${participant.mode === 'new' ? html`
                        <${McpCapabilitySelector}
                          provider=${provider}
                          runtime=${providerMeta?.runtime || providerRuntime(provider, providerOptions)}
                          value=${participant}
                          title=${`MCP capabilities for participant ${index + 1}`}
                          onChange=${(selection) => updateBootstrapParticipant(index, selection)} />
                        <div class="collab-inline-note">
                          A new ${providerLabel(provider)} session will start in the selected workdir on the ${providerMeta?.runtime || providerRuntime(provider, providerOptions)} runtime.
                        </div>
                      ` : html`
                        <div class="collab-inline-note">
                          Reuse an existing ${providerLabel(provider)} ${providerMeta?.sessionKind || providerMeta?.backendType || 'agent'} session. Existing sessions keep their current MCP capabilities.
                        </div>
                      `}
                    </div>
                  `;
                })}
              </div>
            </div>

            <div class="collab-section">
              <div class="collab-section-title">Initial Task</div>
              <p class="collab-helper" style="margin-top:0">
                Use the shared task for common context. Add per-participant tasks above if different agents should start from different instructions.
              </p>
              <textarea class="input collab-textarea" placeholder="Shared brief for both agents..." value=${createForm.initialTask.value} onInput=${e => { createForm.initialTask.value = e.target.value; }} />
            </div>
            <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap">
              <button type="button" class="btn btn-primary" disabled=${createLoading.value} onclick=${bootstrap}>
                ${createLoading.value ? 'Starting...' : 'Create Conference'}
              </button>
              <button type="button" class="btn" disabled=${createLoading.value} onclick=${() => loadParticipants(participantsState, participantsLoading)}>Refresh Sessions</button>
              <button type="button" class="btn" disabled=${createLoading.value} onclick=${() => loadModelCatalog(modelCatalogState, modelCatalogLoading)}>Refresh Models</button>
            </div>
            ${createLoading.value ? html`
              <p class="collab-helper" style="margin-top:10px">
                Starting sessions and waiting for each CLI to become ready. This can take a little while; the request is still running while this message is visible.
              </p>
            ` : null}
        </div>
      ` : null;
  }

  function ThreadHistoryPanel() {
    return showHistoryPanel.value ? html`
        <div class="card collab-drawer-card">
          <div class="card-header" style="margin-bottom:0">
            <div>
              <span class="card-title">Historical Threads</span>
              <div class="collab-helper" style="margin:4px 0 0 0">
                Closed, stale, or detached threads live here so the main view stays focused on active work.
              </div>
            </div>
            <span style="font-size:11px; color:var(--text-muted)">${historicalThreads.length} total</span>
          </div>
          ${historicalThreads.length === 0 ? html`
            <p style="padding-top:12px; color:var(--text-muted)">No historical threads yet.</p>
          ` : html`
            <div class="collab-history-list">
              ${historicalThreads.map(thread => html`
                <a
                  href="/collab/${thread.id}"
                  key=${thread.id}
                  onclick=${(event) => navigateToThread(event, thread.id)}
                  class="collab-thread-item ${id === thread.id ? 'collab-thread-item-active' : ''}">
                  <div style="display:flex; justify-content:space-between; gap:8px">
                    <span style="font-weight:600">${roomLabel(thread)}</span>
                    <span class="badge ${threadStatusClass(thread.status)}">${thread.status}</span>
                  </div>
                  <div style="font-size:11px; color:var(--text-muted); margin-top:4px">${participantSummary(thread.participants)}</div>
                  <div style="font-size:11px; color:var(--text-muted); margin-top:4px">${fmtTime(thread.updatedAt)}</div>
                </a>
              `)}
            </div>
          `}
        </div>
      ` : null;
  }

  function ManualThreadForm() {
    return html`
<div class="card">
            <div class="card-header" style="margin-bottom:0">
              <div>
                <span class="card-title">Manual Thread</span>
                <div class="collab-helper" style="margin:4px 0 0 0">
                  For existing sessions only. Use this if you need to open a thread without the bootstrap workflow.
                </div>
              </div>
              <button type="button" class="btn" onclick=${() => { showManualThread.value = !showManualThread.value; }}>
                ${showManualThread.value ? 'Hide' : 'Show'}
              </button>
            </div>
            ${showManualThread.value ? html`
              <div style="margin-top:12px">
                <div class="collab-form-grid">
                  <input class="input" placeholder="Thread title" value=${createForm.title.value} onInput=${e => { createForm.title.value = e.target.value; }} />
                  <input class="input" placeholder="Project key / path" value=${createForm.projectKey.value} onInput=${e => { createForm.projectKey.value = e.target.value; }} />
                  <input class="input" placeholder="Participant 1 kind" value=${createForm.participantOneKind.value} onInput=${e => { createForm.participantOneKind.value = e.target.value; }} />
                  <input class="input" placeholder="Participant 1 sessionId" value=${createForm.participantOneId.value} onInput=${e => { createForm.participantOneId.value = e.target.value; }} />
                  <input class="input" placeholder="Participant 2 kind" value=${createForm.participantTwoKind.value} onInput=${e => { createForm.participantTwoKind.value = e.target.value; }} />
                  <input class="input" placeholder="Participant 2 sessionId" value=${createForm.participantTwoId.value} onInput=${e => { createForm.participantTwoId.value = e.target.value; }} />
                </div>
                <div style="margin-top:12px">
                  <button type="button" class="btn btn-primary" disabled=${createLoading.value} onclick=${createThread}>
                    ${createLoading.value ? 'Creating...' : 'Create Thread'}
                  </button>
                </div>
              </div>
            ` : null}
          </div>
    `;
  }

  function ThreadMessages() {
    return html`
<div class="collab-detail" ref=${detailRef}>
          ${threadState.value ? html`
            <div class="card">
              <div class="card-header">
                <div>
                  <h2 class="card-title" style="font-size:17px">${roomLabel(threadState.value)}</h2>
                  <div style="font-size:11px; color:var(--text-muted)">${participantSummary(threadState.value.participants)}</div>
                </div>
                <div style="display:flex; align-items:center; gap:8px">
                  <span class="badge ${threadStatusClass(threadState.value.status)}">${threadState.value.status}</span>
                  ${threadState.value.status === 'open' ? html`
                    <button type="button" class="btn" onclick=${closeThread}>Close</button>
                    ${!threadState.value.metadata?.dm ? html`
                      <button type="button" class="btn btn-danger" onclick=${endThread}>End room + sessions</button>
                    ` : null}
                  ` : null}
                </div>
              </div>

              <div class="collab-meta-grid">
                <div><span style="color:var(--text-muted)">Thread:</span> <span style="font-family:var(--font-mono)">${threadState.value.id}</span></div>
                <div><span style="color:var(--text-muted)">Project:</span> <span style="font-family:var(--font-mono)">${threadState.value.projectKey || '-'}</span></div>
                <div><span style="color:var(--text-muted)">Updated:</span> ${fmtTime(threadState.value.updatedAt)}</div>
              </div>
              ${threadState.value.metadata?.missingParticipants?.length > 0 ? html`
                <div style="margin-top:10px; font-size:12px; color:var(--danger)">
                  Missing participants: ${threadState.value.metadata.missingParticipants.map(agentLabel).join(', ')}
                </div>
              ` : null}
              ${endReport.value ? html`
                <div role="status" style="margin-top:10px; font-size:12px; color:var(--text-secondary)">${endReport.value}</div>
              ` : null}
              <div class="collab-detail-shortcuts">
                ${lastBootstrapThreadId.value && lastBootstrapThreadId.value !== threadState.value.id ? html`
                  <button type="button" class="btn" onclick=${() => goToThreadHistory(lastBootstrapThreadId.value)}>Last Bootstrap History</button>
                ` : null}
                <button type="button" class="btn" onclick=${() => {
                  saveThreadFocus(threadState.value.id, 'collab-messages');
                  document.getElementById('collab-messages')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}>History</button>
                <button type="button" class="btn" onclick=${() => {
                  saveThreadFocus(threadState.value.id, 'collab-send-message');
                  document.getElementById('collab-send-message')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}>Send</button>
                ${(threadState.value.metadata?.bootstrapStatus || []).length > 0 ? html`
                  <button type="button" class="btn" onclick=${() => {
                    saveThreadFocus(threadState.value.id, 'collab-bootstrap-status');
                    document.getElementById('collab-bootstrap-status')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}>Bootstrap</button>
                ` : null}
              </div>
            </div>

            <div class="card" id="collab-messages">
              <div class="card-header">
                <span class="card-title">Messages</span>
                ${detailLoading.value ? html`<span style="font-size:11px; color:var(--text-muted)">Syncing...</span>` : null}
              </div>
              ${messages.value.length === 0 ? html`
                <p style="color:var(--text-muted)">No messages in this thread yet.</p>
              ` : messages.value.slice().sort((a, b) => a.createdAt - b.createdAt).map(message => {
                const showRawMessage = rawMessageIds.value.has(message.id);
                return html`
                  <div class="collab-message-card" key=${message.id}>
                    <div style="display:flex; justify-content:space-between; gap:8px; align-items:flex-start">
                      <div style="display:flex; align-items:center; gap:8px">
                        <span style="font-weight:600">${agentLabel(message.from)}</span>
                        ${message.type && message.type !== 'message' ? html`
                          <span style="font-size:11px; color:var(--text-muted)">${message.type}</span>
                        ` : null}
                      </div>
                      <div style="display:flex; align-items:center; gap:8px">
                        <span style="font-size:11px; color:var(--text-muted)">${fmtTime(message.createdAt)}</span>
                        <button
                          type="button"
                          class="btn collab-message-view-toggle"
                          aria-pressed=${showRawMessage}
                          onclick=${() => toggleRawMessage(message.id)}
                        >${showRawMessage ? 'Rendered' : 'Raw'}</button>
                      </div>
                    </div>
                    ${showRawMessage
                      ? html`<div class="collab-message-body collab-message-raw" aria-label="Raw source collaboration message">${message.body}</div>`
                      : html`<${MarkdownMath} content=${message.body} className="collab-message-body" ariaLabel="Rendered source collaboration message" />`}
                    ${message.replyTo ? html`
                      <div style="margin-top:8px; font-size:11px; color:var(--text-muted)">reply to ${message.replyTo}</div>
                    ` : null}
                  </div>
                `;
              })}
              <div id="collab-message-tail"></div>
            </div>

            <div class="card" id="collab-send-message">
              <div class="card-header">
                <span class="card-title">Send Message</span>
                ${sending.value ? html`<span style="font-size:11px; color:var(--text-muted)">Sending...</span>` : null}
              </div>
              <div class="collab-form-grid">
                <label class="collab-field">
                  <span>From</span>
                  <select class="input" value=${selectedFromKey} onInput=${e => {
                    const [kind, sessionId] = String(e.target.value || '').split(':');
                    compose.fromKind.value = kind || '';
                    compose.fromId.value = sessionId || '';
                  }}>
                    ${threadParticipants.map((participant) => html`
                      <option value=${agentRefKey(participant)}>${agentLabel(participant)}</option>
                    `)}
                  </select>
                </label>
                <input class="input" placeholder="Message type" value=${compose.type.value} onInput=${e => { compose.type.value = e.target.value; }} />
              </div>
              <div class="collab-helper" style="margin-top:10px; margin-bottom:0">
                Messages are broadcast to every other participant in the room.
              </div>
              ${quickInsertOptions.length > 0 ? html`
                <label class="collab-field" style="margin-top:10px">
                  <span>Quick insert</span>
                  <select class="input" onInput=${e => {
                    insertQuickItem(String(e.target.value || ''));
                    e.target.value = '';
                  }}>
                    <option value="">Select a live thread or individual session</option>
                    ${quickInsertOptions.map((option) => html`
                      <option value=${option.key}>
                        ${option.label}
                      </option>
                    `)}
                  </select>
                </label>
              ` : null}
              <div style="margin-top:10px">
                <button type="button" class="btn" onclick=${insertBootstrapPrompt}>
                  Insert bootstrap prompt
                </button>
              </div>
              <textarea class="input collab-textarea" placeholder="Structured handoff or request..." value=${compose.body.value} onInput=${e => { compose.body.value = e.target.value; }} />
              <div style="margin-top:12px">
                <button type="button" class="btn btn-primary" disabled=${sending.value} onclick=${sendMessage}>
                  Send
                </button>
              </div>
            </div>

            ${threadState.value.metadata?.managerLoop ? html`
              <div class="card">
                <div class="card-header">
                  <span class="card-title">Legacy loop (archived)</span>
                </div>
                <div class="collab-meta-grid">
                  <div><span style="color:var(--text-muted)">Status:</span> ${threadState.value.metadata.managerLoop.status || '-'}</div>
                  <div><span style="color:var(--text-muted)">Iteration:</span> ${threadState.value.metadata.managerLoop.currentIteration || 0}/${threadState.value.metadata.managerLoop.maxIterations || 0}</div>
                  <div><span style="color:var(--text-muted)">Last decision:</span> ${threadState.value.metadata.managerLoop.lastDecision || '-'}</div>
                  <div><span style="color:var(--text-muted)">Error:</span> ${threadState.value.metadata.managerLoop.error || '-'}</div>
                </div>
              </div>
            ` : null}
            ${(threadState.value.metadata?.bootstrapStatus || []).length > 0 ? html`
              <div class="card" id="collab-bootstrap-status">
                <div class="card-header">
                  <span class="card-title">Bootstrap Status</span>
                  <span style="font-size:11px; color:var(--text-muted)">
                    ${threadState.value.metadata.bootstrapStatus.length} participants
                  </span>
                </div>
                <div class="collab-status-grid">
                  ${threadState.value.metadata.bootstrapStatus.map((entry) => html`
                    <div class="collab-status-card">
                      <div class="collab-participant-header">
                        <div>
                          <div style="font-weight:600">${agentLabel(entry.participant)}</div>
                          ${entry.sessionName ? html`
                            <div style="font-size:11px; color:var(--text-muted)">${entry.sessionName}</div>
                          ` : null}
                        </div>
                        <span class="badge ${bootstrapStatusClass(entry.status)}">${bootstrapStatusLabel(entry.status)}</span>
                      </div>
                      <div class="collab-status-list">
                        <div><span style="color:var(--text-muted)">Source:</span> ${entry.created ? 'new session' : 'existing session'}</div>
                        <div><span style="color:var(--text-muted)">Ready:</span> ${fmtTime(entry.readyDetectedAt)}</div>
                        <div><span style="color:var(--text-muted)">Protocol:</span> ${fmtTime(entry.protocolInjectedAt)}</div>
                        <div><span style="color:var(--text-muted)">Startup:</span> ${fmtTime(entry.startupInstructionInjectedAt)}</div>
                        <div><span style="color:var(--text-muted)">Done:</span> ${fmtTime(entry.completedAt)}</div>
                      </div>
                      ${entry.error ? html`
                        <div style="margin-top:8px; font-size:11px; color:var(--danger)">${entry.error}</div>
                      ` : null}
                    </div>
                  `)}
                </div>
              </div>
            ` : null}

            ${(threadState.value.metadata?.bootstrapTranscript || []).length > 0 ? html`
              <div class="card">
                <div class="card-header">
                  <span class="card-title">Bootstrap Transcript</span>
                  <div style="display:flex; align-items:center; gap:8px">
                    <span style="font-size:11px; color:var(--text-muted)">
                      ${threadState.value.metadata.bootstrapTranscript.length} injected entries
                    </span>
                    <button type="button" class="btn" onclick=${() => { showBootstrapTranscript.value = !showBootstrapTranscript.value; }}>
                      ${showBootstrapTranscript.value ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>
                ${showBootstrapTranscript.value ? html`
                  ${threadState.value.metadata.bootstrapTranscript.map((entry) => html`
                    <div class="collab-message-card">
                      <div style="display:flex; justify-content:space-between; gap:8px; align-items:flex-start">
                        <div style="display:flex; gap:8px; align-items:center">
                          <span class="badge ${entry.stage === 'error' ? 'badge-critical' : 'badge-info'}">${transcriptStageLabel(entry.stage)}</span>
                          <span style="font-size:12px; color:var(--text-secondary)">${agentLabel(entry.participant)}</span>
                        </div>
                        <span style="font-size:11px; color:var(--text-muted)">${fmtTime(entry.createdAt)}</span>
                      </div>
                      <div class="terminal" style="margin-top:8px; max-height:220px">${entry.content}</div>
                    </div>
                  `)}
                ` : html`
                  <p class="collab-helper" style="margin:0">Transcript is collapsed by default. Expand it if you need to inspect the exact injected prompt text.</p>
                `}
              </div>
            ` : null}
          ` : html`
            <div class="card">
              <div class="card-header">
                <span class="card-title">Thread Detail</span>
              </div>
              <p style="color:var(--text-muted)">Select a collaboration thread to inspect participants, message flow, and delivery state.</p>
            </div>
          `}
        </div>
    `;
  }
  return html`
    <div class="page">
      <div class="card-header">
        <h1 class="card-title" style="font-size:18px">Agent Collab</h1>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
          <span class="badge ${mcpHealthBadgeClass(agentBusMcpHealth.value)}">${mcpHealthLabel(agentBusMcpHealth.value)}</span>
          <button type="button" class="btn ${showBootstrapPanel.value ? 'btn-primary' : ''}" onclick=${() => {
            showBootstrapPanel.value = !showBootstrapPanel.value;
            if (showBootstrapPanel.value) {
              showHistoryPanel.value = false;
            }
          }}>
            ${showBootstrapPanel.value ? 'Close +' : '+ Bootstrap'}
          </button>
          <button type="button" class="btn ${showHistoryPanel.value ? 'btn-primary' : ''}" onclick=${() => {
            showHistoryPanel.value = !showHistoryPanel.value;
            if (showHistoryPanel.value) {
              showBootstrapPanel.value = false;
            }
          }}>
            History
          </button>
          <input
            class="input"
            placeholder="Search threads"
            value=${threadSearch.value}
            onInput=${(event) => {
              threadSearch.value = event.target.value;
              loadThreads(loading, threadSearch.value);
            }}
            style="width:180px" />
          <button type="button" class="btn" onclick=${() => loadThreads(loading, threadSearch.value)}>Refresh</button>
          ${lastBootstrapThreadId.value ? html`
            <button type="button" class="btn" onclick=${() => route(`/collab/${lastBootstrapThreadId.value}`)}>Last Bootstrap</button>
            <button type="button" class="btn" onclick=${() => goToThreadHistory(lastBootstrapThreadId.value)}>Last History</button>
          ` : null}
        </div>
      </div>
      ${agentBusMcpHealth.value ? html`
        <div class="collab-mcp-status">
          <span>Loopback MCP:</span>
          <span style="font-family:var(--font-mono)">${agentBusMcpHealth.value.url || '-'}</span>
          <span>${agentBusMcpHealth.value.ok ? 'reachable' : (agentBusMcpHealth.value.error || 'unreachable')}</span>
        </div>
      ` : null}

      <${ThreadTabStrip} />

      <${BootstrapPanel} />      <${ThreadHistoryPanel} />      <div class="collab-body">
        <div class="collab-sidebar-stack">
          <${ManualThreadForm} />

          <div class="card" style="padding:0; overflow:hidden">
            <div class="card-header" style="padding:16px 16px 0 16px">
              <span class="card-title">Active Threads</span>
              <span style="font-size:11px; color:var(--text-muted)">${activeThreads.length} live</span>
            </div>
            ${loading.value ? html`
              <p style="padding:16px; color:var(--text-muted)">Loading threads...</p>
            ` : activeThreads.length === 0 ? html`
              <p style="padding:16px; color:var(--text-muted)">No active collaboration threads.</p>
            ` : activeThreads.map(thread => html`
              <a
                href="/collab/${thread.id}"
                key=${thread.id}
                onclick=${(event) => navigateToThread(event, thread.id)}
                class="collab-thread-item ${id === thread.id ? 'collab-thread-item-active' : ''}">
                <div style="display:flex; justify-content:space-between; gap:8px">
                  <span style="font-weight:600">${roomLabel(thread)}</span>
                  <span class="badge ${threadStatusClass(thread.status)}">${thread.status}</span>
                </div>
                <div style="font-size:11px; color:var(--text-muted); margin-top:4px">${participantSummary(thread.participants)}</div>
                <div style="font-size:11px; color:var(--text-muted); margin-top:4px">${fmtTime(thread.updatedAt)}</div>
                ${thread.metadata?.missingParticipants?.length > 0 ? html`
                  <div style="font-size:11px; color:var(--danger); margin-top:4px">
                    Missing: ${thread.metadata.missingParticipants.map(agentLabel).join(', ')}
                  </div>
                ` : null}
              </a>
            `)}
          </div>

          ${agentBusAlerts.value.length > 0 ? html`
            <div class="card">
              <div class="card-header">
                <span class="card-title">Recent Bus Alerts</span>
              </div>
              ${agentBusAlerts.value.slice(0, 6).map(alert => html`
                <div style="padding:8px 0; border-top:1px solid var(--border)">
                  <div style="display:flex; align-items:center; gap:8px">
                    <span class="badge badge-critical">${alert.type}</span>
                    <span style="font-size:12px">${alert.error || alert.messageId || 'Alert'}</span>
                  </div>
                  ${alert.threadId ? html`
                    <div style="font-size:11px; color:var(--text-muted); margin-top:4px">
                      <a href="/collab/${alert.threadId}" onclick=${(event) => navigateToThread(event, alert.threadId)} style="color:var(--accent)">Open thread</a>
                    </div>
                  ` : null}
                </div>
              `)}
            </div>
          ` : null}

        </div>

        <${ThreadMessages} />
      </div>
    </div>
  `;
}
