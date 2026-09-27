function participantKey(ref) {
  return `${ref?.kind || ''}:${ref?.sessionId || ''}`;
}

export function shortThreadId(threadId) {
  if (!threadId) return '';
  return threadId.length <= 14 ? threadId : threadId.slice(0, 14);
}

export function linkedThreadsForSession(kind, sessionId, threads = []) {
  return threads.filter((thread) =>
    (thread?.participants || []).some((participant) =>
      participant.kind === kind && participant.sessionId === sessionId
    )
  );
}

export function sessionTitle(session = {}, kind = '', threads = [], fallback = '') {
  const room = linkedThreadsForSession(kind, session.id, threads).find((thread) => !thread.metadata?.dm);
  return session.displayName || room?.title || fallback || session.name || session.id;
}

export function buildSessionOptions(sessionsByKind = {}, current = null) {
  const currentKey = participantKey(current);
  return Object.entries(sessionsByKind)
    .flatMap(([kind, sessions]) => (sessions || []).map((session) => ({
      kind,
      sessionId: session.id,
      label: `${kind}:${session.name || session.sessionName || session.id}`,
      session,
    })))
    .filter((item) => participantKey(item) !== currentKey)
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function buildQuickInsertOptions({
  threads = [],
  linkedThreads = [],
  sessionsByKind = {},
  currentSession = null,
}) {
  const linkedThreadIds = new Set((linkedThreads || []).map((thread) => thread.id));
  const sessionOptions = buildSessionOptions(sessionsByKind, currentSession).map((option) => ({
    type: 'session',
    key: `session::${option.kind}::${option.sessionId}`,
    label: `Session: ${option.label}`,
    kind: option.kind,
    sessionId: option.sessionId,
  }));
  const threadOptions = (threads || [])
    .filter((thread) => !linkedThreadIds.has(thread.id))
    .map((thread) => ({
      type: 'thread',
      key: `thread::${thread.id}`,
      label: `Thread: ${thread.title} (${thread.id})`,
      thread,
    }));

  return [...threadOptions, ...sessionOptions].sort((a, b) => a.label.localeCompare(b.label));
}

export function buildQuickInsertPrompt({
  option,
  activeThreads = [],
  currentThreadId = '',
}) {
  if (!option) return '';

  if (option.type === 'thread') {
    const participant = (option.thread?.participants || [])[0] || null;
    return buildThreadWatchPrompt({
      thread: option.thread,
      participant,
      currentThreadId,
    });
  }

  if (option.type !== 'session' || !option.kind || !option.sessionId) return '';

  const linkedThread = activeThreads.find((thread) =>
    (thread.participants || []).some((participant) =>
      participant.kind === option.kind && participant.sessionId === option.sessionId
    )
  ) || null;

  return buildSessionWatchPrompt({
    target: { kind: option.kind, sessionId: option.sessionId },
    linkedThread,
    currentThreadId,
  });
}

export function buildThreadWatchPrompt({ thread, participant, currentThreadId = '' }) {
  const target = participant ? `${participant.kind}:${participant.sessionId}` : 'the linked agent';
  const lines = [
    `Monitor linked thread ${thread.id} (${thread.title}) for updates from ${target}.`,
    `Use room_context(thread_id="${thread.id}") to check its messages and delivery state.`,
  ];
  if (currentThreadId) {
    lines.push(`If anything there changes work in this thread (${currentThreadId}), send a status_update back here with the dependency impact.`);
  }
  return lines.join('\n');
}

export function buildSessionWatchPrompt({ target, linkedThread = null, currentThreadId = '' }) {
  const targetLabel = `${target.kind}:${target.sessionId}`;
  if (linkedThread) {
    return buildThreadWatchPrompt({
      thread: linkedThread,
      participant: { kind: target.kind, sessionId: target.sessionId },
      currentThreadId,
    });
  }

  const lines = [
    `Check on ${targetLabel}.`,
    `Use agent_directory() to confirm its current state, then agent_dm(kind="${target.kind}", session_id="${target.sessionId}", body="...") to contact it directly.`,
  ];
  if (currentThreadId) {
    lines.push(`Report any dependency changes back into this thread (${currentThreadId}).`);
  }
  return lines.join('\n');
}

export function buildBootstrapPrompt() {
  return 'Bootstrap the next session with the Cadre MCP (`dueno`), use default participants, and assign Claude and Codex their roles.';
}

export async function copyText(text) {
  if (!text) throw new Error('Nothing to copy');
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}
