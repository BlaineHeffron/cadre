import { h } from 'preact';
import { html } from 'htm/preact';
import { route } from 'preact-router';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { api } from '../app/api.mjs';
import {
  buildUnifiedAgentSessions,
  loadUnifiedAgentSessions,
  normalizeProvider,
} from '../app/agent-session-nav.mjs';
import {
  addToast,
  agentThreads,
  claudeSessions,
  codexSessions,
  deepseekSessions,
  piSessions,
  removeSessionForKind,
  wsConnected,
} from '../app/state.mjs';
import { SessionCard } from '../components/session-card.mjs';
import { FolderPicker } from '../components/folder-picker.mjs';
import { DirQuickSelect } from '../components/dir-quick-select.mjs';
import { recentWorkDirs } from '../app/recent-dirs.mjs';
import { LiveSessionPreview } from '../components/live-session-preview.mjs';
import { McpCapabilitySelector } from '../components/mcp-capability-selector.mjs';
import { PromptProfileSelector } from '../components/prompt-profile-selector.mjs';
import { LaunchSkillSelector } from '../components/launch-skill-selector.mjs';
import { openSkillWriterWithDraft } from '../app/skill-drafts.mjs';
import { SkillPromptComposer } from '../components/skill-prompt-composer.mjs';
import { EmptyState, ErrorState, LoadingState } from '../components/page-state.mjs';
import { AgentSessionDetailPage } from './agent-session-detail.mjs';
import { settleWithConcurrency } from '../app/async-pool.mjs';
import { sessionTitle } from '../app/agent-bus-ui.mjs';

const PROVIDER_OPTIONS = [
  { id: 'all', label: 'All providers' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
];
const FALLBACK_PROVIDER_MODELS = Object.freeze({
  codex: 'gpt-6.1-sol',
  claude: 'claude-opus-5-5',
});
const DEFAULT_THINKING_LEVEL = 'medium';
const DEFAULT_WORKDIR_PLACEHOLDER = '/path/to/project';
const CODEX_REASONING_LEVELS = Object.freeze([
  { id: 'low', label: 'Low', description: 'Fast responses with lighter reasoning' },
  { id: 'medium', label: 'Medium', description: 'Balances speed and reasoning depth' },
  { id: 'high', label: 'High', description: 'Greater reasoning depth for complex problems' },
  { id: 'xhigh', label: 'Extra high', description: 'Extra high reasoning depth for complex problems' },
]);
const SOL_REASONING_LEVELS = Object.freeze([
  ...CODEX_REASONING_LEVELS,
  { id: 'max', label: 'Max', description: 'Maximum reasoning depth for the hardest problems' },
  { id: 'ultra', label: 'Ultra', description: 'Maximum reasoning with automatic task delegation' },
]);
const STATE_FILTERS = [
  { id: 'needs-approval', label: 'Needs approval' },
  { id: 'prompt-ready', label: 'Prompt ready' },
  { id: 'working', label: 'Working' },
  { id: 'ended', label: 'Ended' },
];
const DESKTOP_AGENTS_QUERY = '(min-width: 981px)';
function providerLabel(provider = '') {
  const normalized = normalizeProvider(provider);
  if (normalized === 'codex') return 'Codex';
  if (normalized === 'claude') return 'Claude';
  return normalized || 'Agent';
}

function sessionKindForProvider(provider = '', modelCatalog = null) {
  const normalized = normalizeProvider(provider);
  const entry = (modelCatalog?.providers || [])
    .find((item) => normalizeProvider(item?.id) === normalized);
  if (entry?.sessionKind || entry?.backendType) return String(entry.sessionKind || entry.backendType);
  if (normalized === 'codex' || normalized === 'claude') return normalized;
  return '';
}

function runtimeForProvider(provider = '', modelCatalog = null) {
  const normalized = normalizeProvider(provider);
  const entry = (modelCatalog?.providers || [])
    .find((item) => normalizeProvider(item?.id) === normalized);
  return String(entry?.runtime || entry?.backendType || entry?.sessionKind || normalized).trim();
}

function defaultModelForProvider(provider = '', modelCatalog = null) {
  const normalizedProvider = normalizeProvider(provider);
  const providerCatalog = modelCatalog?.providers || [];
  const catalogEntry = providerCatalog.find((entry) => normalizeProvider(entry?.id) === normalizedProvider) || null;
  const discoveredDefault = String(catalogEntry?.defaultModel || '').trim();
  if (discoveredDefault) return discoveredDefault;
  return FALLBACK_PROVIDER_MODELS[normalizedProvider] || '';
}

function isCodexSolModel(model = '') {
  const id = String(model || '').trim().toLowerCase();
  return id === 'gpt-6.1-sol' || id === 'gpt-5.6-sol';
}

function codexReasoningLevels(model = '') {
  return isCodexSolModel(model) ? SOL_REASONING_LEVELS : CODEX_REASONING_LEVELS;
}

function defaultThinkingLevelFor(provider = '', model = '') {
  return normalizeProvider(provider) === 'codex' && isCodexSolModel(model)
    ? 'low'
    : DEFAULT_THINKING_LEVEL;
}

function withDefaultModelChoice(provider = '', choices = [], modelCatalog = null) {
  const defaultModel = defaultModelForProvider(provider, modelCatalog);
  const normalizedChoices = Array.isArray(choices) ? choices : [];
  if (!defaultModel) return normalizedChoices;
  if (normalizedChoices.some((entry) => (entry?.id || entry) === defaultModel)) {
    return normalizedChoices;
  }
  return [{ id: defaultModel, label: defaultModel }, ...normalizedChoices];
}

function previewKey(session = {}) {
  return `${session._kind}:${session.id}`;
}

function previewTitle(session = {}) {
  return sessionTitle(session, session._kind, agentThreads.value);
}

function normalizedText(value) {
  return String(value || '').trim().toLowerCase();
}

function sessionSearchHaystack(session = {}) {
  return [
    session.name,
    session.displayName,
    session.sessionName,
    session.project,
    session.projectKey,
    session.workDir,
    session.id,
  ].map(normalizedText).join('\n');
}

function sessionStateFilter(session = {}) {
  const status = session.state?.status;
  if (status === 'ended') return 'ended';
  if (status === 'blocked') return 'needs-approval';
  if (status === 'ready') return 'prompt-ready';
  return 'working';
}

function isDesktopAgentsLayout() {
  return typeof window !== 'undefined' && window.matchMedia(DESKTOP_AGENTS_QUERY).matches;
}

function railProjectLabel(workDir = '') {
  const parts = String(workDir).replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.length > 1 ? parts.slice(-2).join('/') : workDir;
}

// The row body is a real button so Enter/Space, focus, and the disabled state
// come from the platform. The bulk-select checkbox stays outside it: a button
// must not contain another interactive control.
function AgentRailRow({ session, active, selected, onSelect, onToggleSelected, onStartLoop }) {
  const status = session.state?.status || 'unknown';
  const rustManaged = session.readOnly === true && session.externalOwner === 'rust-monitor';
  const mutable = !rustManaged;
  const title = previewTitle(session);
  const detail = session.state?.interaction?.detail || session.state?.reason || '';

  return html`
    <div class="agent-rail-row ${active ? 'agent-rail-row-active' : ''} ${status !== 'ended' ? 'agent-rail-row-has-loop' : ''}">
      <button
        type="button"
        class="agent-rail-row-main"
        aria-current=${active ? 'true' : undefined}
        title=${`Show ${title}`}
        onclick=${() => onSelect(session)}>
        <span class="agent-rail-row-topline">
          <span class="agent-rail-row-title">${title}</span>
        </span>
        <span class="agent-rail-row-meta">
          <span>${providerLabel(session._provider)}</span>
          ${session.workDir ? html`<span title=${session.workDir}>${railProjectLabel(session.workDir)}</span>` : null}
        </span>
        ${rustManaged ? html`
          <span class="agent-rail-row-flag">rust-managed · read-only</span>
        ` : null}
        ${detail ? html`<span class="agent-rail-row-detail">${detail}</span>` : null}
      </button>
      ${status !== 'ended' ? html`<button class="btn agent-rail-loop" type="button" onclick=${() => onStartLoop(session)}>Start loop</button>` : null}
      ${mutable && onToggleSelected ? html`
        <label class="agent-rail-select">
          <input
            type="checkbox"
            checked=${selected}
            aria-label=${`Bulk select ${title}`}
            onInput=${() => onToggleSelected(session)} />
          Bulk select
        </label>
      ` : null}
    </div>
  `;
}

function handleRailArrowKeys(event) {
  if (!event.target.classList?.contains('agent-rail-row-main')) return;
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const rows = Array.from(event.currentTarget.querySelectorAll('.agent-rail-row-main:not([disabled])'));
  const index = rows.indexOf(event.target);
  if (index === -1) return;
  event.preventDefault();
  const target = event.key === 'Home'
    ? rows[0]
    : event.key === 'End'
      ? rows[rows.length - 1]
      : rows[(index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length];
  target?.focus();
}

async function loadModelCatalog(modelCatalogState, modelCatalogLoading) {
  modelCatalogLoading.value = true;
  try {
    const [data, providerData] = await Promise.all([
      api.get('/agent-bus/model-catalog'),
      api.get('/agents/providers'),
    ]);
    const enabled = new Set((providerData?.providers || [])
      .filter((entry) => entry?.enabled !== false)
      .map((entry) => normalizeProvider(entry?.id)));
    const providers = (data?.providers || []).filter((entry) => enabled.has(normalizeProvider(entry?.id)));
    modelCatalogState.value = {
      ...(data || {}),
      providers,
      models: Object.fromEntries(providers.map((entry) => [entry.id, data?.models?.[entry.id] || []])),
    };
  } catch (e) {
    addToast(`Failed to load model catalog: ${e.message}`, 'error');
  } finally {
    modelCatalogLoading.value = false;
  }
}

async function loadAgentSessions(loading, loadError) {
  loading.value = true;
  loadError.value = '';
  try {
    await loadUnifiedAgentSessions();
  } catch (e) {
    loadError.value = e.message || 'Unable to load agents.';
    addToast(`Failed to load agents: ${e.message}`, 'error');
  } finally {
    loading.value = false;
  }
}

async function loadThreads() {
  try {
    const data = await api.get('/agent-bus/threads');
    agentThreads.value = data.threads || [];
  } catch {
    // Best effort
  }
}

async function sendClaudeShiftTab(id) {
  try {
    await api.post(`/claude/sessions/${id}/shift-tab`);
    addToast('Shift+Tab sent', 'success');
  } catch (e) {
    addToast(`Failed: ${e.message}`, 'error');
  }
}

async function sendEscape(kind, id) {
  try {
    await api.post(`/${kind}/sessions/${id}/escape`);
    addToast('Escape sent', 'success');
  } catch (e) {
    addToast(`Failed: ${e.message}`, 'error');
  }
}

function makeKillSession(loading, loadError, kind) {
  const label = kind === 'codex' ? 'Codex' : 'Agent';
  return async function killSession(session) {
    const id = session?.id;
    const sessionLabel = session?.name || id;
    if (!id) return;
    if (session?.readOnly === true && session?.externalOwner === 'rust-monitor') return;
    if (!window.confirm(`Kill ${label} session ${sessionLabel}?`)) return;
    try {
      await api.delete(`/${kind}/sessions/${encodeURIComponent(id)}`);
      removeSessionForKind(kind, id);
      addToast('Session killed', 'success');
      loadAgentSessions(loading, loadError);
    } catch (e) {
      addToast(`Failed: ${e.message}`, 'error');
    }
  };
}

function makeStartFreshSession(loading, loadError) {
  return async function startFreshSession(session) {
    if (!session?.workDir) {
      addToast('Fresh session needs a saved workdir', 'error');
      return;
    }
    try {
      const data = await api.post('/agents/sessions', {
        provider: session._provider || session._kind,
        workDir: session.workDir,
        displayName: session.displayName || '',
        model: session.model || '',
        thinkingLevel: session.thinkingLevel || DEFAULT_THINKING_LEVEL,
      });
      addToast(`Started fresh session ${data.sessionName || data.id}`, 'success');
      await loadAgentSessions(loading, loadError);
      route(`/${session._kind}/${data.id}`);
    } catch (e) {
      addToast(`Fresh session failed: ${e.message}`, 'error');
    }
  };
}

function makeResumeSession(loading, loadError) {
  const startFreshSession = makeStartFreshSession(loading, loadError);
  return async function resumeSession(session) {
    if (!session?.id || !session?._kind) return;
    try {
      const data = await api.post(`/${session._kind}/sessions/${session.id}/resume`);
      addToast(`Resumed ${data.sessionName || session.id}`, 'success');
      await loadAgentSessions(loading, loadError);
      route(`/${session._kind}/${session.id}`);
    } catch (e) {
      if (e.freshSession && window.confirm(`${e.message}\n\nStart a fresh session in the same workdir?`)) {
        await startFreshSession({ ...session, ...e.freshSession });
        return;
      }
      addToast(`Resume failed: ${e.message}`, 'error');
    }
  };
}

export function AgentsPage() {
  const loading = useMemo(() => signal(false), []);
  const loadError = useMemo(() => signal(''), []);
  const modelCatalogLoading = useMemo(() => signal(false), []);
  const modelCatalogState = useMemo(() => signal({ providers: [], models: {} }), []);
  const providerFilter = useMemo(() => signal('all'), []);
  const textFilter = useMemo(() => signal(''), []);
  const stateFilters = useMemo(() => signal([]), []);
  const previewKeys = useMemo(() => signal([]), []);
  const selectedSessionKeys = useMemo(() => signal([]), []);
  const bulkKillProgress = useMemo(() => signal(null), []);
  const bulkPrompt = useMemo(() => signal(''), []);
  const showBulkPrompt = useMemo(() => signal(false), []);
  const showNewModal = useMemo(() => signal(false), []);
  const showFolderPicker = useMemo(() => signal(false), []);
  const desktopLayout = useMemo(() => signal(isDesktopAgentsLayout()), []);
  const desktopSessionKey = useMemo(() => signal(''), []);
  const newProvider = useMemo(() => signal('codex'), []);
  const newModel = useMemo(() => signal(defaultModelForProvider('codex')), []);
  const newThinkingLevel = useMemo(() => signal(DEFAULT_THINKING_LEVEL), []);
  const newDisplayName = useMemo(() => signal(''), []);
  const newWorkDir = useMemo(() => signal(''), []);
  const newMcpSelection = useMemo(() => signal({
    mcpProfile: 'default',
    mcpServers: { add: [], remove: [] },
  }), []);
  const newPromptProfile = useMemo(() => signal('none'), []);
  const newMcpWarning = useMemo(() => signal(false), []);
  const newAdvancedOpen = useMemo(() => signal(false), []);
  const newPrompt = useMemo(() => signal(''), []);
  const newSkillInsert = useMemo(() => ({ current: null }), []);
  const newIsolatedWorktree = useMemo(() => signal(false), []);
  const creatingSession = useMemo(() => signal(false), []);

  const killClaudeSession = useMemo(() => makeKillSession(loading, loadError, 'claude'), []);
  const killCodexSession = useMemo(() => makeKillSession(loading, loadError, 'codex'), []);
  const killDeepseekSession = useMemo(() => makeKillSession(loading, loadError, 'deepseek'), []);
  const killPiSession = useMemo(() => makeKillSession(loading, loadError, 'pi'), []);
  const resumeSession = useMemo(() => makeResumeSession(loading, loadError), []);
  const startFreshSession = useMemo(() => makeStartFreshSession(loading, loadError), []);

  useEffect(() => {
    loadAgentSessions(loading, loadError);
    if (!modelCatalogLoading.value && modelCatalogState.value.providers.length === 0) {
      loadModelCatalog(modelCatalogState, modelCatalogLoading);
    }
    const interval = setInterval(() => {
      if (document.hidden || wsConnected.value) return;
      loadAgentSessions(loading, loadError);
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const media = window.matchMedia(DESKTOP_AGENTS_QUERY);
    const updateLayout = () => { desktopLayout.value = media.matches; };
    updateLayout();
    media.addEventListener('change', updateLayout);
    return () => media.removeEventListener('change', updateLayout);
  }, []);

  const providerChoices = modelCatalogState.value.providers?.length
    ? modelCatalogState.value.providers.map((provider) => ({
      id: normalizeProvider(provider.id),
      label: provider.label || providerLabel(provider.id),
    }))
    : PROVIDER_OPTIONS.filter((option) => option.id !== 'all');

  const newModelChoices = withDefaultModelChoice(
    newProvider.value,
    modelCatalogState.value.models?.[normalizeProvider(newProvider.value)] || [],
    modelCatalogState.value
  );
  const codexThinkingLevels = codexReasoningLevels(newModel.value);
  const advancedNeedsAttention = newMcpWarning.value
    || newPromptProfile.value !== 'none'
    || (newMcpSelection.value?.mcpServers?.add || []).length > 0
    || (newMcpSelection.value?.mcpServers?.remove || []).length > 0;
  useEffect(() => {
    if (advancedNeedsAttention) newAdvancedOpen.value = true;
  }, [advancedNeedsAttention]);
  const codexThinkingHelp = normalizeProvider(newProvider.value) === 'codex'
    ? (codexThinkingLevels.find((level) => level.id === newThinkingLevel.value)?.description || '')
    : '';

  function openNewModal(provider = 'codex') {
    const normalized = normalizeProvider(provider);
    showNewModal.value = true;
    showFolderPicker.value = false;
    newProvider.value = normalized;
    newModel.value = defaultModelForProvider(normalized, modelCatalogState.value);
    newThinkingLevel.value = defaultThinkingLevelFor(normalized, newModel.value);
    newMcpSelection.value = {
      mcpProfile: 'default',
      mcpServers: { add: [], remove: [] },
    };
    newPromptProfile.value = 'none';
    newMcpWarning.value = false;
    newAdvancedOpen.value = false;
    newPrompt.value = '';
    newIsolatedWorktree.value = false;
    if (!modelCatalogLoading.value && modelCatalogState.value.providers.length === 0) {
      loadModelCatalog(modelCatalogState, modelCatalogLoading);
    }
  }

  async function createSession(event) {
    event?.preventDefault?.();
    if (creatingSession.value) return;
    const provider = normalizeProvider(newProvider.value);
    const kind = sessionKindForProvider(provider, modelCatalogState.value);
    const body = {
      provider,
      displayName: newDisplayName.value.trim(),
      workDir: newWorkDir.value.trim(),
      model: newModel.value.trim(),
      thinkingLevel: newThinkingLevel.value.trim() || DEFAULT_THINKING_LEVEL,
      isolatedWorktree: newIsolatedWorktree.value,
    };
    body.mcpProfile = newMcpSelection.value.mcpProfile;
    body.mcpServers = newMcpSelection.value.mcpServers;
    body.promptProfile = newPromptProfile.value;
    if (newPrompt.value.trim()) body.initialPrompt = newPrompt.value;
    if (body.promptProfile === 'coordinator') {
      // Coordinators route decisions through the Command Queue, which needs the Cadre MCP.
      const { add = [], remove = [] } = body.mcpServers || {};
      body.mcpServers = { add: [...new Set([...add, 'dueno'])], remove: remove.filter((id) => id !== 'dueno') };
    }

    creatingSession.value = true;
    try {
      const data = await api.post('/agents/sessions', body);
      addToast(`Session created: ${data.sessionName || data.session?.sessionName || data.id}`, 'success');
      showNewModal.value = false;
      showFolderPicker.value = false;
      newDisplayName.value = '';
      newWorkDir.value = '';
      newMcpSelection.value = {
        mcpProfile: 'default',
        mcpServers: { add: [], remove: [] },
      };
      newPromptProfile.value = 'none';
      newPrompt.value = '';
      newIsolatedWorktree.value = false;
      await loadAgentSessions(loading, loadError);
      route(`/${data.backendType || kind}/${data.id}`);
    } catch (e) {
      addToast(`Failed to create session: ${e.message}`, 'error');
    } finally {
      creatingSession.value = false;
    }
  }

  const allSessions = buildUnifiedAgentSessions({
    claudeSessions: claudeSessions.value,
    codexSessions: codexSessions.value,
    deepseekSessions: deepseekSessions.value,
    piSessions: piSessions.value,
  });
  const recentDirs = recentWorkDirs([claudeSessions.value, codexSessions.value, deepseekSessions.value, piSessions.value]);
  const workDirOptions = Array.from(new Set(
    allSessions
      .map((session) => String(session.workDir || '').trim())
      .filter(Boolean)
  ));

  const visibleSessions = allSessions.filter((session) => {
    if (providerFilter.value !== 'all' && session._provider !== providerFilter.value) return false;
    const query = normalizedText(textFilter.value);
    if (query && !sessionSearchHaystack(session).includes(query)) return false;
    if (stateFilters.value.length > 0 && !stateFilters.value.includes(sessionStateFilter(session))) return false;
    return true;
  });
  const visibleKillableSessions = visibleSessions.filter((session) =>
    !(session.readOnly === true && session.externalOwner === 'rust-monitor')
  );
  const selectedKillableSessions = visibleKillableSessions.filter((session) =>
    selectedSessionKeys.value.includes(previewKey(session))
  );
  const allVisibleKillableSelected = visibleKillableSessions.length > 0
    && selectedKillableSessions.length === visibleKillableSessions.length;
  const previewSessions = previewKeys.value
    .map((key) => visibleSessions.find((session) => previewKey(session) === key) || allSessions.find((session) => previewKey(session) === key))
    .filter(Boolean);
  const desktopSession = visibleSessions.find((session) => previewKey(session) === desktopSessionKey.value)
    || visibleSessions[0]
    || null;

  useEffect(() => {
    const validKeys = new Set(allSessions.map((session) => previewKey(session)));
    selectedSessionKeys.value = selectedSessionKeys.value.filter((key) => validKeys.has(key));
  }, [allSessions.map((session) => previewKey(session)).join('|')]);

  useEffect(() => {
    if (!desktopLayout.value) return;
    const validKeys = new Set(visibleSessions.map((session) => previewKey(session)));
    if (!validKeys.has(desktopSessionKey.value)) {
      desktopSessionKey.value = visibleSessions[0] ? previewKey(visibleSessions[0]) : '';
    }
  }, [desktopLayout.value, visibleSessions.map((session) => previewKey(session)).join('|')]);

  useEffect(() => {
    if (!showNewModal.value && previewSessions.length === 0) return;
    if (!modelCatalogLoading.value && modelCatalogState.value.providers.length === 0) {
      loadModelCatalog(modelCatalogState, modelCatalogLoading);
    }
    if (previewSessions.length > 0 && agentThreads.value.length === 0) {
      loadThreads();
    }
  }, [showNewModal.value, previewSessions.length]);

  function togglePreview(session) {
    const key = previewKey(session);
    const exists = previewKeys.value.includes(key);
    previewKeys.value = exists
      ? previewKeys.value.filter((entry) => entry !== key)
      : [...previewKeys.value.filter((entry) => entry !== key), key].slice(-4);
  }

  function toggleSelected(session) {
    if (session.readOnly === true && session.externalOwner === 'rust-monitor') return;
    const key = previewKey(session);
    const exists = selectedSessionKeys.value.includes(key);
    selectedSessionKeys.value = exists
      ? selectedSessionKeys.value.filter((entry) => entry !== key)
      : [...selectedSessionKeys.value, key];
  }

  function toggleSelectAllVisible() {
    const visibleKeys = visibleKillableSessions.map((session) => previewKey(session));
    if (allVisibleKillableSelected) {
      selectedSessionKeys.value = selectedSessionKeys.value.filter((key) => !visibleKeys.includes(key));
      return;
    }
    selectedSessionKeys.value = Array.from(new Set([
      ...selectedSessionKeys.value,
      ...visibleKeys,
    ]));
  }

  async function killSelectedSessions() {
    if (bulkKillProgress.value) return;
    const sessions = selectedKillableSessions;
    if (sessions.length === 0) return;
    if (!window.confirm(`Kill ${sessions.length} selected session${sessions.length === 1 ? '' : 's'}?`)) return;

    bulkKillProgress.value = { completed: 0, total: sessions.length };
    try {
      const results = await settleWithConcurrency(
        sessions,
        (session) => api.delete(`/${session._kind}/sessions/${encodeURIComponent(session.id)}`).then((value) => {
          removeSessionForKind(session._kind, session.id);
          return value;
        }),
        {
          concurrency: 4,
          onProgress: ({ completed, total }) => {
            bulkKillProgress.value = { completed, total };
          },
        },
      );
      const succeeded = results.filter((result) => result.status === 'fulfilled').length;
      const failed = results.length - succeeded;

      if (failed === 0) {
        addToast(`Killed ${succeeded} session${succeeded === 1 ? '' : 's'}`, 'success');
      } else {
        const firstError = results.find((result) => result.status === 'rejected')?.reason?.message;
        addToast(
          `Killed ${succeeded} session${succeeded === 1 ? '' : 's'}; ${failed} failed${firstError ? `: ${firstError}` : ''}`,
          'error',
        );
      }

      const terminatedKeys = sessions
        .filter((_, index) => results[index]?.status === 'fulfilled')
        .map((session) => previewKey(session));
      selectedSessionKeys.value = selectedSessionKeys.value.filter((key) => !terminatedKeys.includes(key));
      await loadAgentSessions(loading, loadError);
    } finally {
      bulkKillProgress.value = null;
    }
  }

  async function escapeSelectedSessions() {
    const sessions = selectedKillableSessions;
    if (sessions.length === 0) return;
    const results = await Promise.allSettled(
      sessions.map((session) => api.post(`/${session._kind}/sessions/${session.id}/escape`))
    );
    const succeeded = results.filter((result) => result.status === 'fulfilled').length;
    const failed = results.length - succeeded;
    addToast(
      failed === 0
        ? `Esc sent to ${succeeded} session${succeeded === 1 ? '' : 's'}`
        : `Esc sent to ${succeeded} session${succeeded === 1 ? '' : 's'}; ${failed} failed`,
      failed === 0 ? 'success' : 'error'
    );
    await loadAgentSessions(loading, loadError);
  }

  async function sendPromptToSelectedSessions() {
    const sessions = selectedKillableSessions;
    const prompt = bulkPrompt.value.trim();
    if (sessions.length === 0 || !prompt) return;
    const results = await Promise.allSettled(
      sessions.map((session) => api.post(`/${session._kind}/sessions/${session.id}/input`, {
        text: prompt,
        enter: true,
        source: 'ui',
      }))
    );
    const succeeded = results.filter((result) => result.status === 'fulfilled').length;
    const failed = results.length - succeeded;
    addToast(
      failed === 0
        ? `Sent prompt to ${succeeded} session${succeeded === 1 ? '' : 's'}`
        : `Sent prompt to ${succeeded} session${succeeded === 1 ? '' : 's'}; ${failed} failed`,
      failed === 0 ? 'success' : 'error'
    );
    if (failed === 0) bulkPrompt.value = '';
    await loadAgentSessions(loading, loadError);
  }

  function startLoop(session) {
    route(`/loop-sessions?kind=${encodeURIComponent(session._kind)}&session_id=${encodeURIComponent(session.id)}`);
  }

  function toggleStateFilter(id) {
    stateFilters.value = stateFilters.value.includes(id)
      ? stateFilters.value.filter((entry) => entry !== id)
      : [...stateFilters.value, id];
  }

  function removePreview(session) {
    previewKeys.value = previewKeys.value.filter((entry) => entry !== previewKey(session));
  }

  return html`
    <div class="page">
      ${desktopLayout.value ? html`
        <div class="agents-desktop-toolbar">
          <h1 class="agents-desktop-toolbar-title">Agents</h1>
          <button class="btn btn-primary" onclick=${() => openNewModal('codex')}>New</button>
          <input
            class="input agents-desktop-search"
            placeholder="Search agents"
            aria-label="Search agents"
            value=${textFilter.value}
            onInput=${e => { textFilter.value = e.target.value; }} />
          <select
            class="input agents-desktop-provider"
            aria-label="Filter by provider"
            value=${providerFilter.value}
            onInput=${e => { providerFilter.value = e.target.value; }}>
            ${[{ id: 'all', label: 'All providers' }, ...providerChoices].map((option) => html`
              <option value=${option.id}>${option.label}</option>
            `)}
          </select>
          <details class="agents-filter-menu">
            <summary class="btn">Filters${stateFilters.value.length ? ` (${stateFilters.value.length})` : ''}</summary>
            <div class="agents-filter-popover">
              ${STATE_FILTERS.map((filter) => html`
                <label class="agents-filter-option">
                  <input
                    type="checkbox"
                    checked=${stateFilters.value.includes(filter.id)}
                    onInput=${() => toggleStateFilter(filter.id)} />
                  ${filter.label}
                </label>
              `)}
            </div>
          </details>
          <button class="btn" onclick=${() => loadAgentSessions(loading, loadError)}>Refresh</button>
          ${visibleKillableSessions.length > 0 ? html`
            <label class="agents-toolbar-select-all">
              <input
                type="checkbox"
                checked=${allVisibleKillableSelected}
                onInput=${toggleSelectAllVisible} />
              All
            </label>
          ` : null}
          <button
            class="btn"
            type="button"
            disabled=${selectedKillableSessions.length === 0}
            title="Send Escape to selected sessions"
            onclick=${escapeSelectedSessions}>
            Esc${selectedKillableSessions.length > 0 ? ` ${selectedKillableSessions.length}` : ''}
          </button>
          <button
            class="btn btn-danger"
            type="button"
            disabled=${selectedKillableSessions.length === 0 || Boolean(bulkKillProgress.value)}
            onclick=${killSelectedSessions}>
            ${bulkKillProgress.value
              ? `Killing ${bulkKillProgress.value.completed}/${bulkKillProgress.value.total}`
              : `Kill${selectedKillableSessions.length > 0 ? ` ${selectedKillableSessions.length}` : ''}`}
          </button>
          <button
            class="btn"
            type="button"
            disabled=${selectedKillableSessions.length === 0}
            aria-expanded=${showBulkPrompt.value ? 'true' : 'false'}
            onclick=${() => { showBulkPrompt.value = !showBulkPrompt.value; }}>
            Prompt
          </button>
        </div>
        ${showBulkPrompt.value ? html`
          <div class="agents-bulk-prompt-bar">
            <input
              class="input"
              placeholder="Prompt selected sessions"
              aria-label="Bulk prompt to selected sessions"
              value=${bulkPrompt.value}
              onInput=${e => { bulkPrompt.value = e.target.value; }} />
            <button
              class="btn btn-primary"
              type="button"
              disabled=${selectedKillableSessions.length === 0 || !bulkPrompt.value.trim()}
              onclick=${sendPromptToSelectedSessions}>
              Send${selectedKillableSessions.length > 0 ? ` ${selectedKillableSessions.length}` : ''}
            </button>
            <button class="btn" type="button" onclick=${() => { showBulkPrompt.value = false; }}>Close</button>
          </div>
        ` : null}
      ` : html`
      <div class="card-header">
        <h1 class="card-title" style="font-size:18px">Agents</h1>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
          <button class="btn" onclick=${() => loadAgentSessions(loading, loadError)}>Refresh</button>
          <button class="btn btn-primary" onclick=${() => openNewModal('codex')}>New</button>
          <select
            class="input"
            style="min-width:160px"
            value=${providerFilter.value}
            onInput=${e => { providerFilter.value = e.target.value; }}>
            ${[{ id: 'all', label: 'All providers' }, ...providerChoices].map((option) => html`
              <option value=${option.id}>${option.label}</option>
            `)}
          </select>
          <input
            class="input"
            style="min-width:220px"
            placeholder="Search agents"
            value=${textFilter.value}
            onInput=${e => { textFilter.value = e.target.value; }} />
        </div>
      </div>
      `}

      ${showNewModal.value ? html`
        <form
          class="card new-agent-form"
          onSubmit=${createSession}
          onKeyDown=${e => {
            if (e.key !== 'Escape') return;
            if (showFolderPicker.value) { showFolderPicker.value = false; return; }
            if (newPrompt.value.trim()) return;
            showNewModal.value = false;
          }}>
          <div class="card-header">
            <span class="card-title">New Agent Session</span>
            <button class="btn" type="button" onclick=${() => { showNewModal.value = false; showFolderPicker.value = false; }}>Cancel</button>
          </div>

          <div class="new-agent-section new-agent-prompt">
            <${SkillPromptComposer}
              value=${newPrompt}
              insertRef=${newSkillInsert}
              multiline=${true}
              className="input"
              placeholder="What should this agent work on? Optional - you can also prompt after launch."
              ariaLabel="Initial prompt"
            />
            <div class="new-agent-prompt-tools">
              <${LaunchSkillSelector}
                compact=${true}
                onInsert=${(id) => newSkillInsert.current?.(id)} />
              <button
                type="button"
                class="btn"
                title="Open the skill writer with this prompt text"
                disabled=${!newPrompt.value.trim()}
                onclick=${() => openSkillWriterWithDraft(newPrompt.value)}>
                Save as skill
              </button>
              <span class="new-agent-hint">Inserted skills expand when the session starts.</span>
            </div>
          </div>

          <div class="new-agent-setup-grid">
            <label class="new-agent-field">
              <span>Provider</span>
              <select
                class="input"
                value=${newProvider.value}
                onInput=${e => {
                  const provider = normalizeProvider(e.target.value);
                  newProvider.value = provider;
                  newModel.value = defaultModelForProvider(provider, modelCatalogState.value);
                  newThinkingLevel.value = defaultThinkingLevelFor(provider, newModel.value);
                }}>
                ${providerChoices.map((option) => html`
                  <option value=${option.id}>${option.label}</option>
                `)}
              </select>
            </label>
            <label class="new-agent-field">
              <span>Model</span>
              <select
                class="input"
                value=${newModel.value}
                onInput=${e => {
                  newModel.value = e.target.value;
                  newThinkingLevel.value = defaultThinkingLevelFor(newProvider.value, newModel.value);
                }}>
                ${newModelChoices.length === 0 ? html`
                  <option value=${newModel.value}>${newModel.value || 'Loading models...'}</option>
                ` : newModelChoices.map((model) => html`
                  <option value=${model.id || model}>${model.label || model.id || model}</option>
                `)}
              </select>
            </label>
            <label class="new-agent-field">
              <span>Thinking level</span>
              ${normalizeProvider(newProvider.value) === 'codex' ? html`
                <select
                  class="input"
                  value=${newThinkingLevel.value}
                  onInput=${e => { newThinkingLevel.value = e.target.value; }}>
                  ${codexThinkingLevels.map((level) => html`
                    <option value=${level.id} title=${level.description}>${level.label}</option>
                  `)}
                </select>
              ` : html`
                <input
                  class="input"
                  placeholder=${DEFAULT_THINKING_LEVEL}
                  value=${newThinkingLevel.value}
                  onInput=${e => { newThinkingLevel.value = e.target.value; }} />
              `}
            </label>
            <label class="new-agent-field">
              <span>Name</span>
              <input
                class="input"
                placeholder="Optional label"
                value=${newDisplayName.value}
                onInput=${e => { newDisplayName.value = e.target.value; }} />
            </label>
          </div>
          ${codexThinkingHelp ? html`
            <p class="new-agent-hint">${codexThinkingHelp}</p>
          ` : null}

          <div class="new-agent-section">
            <label class="new-agent-field-label" for="agents-workdir-input">Workdir</label>
            <${DirQuickSelect}
              value=${newWorkDir.value}
              recents=${recentDirs}
              onSelect=${(path) => { newWorkDir.value = path; }}
            />
            <div class="new-agent-workdir-row">
              <input
                id="agents-workdir-input"
                class="input new-agent-workdir-input"
                list="agents-workdir-options"
                placeholder=${DEFAULT_WORKDIR_PLACEHOLDER}
                value=${newWorkDir.value}
                onInput=${e => { newWorkDir.value = e.target.value; }}
                autocomplete="off" />
              <button class="btn" type="button" onclick=${() => { showFolderPicker.value = !showFolderPicker.value; }}>Browse</button>
            </div>
            <datalist id="agents-workdir-options">
              ${workDirOptions.map((path) => html`<option value=${path}></option>`)}
            </datalist>
            ${showFolderPicker.value ? html`
              <div class="new-agent-folder-picker">
                <${FolderPicker}
                  onSelect=${(path) => { newWorkDir.value = path; showFolderPicker.value = false; }}
                  onCancel=${() => { showFolderPicker.value = false; }}
                />
              </div>
            ` : null}
            <label class="new-agent-check">
              <input
                type="checkbox"
                checked=${newIsolatedWorktree.value}
                onInput=${e => { newIsolatedWorktree.value = e.target.checked; }} />
              <span>Isolated git worktree</span>
              <span class="new-agent-hint">fresh branch from origin/main or origin/master</span>
            </label>
            <label class="new-agent-check">
              <input
                type="checkbox"
                checked=${newPromptProfile.value === 'coordinator'}
                onInput=${e => { newPromptProfile.value = e.target.checked ? 'coordinator' : 'none'; }} />
              <span>Coordinator</span>
              <span class="new-agent-hint">runs workers and sends your decisions to the Queue</span>
            </label>
          </div>

          <details
            class="new-agent-advanced"
            open=${newAdvancedOpen.value}
            onToggle=${e => { newAdvancedOpen.value = e.target.open; }}>
            <summary>
              Advanced
              <span class="new-agent-hint">style prompt, MCP capabilities</span>
            </summary>
            <div class="new-agent-advanced-body">
              <${PromptProfileSelector}
                value=${newPromptProfile.value}
                onChange=${(profileId) => { newPromptProfile.value = profileId; }} />
              <${McpCapabilitySelector}
                provider=${newProvider.value}
                runtime=${runtimeForProvider(newProvider.value, modelCatalogState.value)}
                value=${newMcpSelection.value}
                onWarning=${(warning) => { newMcpWarning.value = warning; }}
                onChange=${(selection) => { newMcpSelection.value = selection; }} />
            </div>
          </details>

          <div class="new-agent-footer">
            <button class="btn btn-primary" type="submit" disabled=${creatingSession.value}>
              ${creatingSession.value ? 'Creating...' : 'Create Session'}
            </button>
            <button class="btn" type="button" onclick=${() => loadModelCatalog(modelCatalogState, modelCatalogLoading)}>Refresh Models</button>
            ${modelCatalogLoading.value ? html`
              <span class="new-agent-hint">Loading models...</span>
            ` : null}
          </div>
        </form>
      ` : null}

      ${!desktopLayout.value ? html`<div style="display:flex; gap:6px; flex-wrap:wrap; margin:0 0 12px 0">
        ${STATE_FILTERS.map((filter) => html`
          <button
            type="button"
            class="btn ${stateFilters.value.includes(filter.id) ? 'btn-primary' : ''}"
            style="font-size:11px; padding:4px 10px"
            onclick=${() => toggleStateFilter(filter.id)}>
            ${filter.label}
          </button>
        `)}
      </div>` : null}

      ${!desktopLayout.value && previewSessions.length > 0 ? html`
        <div class="card" style="margin-bottom:12px">
          <div class="card-header" style="margin-bottom:10px">
            <span class="card-title">Live Preview</span>
            <span style="font-size:11px; color:var(--text-muted)">Pinned previews stay here while you decide which session to open.</span>
          </div>
          <div class="grid grid-2">
            ${previewSessions.map((session) => html`
              <${LiveSessionPreview}
                session=${session}
                title=${previewTitle(session)}
                onRemove=${removePreview}
              />
            `)}
          </div>
        </div>
      ` : null}

      ${!desktopLayout.value ? html`<div class="card" style="margin-bottom:12px">
        <div class="card-header" style="margin-bottom:0">
          <span class="card-title">Fleet</span>
          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap">
            <span style="font-size:11px; color:var(--text-muted)">
              ${visibleSessions.length} shown of ${allSessions.length}
            </span>
            ${visibleKillableSessions.length > 0 ? html`
              <label style="display:flex; align-items:center; gap:6px; font-size:11px; color:var(--text-secondary)">
                <input
                  type="checkbox"
                  checked=${allVisibleKillableSelected}
                  onInput=${toggleSelectAllVisible} />
                Select all shown
              </label>
            ` : null}
            <button
              class="btn"
              type="button"
              disabled=${selectedKillableSessions.length === 0}
              onclick=${escapeSelectedSessions}
            >
              Esc Selected${selectedKillableSessions.length > 0 ? ` (${selectedKillableSessions.length})` : ''}
            </button>
            <button
              class="btn btn-danger"
              type="button"
              disabled=${selectedKillableSessions.length === 0 || Boolean(bulkKillProgress.value)}
              onclick=${killSelectedSessions}
            >
              ${bulkKillProgress.value
                ? `Killing ${bulkKillProgress.value.completed}/${bulkKillProgress.value.total}`
                : `Kill Selected${selectedKillableSessions.length > 0 ? ` (${selectedKillableSessions.length})` : ''}`}
            </button>
          </div>
        </div>
        <div style="display:flex; gap:8px; margin-top:10px; align-items:flex-start">
          <textarea
            class="input"
            rows="2"
            placeholder="Bulk prompt to selected sessions"
            value=${bulkPrompt.value}
            onInput=${e => { bulkPrompt.value = e.target.value; }}
            style="min-height:48px; resize:vertical"></textarea>
          <button
            class="btn btn-primary"
            type="button"
            disabled=${selectedKillableSessions.length === 0 || !bulkPrompt.value.trim()}
            onclick=${sendPromptToSelectedSessions}
          >
            Send Selected${selectedKillableSessions.length > 0 ? ` (${selectedKillableSessions.length})` : ''}
          </button>
        </div>
      </div>` : null}

      ${loading.value
        ? html`<${LoadingState} message="Loading agents..." />`
        : loadError.value
          ? html`<${ErrorState} message=${`Agents failed to load: ${loadError.value}`} actionLabel="Retry" onAction=${() => loadAgentSessions(loading, loadError)} />`
        : visibleSessions.length === 0
          ? html`<${EmptyState} message=${`No ${providerFilter.value === 'all' ? '' : providerLabel(providerFilter.value) + ' '}sessions match the current filters.`} />`
          : desktopLayout.value ? html`
            <div class="agents-desktop-shell">
              <aside class="agents-desktop-rail" aria-label="Agent sessions">
                <div class="agents-desktop-rail-head">
                  <span class="card-title">Sessions</span>
                  <span aria-label=${`${visibleSessions.length} sessions listed`}>${visibleSessions.length}</span>
                </div>
                <div class="agents-desktop-rail-list" onKeyDown=${handleRailArrowKeys}>
                  ${visibleSessions.map((session) => html`
                    <${AgentRailRow}
                      key=${previewKey(session)}
                      session=${session}
                      active=${desktopSession && previewKey(desktopSession) === previewKey(session)}
                      selected=${selectedSessionKeys.value.includes(previewKey(session))}
                      onSelect=${selected => { desktopSessionKey.value = previewKey(selected); }}
                      onToggleSelected=${toggleSelected}
                      onStartLoop=${startLoop}
                    />
                  `)}
                </div>
              </aside>
              <section class="agents-desktop-detail" aria-label="Selected agent detail">
                ${desktopSession ? html`
                  <${AgentSessionDetailPage}
                    key=${previewKey(desktopSession)}
                    id=${desktopSession.id}
                    provider=${desktopSession._kind}
                    embedded=${true}
                  />
                ` : html`
                  <${EmptyState} message="No agent session to show." />
                `}
              </section>
            </div>
          ` : html`
            <div class="grid grid-2 agents-card-grid">
              ${visibleSessions.map((session) => html`
                <div>
                  <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px; flex-wrap:wrap">
                    <span class="badge badge-info">${providerLabel(session._provider)}</span>
                    <span class="badge">${session._kind}</span>
                    ${session.readOnly === true && session.externalOwner === 'rust-monitor' ? html`
                      <span class="badge badge-low">rust-managed</span>
                      <span class="badge badge-low">read-only</span>
                    ` : html`
                      <span class="badge badge-success">interactive</span>
                    `}
                  </div>
                  <${SessionCard}
                    session=${session}
                    provider=${session._kind}
                    onShiftTab=${session._kind === 'claude' ? sendClaudeShiftTab : undefined}
                    onEscape=${(id) => sendEscape(session._kind, id)}
                    onKill=${session._kind === 'claude'
                      ? killClaudeSession
                      : session._kind === 'pi'
                        ? killPiSession
                        : session._kind === 'deepseek'
                          ? killDeepseekSession
                          : killCodexSession}
                    onResume=${resumeSession}
                    onStartFresh=${startFreshSession}
                    onStartLoop=${startLoop}
                    selected=${selectedSessionKeys.value.includes(previewKey(session))}
                    onToggleSelected=${toggleSelected}
                    extraActions=${html`
                      <button class="btn" type="button" onclick=${() => togglePreview(session)}>
                        ${previewKeys.value.includes(previewKey(session)) ? 'Unpin' : 'Preview'}
                      </button>
                    `}
                  />
                </div>
              `)}
            </div>
          `}
    </div>
  `;
}
