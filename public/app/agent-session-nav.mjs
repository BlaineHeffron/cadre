import { api } from './api.mjs';
import { setClaudeSessions, setCodexSessions, setDeepseekSessions, setPiSessions } from './state.mjs';

export function normalizeProvider(provider = '') {
  const normalized = String(provider || '').trim().toLowerCase();
  if (normalized === 'anthropic' || normalized === 'claude-code') return 'claude';
  if (normalized === 'chatgpt') return 'codex';
  return normalized || 'claude';
}

function sessionDedupKey(session = {}) {
  if (session.tmuxSession) return `tmux:${session.tmuxSession}`;
  if (session.pid) return `pid:${session.pid}`;
  return `${session._kind}:${session.id}`;
}

function sessionPriority(session = {}) {
  if (session._kind === 'codex') return 3;
  if (session.source === 'dashboard') return 2;
  if (session.source === 'tmux-external') return 1;
  return 0;
}

export function sessionCreatedAt(session) {
  const value = Number(session?.created || 0);
  if (!value) return 0;
  return value > 1e12 ? value : value * 1000;
}

export function buildUnifiedAgentSessions({ claudeSessions = [], codexSessions = [], deepseekSessions = [], piSessions = [], provider = 'all' } = {}) {
  const sessionMap = new Map();
  for (const session of [
    ...codexSessions.map((entry) => ({
      ...entry,
      _kind: 'codex',
      _provider: normalizeProvider(entry.provider || entry.runtime || 'codex'),
    })),
    ...claudeSessions.map((entry) => ({
      ...entry,
      _kind: 'claude',
      _provider: normalizeProvider(entry.provider),
    })),
    ...piSessions.map((entry) => ({
      ...entry,
      _kind: 'pi',
      _provider: normalizeProvider(entry.provider),
    })),
    ...deepseekSessions.map((entry) => ({
      ...entry,
      _kind: 'deepseek',
      _provider: 'deepseek',
    })),
  ]) {
    const key = sessionDedupKey(session);
    const current = sessionMap.get(key);
    if (!current || sessionPriority(session) > sessionPriority(current)) {
      sessionMap.set(key, session);
    }
  }

  return Array.from(sessionMap.values())
    .sort((a, b) => sessionCreatedAt(b) - sessionCreatedAt(a))
    .filter((session) => {
      if (['bare-process', 'orphan-process'].includes(session.source)) return false;
      if (provider !== 'all' && session._provider !== provider) return false;
      return true;
    });
}

export async function loadUnifiedAgentSessions() {
  const [claudeData, codexData, deepseekData, piData] = await Promise.all([
    api.get('/claude/sessions'),
    api.get('/codex/sessions'),
    api.get('/deepseek/sessions'),
    api.get('/pi/sessions'),
  ]);
  const nextClaudeSessions = claudeData?.sessions || [];
  const nextCodexSessions = codexData?.sessions || [];
  const nextPiSessions = piData?.sessions || [];
  const nextDeepseekSessions = deepseekData?.sessions || [];
  setClaudeSessions(nextClaudeSessions);
  setCodexSessions(nextCodexSessions);
  setPiSessions(nextPiSessions);
  setDeepseekSessions(nextDeepseekSessions);
  return buildUnifiedAgentSessions({
    claudeSessions: nextClaudeSessions,
    codexSessions: nextCodexSessions,
    piSessions: nextPiSessions,
    deepseekSessions: nextDeepseekSessions,
  });
}

export function findSessionNeighbors(sessions = [], currentKind, currentId) {
  const index = sessions.findIndex((session) => session._kind === currentKind && session.id === currentId);
  if (index === -1 || sessions.length <= 1) {
    return { previous: null, next: null };
  }
  const previous = sessions[(index - 1 + sessions.length) % sessions.length];
  const next = sessions[(index + 1) % sessions.length];
  return {
    previous: previous?.id === currentId && previous?._kind === currentKind ? null : previous,
    next: next?.id === currentId && next?._kind === currentKind ? null : next,
  };
}

export function navigateToAgentSession(session) {
  if (!session?._kind || !session?.id || typeof window === 'undefined') return;
  const path = `/${session._kind}/${session.id}`;
  if (window.location.pathname === path) return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
