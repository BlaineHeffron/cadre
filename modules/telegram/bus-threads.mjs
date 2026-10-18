import { isDmBusThread } from './routing.mjs';

export function normalizeParticipantKind(value = '') {
  const kind = String(value || '').trim().toLowerCase();
  if (kind === 'openai') return 'codex';
  if (kind === 'anthropic') return 'claude';
  return kind;
}

export const normalizeBusParticipantKind = normalizeParticipantKind;

export function busThreadParticipantKey(kind, sessionId) {
  return `${normalizeParticipantKind(kind)}:${String(sessionId || '').trim()}`;
}

function threadRecord(entry = {}) {
  return entry?.thread && typeof entry.thread === 'object' ? entry.thread : entry;
}

function threadUpdatedAt(thread = {}) {
  return Number(thread.updatedAt || 0) || Date.parse(thread.updatedAt || '') || 0;
}

function preferThread(candidate, previous) {
  if (!previous) return true;
  if (candidate.updatedAt !== previous.updatedAt) return candidate.updatedAt > previous.updatedAt;
  return candidate.id < previous.id;
}

export function buildBusThreadIndex(agentBusState = {}) {
  const byParticipant = new Map();
  for (const entry of Array.isArray(agentBusState?.threads) ? agentBusState.threads : []) {
    const thread = threadRecord(entry);
    // A closed room never routes, so its sessions fall back to their own topics.
    if (!thread?.id || thread.status !== 'open' || isDmBusThread(thread)) continue;
    const candidate = {
      id: String(thread.id),
      title: String(thread.title || '').trim(),
      updatedAt: threadUpdatedAt(thread),
    };
    for (const participant of Array.isArray(thread.participants) ? thread.participants : []) {
      if (!participant?.sessionId) continue;
      const key = busThreadParticipantKey(participant.kind, participant.sessionId);
      if (preferThread(candidate, byParticipant.get(key))) byParticipant.set(key, candidate);
    }
  }
  return byParticipant;
}

export class BusThreadIndex {
  constructor(initialState = null) {
    this.index = new Map();
    if (initialState) this.update(initialState);
  }

  update(state = null) {
    if (!state) return this.index;
    const next = buildBusThreadIndex(state);
    this.index = next;
    return this.index;
  }

  current() {
    return this.index;
  }

  get(key) {
    return this.index.get(key);
  }
}
