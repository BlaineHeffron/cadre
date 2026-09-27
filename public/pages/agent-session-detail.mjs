import { h } from 'preact';
import { useEffect, useMemo } from 'preact/hooks';
import { route } from 'preact-router';
import { providerDescriptor } from '../app/providers.mjs';
import { useSignal } from '../app/use-signal.mjs';
import { api } from '../app/api.mjs';
import {
  findSessionNeighbors,
  loadUnifiedAgentSessions,
  navigateToAgentSession,
} from '../app/agent-session-nav.mjs';
import {
  buildQuickInsertOptions,
  buildQuickInsertPrompt,
  copyText,
  linkedThreadsForSession,
} from '../app/agent-bus-ui.mjs';
import { expandQuickTokens, quickTokenLabel } from '../app/skill-tokens.mjs';
import { subscribe } from '../app/ws-client.mjs';
import { shouldReduceNetworkActivity } from '../app/network-profile.mjs';
import { createRevisionGuard } from '../app/revision-guard.mjs';
import { addToast, agentThreads, markSessionSeenForKind, markSessionAttentionSeen, removeSessionForKind } from '../app/state.mjs';
import { isEditableTarget, mapKeyboardEventToTmux } from '../app/terminal-input.mjs';
import { Terminal, stripAnsi } from '../components/terminal.mjs';
import { AgentControlBar } from '../components/agent-control-bar.mjs';
import { TerminalKeys } from '../components/terminal-keys.mjs';
import { RenderedTranscript } from '../components/rendered-transcript.mjs';

function isActiveThread(thread) {
  if (!thread) return false;
  if (thread.status !== 'open') return false;
  return !(thread.metadata?.missingParticipants?.length);
}

const INITIAL_LINES = 200;
const FULL_LINES = 2000;

async function loadImageDataUrl(file) {
  const original = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Unable to read image'));
    reader.readAsDataURL(file);
  });

  // Phone photos can approach the JSON body limit and look like a dead Send
  // button while their base64 payload uploads. Bound attachment dimensions and
  // encode a much smaller JPEG before it ever reaches the request path.
  if (file.type === 'image/gif' || file.size <= 1024 * 1024) return original;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    const maxDimension = 2048;
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.86);
  } catch {
    return original;
  } finally {
    bitmap?.close?.();
  }
}

export function AgentSessionDetailPage({ id, provider = 'claude', embedded = false }) {
  const descriptor = providerDescriptor(provider);
  const providerKind = descriptor.kind;
  const providerApiBase = descriptor.apiBase;
  const providerLabel = descriptor.label;
  const content = useSignal('');
  const inputText = useSignal('');
  const sessionState = useSignal({
    status: 'unknown',
    reason: 'Awaiting session state',
    revision: 0,
    capabilities: {
      canQueueMessage: false,
      canSendNow: false,
      canAnswerInteraction: false,
      canInterrupt: false,
      sendMessage: false,
    },
    interaction: { kind: 'none', detail: '', options: [], fingerprint: '' },
  });
  const sessionInfo = useSignal({ sessionName: '', displayName: '', source: '', provider: providerKind, runtime: providerKind });
  const tmuxCapabilities = useSignal({ canOpenTerminal: false, preferredTerminal: 'terminator' });
  const participantsState = useSignal({ sessions: {} });
  const siblingSessions = useSignal([]);
  const loading = useSignal(false);
  const loadedLines = useSignal(INITIAL_LINES);
  const loadingMore = useSignal(false);
  const keyQueue = useMemo(() => ({ chain: Promise.resolve() }), []);
  const contentRevision = useMemo(createRevisionGuard, []);
  const imageDraft = useSignal({ imageDataUrl: '' });
  const imageSending = useSignal(false);
  const renderedTranscript = useSignal(false);
  // Raw model text pulled from the provider's session log. The tmux pane holds
  // the CLI's already-rendered TUI output, which destroys LaTeX delimiters, so
  // the rendered view must not be built from it.
  const transcriptRaw = useSignal({ status: 'idle', text: '', error: '' });

  useEffect(() => {
    let cancelled = false;
    contentRevision.advance();
    content.value = '';
    sessionState.value = {
      status: 'unknown',
      reason: 'Awaiting session state',
      revision: 0,
      capabilities: {
        canQueueMessage: false,
        canSendNow: false,
        canAnswerInteraction: false,
        canInterrupt: false,
        sendMessage: false,
      },
      interaction: { kind: 'none', detail: '', options: [], fingerprint: '' },
    };
    sessionInfo.value = { sessionName: '', displayName: '', source: '', provider: providerKind, runtime: providerKind };
    loadedLines.value = INITIAL_LINES;
    imageDraft.value = { imageDataUrl: '' };
    imageSending.value = false;
    renderedTranscript.value = false;
    transcriptRaw.value = { status: 'idle', text: '', error: '' };

    markSessionSeenForKind(providerKind, id);
    const initialLines = shouldReduceNetworkActivity() ? INITIAL_LINES : FULL_LINES;
    loadContent(id, initialLines, descriptor, () => !cancelled);
    const unsub = subscribe(`${providerKind}:session:${id}`, (type, data) => {
      if (cancelled) return;
      if (type === 'content') {
        contentRevision.advance();
        content.value = data.content;
        if (data.state) sessionState.value = data.state;
        if (data.attention) markSessionAttentionSeen(providerKind, data);
      }
    }, { lines: initialLines });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [id, providerKind, providerApiBase]);

  useEffect(() => {
    async function handlePaste(event) {
      const items = [...(event.clipboardData?.items || [])];
      const imageItem = items.find((item) => item.type.startsWith('image/'));
      if (!imageItem) return;
      event.preventDefault();
      const file = imageItem.getAsFile();
      if (!file) return;
      await attachImageFile(file);
      addToast(`Clipboard image ready to send to ${providerLabel}`, 'success');
    }

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [providerLabel]);

  useEffect(() => {
    loadCollabData();
    loadTmuxCapabilities();
    // Embedded panels hide the prev/next controls, so the sibling fetch would
    // only burn requests and overwrite the host page's session signals with a
    // read-only-excluded list.
    if (!embedded) loadSiblingSessions();
  }, [id, providerKind, embedded]);

  async function loadRawTranscript(sessionId, activeDescriptor = descriptor) {
    transcriptRaw.value = { status: 'loading', text: '', error: '' };
    try {
      const data = await api.get(`${activeDescriptor.apiBase}/sessions/${sessionId}/transcript`);
      if (sessionId !== id) return;
      const text = String(data?.text || '');
      transcriptRaw.value = text
        ? { status: 'ok', text, error: '' }
        : { status: 'error', text: '', error: 'session log held no conversation text' };
    } catch (error) {
      if (sessionId !== id) return;
      transcriptRaw.value = { status: 'error', text: '', error: error?.message || 'request failed' };
    }
  }

  async function loadContent(sessionId, lines, activeDescriptor = descriptor, shouldApply = () => true) {
    const requestRevision = contentRevision.capture();
    loading.value = true;
    try {
      const data = await api.get(`${activeDescriptor.apiBase}/sessions/${sessionId}?lines=${lines || INITIAL_LINES}`);
      if (!shouldApply()) return;
      if (contentRevision.isCurrent(requestRevision)) {
        contentRevision.advance();
        content.value = data.content;
        loadedLines.value = data.lines || lines || INITIAL_LINES;
        if (data.state) sessionState.value = data.state;
        if (data.attention) markSessionAttentionSeen(activeDescriptor.kind, data);
      }
      sessionInfo.value = {
        sessionName: data.sessionName || '',
        displayName: data.displayName || '',
        source: data.source || '',
        provider: data.provider || activeDescriptor.kind,
        runtime: data.runtime || activeDescriptor.kind,
        workDir: data.workDir || '',
        model: data.model || '',
        thinkingLevel: data.thinkingLevel || '',
        attachCommand: data.attachCommand || '',
        readOnly: data.readOnly === true,
        externalOwner: data.externalOwner || null,
        canResume: data.canResume === true,
        resumeBlockedReason: data.resumeBlockedReason || '',
      };
    } catch (e) {
      if (!shouldApply()) return;
      addToast(`Failed to load session: ${e.message}`, 'error');
    } finally {
      if (shouldApply()) loading.value = false;
    }
  }

  async function loadMoreHistory() {
    if (loadingMore.value || loadedLines.value >= FULL_LINES) return;
    loadingMore.value = true;
    try {
      const data = await api.get(`${descriptor.apiBase}/sessions/${id}?lines=${FULL_LINES}`);
      content.value = data.content;
      loadedLines.value = FULL_LINES;
    } catch (e) {
      addToast(`Failed to load history: ${e.message}`, 'error');
    } finally {
      loadingMore.value = false;
    }
  }

  async function loadCollabData() {
    try {
      const [participants, threads] = await Promise.all([
        api.get('/agent-bus/participants').catch(() => ({ sessions: {} })),
        api.get('/agent-bus/threads').catch(() => ({ threads: [] })),
      ]);
      participantsState.value = participants || { sessions: {} };
      agentThreads.value = threads?.threads || [];
    } catch {
      // Best effort
    }
  }

  async function loadTmuxCapabilities() {
    try {
      tmuxCapabilities.value = await api.get('/tmux/capabilities');
    } catch {
      tmuxCapabilities.value = { canOpenTerminal: false, preferredTerminal: 'terminator' };
    }
  }

  async function loadSiblingSessions() {
    try {
      siblingSessions.value = await loadUnifiedAgentSessions();
    } catch {
      siblingSessions.value = [];
    }
  }

  async function sendShiftTab() {
    if (!descriptor.hasShiftTab) return;
    try {
      await api.post(`${descriptor.apiBase}/sessions/${id}/shift-tab`);
    } catch (e) {
      addToast(`Failed: ${e.message}`, 'error');
    }
  }

  async function sendEscape() {
    try {
      await api.post(`${descriptor.apiBase}/sessions/${id}/escape`);
    } catch (e) {
      addToast(`Failed: ${e.message}`, 'error');
    }
  }

  async function sendInput() {
    // One composer serves both plain text and image messages: an attached
    // image turns the same draft into the image caption.
    if (imageDraft.value.imageDataUrl) {
      await sendImageToSession();
      return;
    }
    const raw = inputText.value;
    const text = resolveQuickInserts(raw);
    if (text === null) return;
    if (!text) {
      try {
        await api.post(`${descriptor.apiBase}/sessions/${id}/enter`);
      } catch (e) {
        addToast(`Failed: ${e.message}`, 'error');
      }
      return;
    }
    inputText.value = '';
    try {
      const result = await api.post(`${descriptor.apiBase}/sessions/${id}/input`, { text, enter: true, source: 'ui' });
      if (result?.state === 'queued') addToast('Message queued for delivery', 'success');
    } catch (e) {
      inputText.value = inputText.value ? `${raw}${inputText.value}` : raw;
      addToast(`Failed: ${e.message}`, 'error');
    }
  }

  // Returns false when the draft must survive in the composer: the control bar
  // only clears it on a confirmed schedule.
  async function scheduledSend(rawText, delayMs) {
    const text = resolveQuickInserts(rawText);
    if (text === null) return false;
    if (!text) {
      addToast('Nothing to schedule', 'error');
      return false;
    }
    try {
      const result = await api.post(`${descriptor.apiBase}/sessions/${id}/scheduled-send`, { text, delayMs, source: 'ui' });
      const label = delayMs >= 60000 ? `${Math.round(delayMs / 60000)}m` : `${Math.round(delayMs / 1000)}s`;
      addToast(`Scheduled in ${label} (${new Date(result.sendAt).toLocaleTimeString()})`, 'success');
      return true;
    } catch (e) {
      addToast(`Schedule failed: ${e.message}`, 'error');
      return false;
    }
  }

  async function sendDialogAnswer(option) {
    const text = typeof option === 'string'
      ? option
      : String(option?.key ?? option?.value ?? option?.index ?? option?.label ?? '');
    if (!text) return;
    try {
      const path = `${descriptor.apiBase}/sessions/${id}`;
      const guards = {
        expectedRevision: sessionState.value.revision,
        expectedFingerprint: sessionState.value.interaction?.fingerprint || '',
        expectedInteractionKind: sessionState.value.interaction?.kind || '',
      };
      if (/^[a-z0-9]$/i.test(text)) {
        await api.post(`${path}/keys`, { keys: text, ...guards });
      } else {
        await api.post(`${path}/input`, {
          text,
          enter: true,
          source: 'ui_dialog_answer',
          ...guards,
        });
      }
    } catch (e) {
      addToast(`Failed: ${e.message}`, 'error');
    }
  }

  async function sendSlashCommand(cmd) {
    if (!descriptor.hasSlash) return;
    try {
      await api.post(`${descriptor.apiBase}/sessions/${id}/input`, { text: cmd, enter: true, source: 'ui' });
    } catch (e) {
      addToast(`Failed: ${e.message}`, 'error');
    }
  }

  function enqueueKeyAction(task) {
    keyQueue.chain = keyQueue.chain
      .then(task)
      .catch((e) => {
        addToast(`Keyboard send failed: ${e.message}`, 'error');
      });
  }

  function handleTerminalKeyDown(event) {
    if (sessionInfo.value.readOnly === true && sessionInfo.value.externalOwner === 'rust-monitor') return;
    if (isEditableTarget(event.target)) return;

    const mapped = mapKeyboardEventToTmux(event);
    if (!mapped) return;

    event.preventDefault();
    event.stopPropagation();

    if (descriptor.enterSubmits && mapped.type === 'tmuxKey' && mapped.value === 'Enter') {
      enqueueKeyAction(() => api.post(`${descriptor.apiBase}/sessions/${id}/enter`));
      return;
    }

    if (mapped.type === 'tmuxKey') {
      enqueueKeyAction(() => api.post(`${descriptor.apiBase}/sessions/${id}/keys`, { keys: mapped.value }));
      return;
    }

    enqueueKeyAction(() => api.post(`${descriptor.apiBase}/sessions/${id}/input`, { text: mapped.value, enter: false, source: 'ui' }));
  }

  function sendTerminalKey(keyName) {
    if (isRustManagedReadOnly) return;
    enqueueKeyAction(() => api.post(`${descriptor.apiBase}/sessions/${id}/keys`, { keys: keyName }));
  }

  async function killSession() {
    if (sessionInfo.value.readOnly === true && sessionInfo.value.externalOwner === 'rust-monitor') return;
    if (!window.confirm(`Kill ${descriptor.label} session ${descriptor.kind}-${id}?`)) return;
    try {
      await api.delete(`${descriptor.apiBase}/sessions/${encodeURIComponent(id)}`);
      removeSessionForKind(descriptor.kind, id);
      addToast('Session killed', 'success');
      if (!embedded) window.history.back();
    } catch (e) {
      addToast(`Failed: ${e.message}`, 'error');
    }
  }

  async function startFreshSession(freshSession = null) {
    const body = {
      provider: descriptor.kind,
      workDir: freshSession?.workDir || sessionInfo.value.workDir || '',
      displayName: freshSession?.displayName || sessionInfo.value.displayName || '',
      model: freshSession?.model || sessionInfo.value.model || '',
      thinkingLevel: freshSession?.thinkingLevel || sessionInfo.value.thinkingLevel || '',
    };
    try {
      const data = await api.post('/agents/sessions', body);
      addToast(`Started fresh session ${data.sessionName || data.id}`, 'success');
      route(`${descriptor.routeBase}/${data.id}`);
    } catch (e) {
      addToast(`Fresh session failed: ${e.message}`, 'error');
    }
  }

  async function resumeSession() {
    try {
      const data = await api.post(`${descriptor.apiBase}/sessions/${id}/resume`);
      addToast(`Resumed ${data.sessionName || id}`, 'success');
      await loadContent(id, loadedLines.value);
    } catch (e) {
      if (e.freshSession && window.confirm(`${e.message}\n\nStart a fresh ${descriptor.label} session in the same workdir?`)) {
        await startFreshSession(e.freshSession);
        return;
      }
      addToast(`Resume failed: ${e.message}`, 'error');
    }
  }

  async function openInTerminal() {
    const sessionName = sessionInfo.value.sessionName;
    if (sessionInfo.value.readOnly === true && sessionInfo.value.externalOwner === 'rust-monitor') return;
    const command = sessionInfo.value.attachCommand;
    if (!sessionName || !command || sessionInfo.value.source === 'bare-process') return;
    try {
      await api.post(`/tmux/sessions/${encodeURIComponent(sessionName)}/open`);
      addToast(`Opened Terminator for ${sessionName}`, 'success');
    } catch (e) {
      try {
        await copyText(command);
        addToast(`Could not launch terminal. Copied: ${command}`, 'warning');
      } catch {
        addToast(`Failed to open terminal: ${e.message}`, 'error');
      }
    }
  }

  async function copyAttachCommand() {
    const sessionName = sessionInfo.value.sessionName;
    const command = sessionInfo.value.attachCommand;
    if (!sessionName || !command || sessionInfo.value.source === 'bare-process') return;
    try {
      await copyText(command);
      addToast(`Copied: ${command}`, 'success');
    } catch (e) {
      addToast(`Failed to copy attach command: ${e.message}`, 'error');
    }
  }

  async function copySessionId() {
    try {
      await copyText(id);
      addToast(`Copied session ID ${id}`, 'success');
    } catch (e) {
      addToast(`Failed to copy session ID: ${e.message}`, 'error');
    }
  }

  async function attachImageFile(file) {
    if (!file?.type?.startsWith('image/')) return;
    imageDraft.value = {
      ...imageDraft.value,
      imageDataUrl: await loadImageDataUrl(file),
    };
  }

  async function handleImageFile(event) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    event.currentTarget.value = '';
    await attachImageFile(file);
  }

  async function handleDroppedFiles(files) {
    const file = (files || []).find((item) => item?.type?.startsWith('image/'));
    if (!file) return;
    await attachImageFile(file);
    addToast(`Dropped image ready to send to ${providerLabel}`, 'success');
  }

  async function sendImageToSession() {
    if (imageSending.value) return;
    if (!imageDraft.value.imageDataUrl) {
      addToast('Choose or paste an image first', 'error');
      return;
    }
    const raw = inputText.value;
    const caption = resolveQuickInserts(raw);
    if (caption === null) return;
    imageSending.value = true;
    try {
      const result = await api.post(`${descriptor.apiBase}/sessions/${id}/image`, {
        imageDataUrl: imageDraft.value.imageDataUrl,
        caption,
        source: 'ui',
        allowCompatibilityDowngrade: true,
      });
      imageDraft.value = { imageDataUrl: '' };
      inputText.value = '';
      addToast(`Sent image to ${descriptor.label} at ${result.imagePath}`, 'success');
    } catch (e) {
      addToast(`Failed to send image: ${e.message}`, 'error');
    } finally {
      imageSending.value = false;
    }
  }

  function clearImageDraft() {
    imageDraft.value = { imageDataUrl: '' };
  }

  const isRustManagedReadOnly = sessionInfo.value.readOnly === true && sessionInfo.value.externalOwner === 'rust-monitor';
  const activeThreads = agentThreads.value.filter(isActiveThread);
  const linkedThreads = linkedThreadsForSession(descriptor.kind, id, activeThreads);
  const quickInsertOptions = buildQuickInsertOptions({
    threads: activeThreads,
    linkedThreads,
    sessionsByKind: participantsState.value.sessions || {},
    currentSession: { kind: descriptor.kind, sessionId: id },
  });

  // Quick-insert chips hold only the target key; the watch prompt is built
  // from current thread state at send time, the way skills resolve on the
  // server just before the harness sees them. A chip whose thread or session
  // is gone blocks the send rather than silently shrinking the message.
  function resolveQuickInserts(text) {
    const { text: resolved, missing } = expandQuickTokens(text, (key) => {
      const option = quickInsertOptions.find((item) => item.key === key);
      if (!option) return '';
      return buildQuickInsertPrompt({
        option,
        activeThreads,
        currentThreadId: linkedThreads[0]?.id || '',
      });
    });
    if (missing.length) {
      addToast(`Quick insert no longer available: ${missing.map(quickTokenLabel).join(', ')}`, 'error');
      return null;
    }
    return resolved;
  }

  const displayName = sessionInfo.value.displayName || null;
  const threadTitle = linkedThreads.filter((thread) => !thread.metadata?.dm).map((thread) => thread.title).join(', ') || null;
  const fallbackTitle = sessionInfo.value.sessionName || `${descriptor.kind}-${id}`;
  const headerParts = [displayName, threadTitle].filter(Boolean);
  const headerTitle = headerParts.length ? headerParts.join(' / ') : fallbackTitle;
  const { previous, next } = findSessionNeighbors(siblingSessions.value, descriptor.kind, id);
  const startLoop = () => route(`/loop-sessions?kind=${encodeURIComponent(descriptor.kind)}&session_id=${encodeURIComponent(id)}`);

  return h('div', { class: `claude-session-page${embedded ? ' agent-session-page-embedded' : ''}` },
    h('div', { class: 'claude-session-header' },
      h('div', { class: 'session-header-primary' },
        !embedded ? h('a', { href: '/agents', class: 'ctrl-btn ctrl-default', style: 'padding:4px 10px; font-size:18px; line-height:1' }, '\u2190') : null,
        !embedded ? h('button', {
          class: 'ctrl-btn ctrl-default',
          type: 'button',
          disabled: !previous,
          onClick: () => navigateToAgentSession(previous),
          title: previous ? `Previous agent: ${previous.displayName || previous.name || previous.id}` : 'No previous agent',
          style: 'padding:4px 10px; font-size:18px; line-height:1',
        }, '\u2039') : null,
        !embedded ? h('button', {
          class: 'ctrl-btn ctrl-default',
          type: 'button',
          disabled: !next,
          onClick: () => navigateToAgentSession(next),
          title: next ? `Next agent: ${next.displayName || next.name || next.id}` : 'No next agent',
          style: 'padding:4px 10px; font-size:18px; line-height:1',
        }, '\u203a') : null,
        h('span', { class: 'session-title', title: id }, headerTitle),
        sessionState.value.status !== 'ended'
          ? h('button', { class: 'ctrl-btn ctrl-default', onClick: startLoop, style: 'padding:4px 8px; font-size:12px' }, 'Start loop')
          : null,
        isRustManagedReadOnly ? h('span', { class: 'badge badge-low' }, 'rust-managed / read-only') : null,
      ),
      h('div', { class: 'session-header-actions' },
        h('button', { class: 'ctrl-btn ctrl-default', onClick: copySessionId, style: 'padding:4px 8px; font-size:12px' }, 'Copy ID'),
        (sessionInfo.value.sessionName && sessionInfo.value.attachCommand && sessionInfo.value.source !== 'bare-process')
          ? h('button', { class: 'ctrl-btn ctrl-default mobile-hidden', onClick: copyAttachCommand, style: 'padding:4px 8px; font-size:12px' }, 'Copy Attach')
          : null,
        (sessionInfo.value.sessionName && sessionInfo.value.attachCommand && sessionInfo.value.source !== 'bare-process' && !isRustManagedReadOnly && tmuxCapabilities.value.canOpenTerminal)
          ? h('button', { class: 'ctrl-btn ctrl-default mobile-hidden', onClick: openInTerminal, style: 'padding:4px 8px; font-size:12px' }, 'Open In Terminator')
          : null,
        sessionState.value.status === 'ended' && !isRustManagedReadOnly
          ? h('button', { class: 'ctrl-btn ctrl-default', onClick: resumeSession, style: 'padding:4px 8px; font-size:12px' }, 'Resume')
          : null,
        sessionState.value.status === 'ended' && !sessionInfo.value.canResume && !isRustManagedReadOnly
          ? h('button', { class: 'ctrl-btn ctrl-default', onClick: () => startFreshSession(), style: 'padding:4px 8px; font-size:12px' }, 'Start Fresh')
          : null,
        h('button', { class: 'ctrl-btn ctrl-default', onClick: () => loadContent(id, loadedLines.value), style: 'padding:4px 8px; font-size:12px' }, 'Refresh'),
        h('button', {
          class: `ctrl-btn ${renderedTranscript.value ? 'ctrl-send' : 'ctrl-default'}`,
          onClick: () => {
            const next = !renderedTranscript.value;
            renderedTranscript.value = next;
            if (next) loadRawTranscript(id);
          },
          style: 'padding:4px 8px; font-size:12px',
          title: 'Toggle a rendered Markdown and math view built from the model session log. Raw terminal content remains unchanged.',
        }, renderedTranscript.value ? 'Raw Terminal' : 'Rendered Transcript'),
        !isRustManagedReadOnly ? h('button', { class: 'ctrl-btn ctrl-danger-sm', onClick: killSession, style: 'padding:4px 8px; font-size:12px' }, 'Kill') : null,
      ),
    ),
    renderedTranscript.value
      ? h('div', { class: 'rendered-transcript-wrap', style: 'flex:1; min-height:0; overflow:auto' },
        transcriptRaw.value.status === 'loading'
          ? h('div', { style: 'padding:12px; color:var(--text-muted); font-size:12px' }, 'Loading session log...')
          : null,
        transcriptRaw.value.status === 'error'
          ? h('div', { style: 'padding:8px 12px; color:var(--text-muted); font-size:12px; border-bottom:1px solid rgba(255,255,255,0.08)' },
            `Session log unavailable (${transcriptRaw.value.error}). Falling back to terminal capture — the CLI strips LaTeX delimiters, so math may not render.`)
          : null,
        h(RenderedTranscript, {
          content: transcriptRaw.value.status === 'ok'
            ? transcriptRaw.value.text
            : stripAnsi(content.value).replace(/\r/g, ''),
        }))
      : h(Terminal, {
        content: content.value,
        fullHeight: true,
        ansiColors: true,
        captureKeyboard: !isRustManagedReadOnly,
        // Embedded in the agents rail, stealing focus on every selection would
        // route the next keystroke into a live session. Click to type instead.
        autoFocusKeyboard: !isRustManagedReadOnly && !embedded,
        onTerminalKeyDown: handleTerminalKeyDown,
        hasMore: loadedLines.value < FULL_LINES,
        loadingMore: loadingMore.value,
        onLoadMore: loadMoreHistory,
        resetKey: id,
      }),
    !isRustManagedReadOnly ? h(TerminalKeys, { onKey: sendTerminalKey }) : null,
    isRustManagedReadOnly
      ? h('div', { class: 'claude-control-bar', style: 'border-top:1px solid rgba(255,255,255,0.08); color:var(--text-muted); font-size:12px' }, 'Rust-managed session. View only from Cadre.')
      : null,
    !isRustManagedReadOnly ? h(AgentControlBar, {
      provider: descriptor.kind,
      state: sessionState.value,
      onApprove: descriptor.hasShiftTab ? sendShiftTab : undefined,
      onReject: sendEscape,
      onEscape: sendEscape,
      onDialogAnswer: sendDialogAnswer,
      onSendInput: sendInput,
      onScheduledSend: scheduledSend,
      onSlashCommand: descriptor.hasSlash ? sendSlashCommand : undefined,
      quickInsertOptions,
      onAttachImage: handleImageFile,
      onDropFiles: handleDroppedFiles,
      onClearImage: clearImageDraft,
      imageAttached: Boolean(imageDraft.value.imageDataUrl),
      imageSending: imageSending.value,
      // The preview rides inside the control bar so it stays pinned with the
      // composer instead of scrolling away from the message it belongs to.
      imagePreviewUrl: imageDraft.value.imageDataUrl,
      imageNote: `Attached. This compatibility transport will visibly disclose that it wrote a safe workspace reference for ${descriptor.label}.`,
      inputText,
    }) : null,
  );
}
