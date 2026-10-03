import { h, render } from 'preact';
import { html } from 'htm/preact';
import Router from 'preact-router';
import { useEffect } from 'preact/hooks';
import { effect } from '@preact/signals';
import { sessionTitle } from './agent-bus-ui.mjs';

import {
  initAuth,
  agentThreads,
  agentBusAlerts,
  claudeSessions,
  codexSessions,
  deepseekSessions,
  piSessions,
  unreadAlerts,
  unreadAgentAlerts,
  queueOpenCount,
  wsOpens,
  setClaudeSessions,
  setCodexSessions,
  setDeepseekSessions,
  setPiSessions,
  upsertPromptNotificationFromAlert,
  hasSeenPromptNotification,
} from './state.mjs';
import { connectWs, subscribe } from './ws-client.mjs';
import { showNotification } from './notifications.mjs';
import { installRouteScrollRestoration, installSpaLinkNavigation } from './navigation.mjs';
import { installViewportKeyboardInset } from './viewport-keyboard.mjs';
import { shouldNotifyForSession, visibleSessionPromptNotificationCount } from './notification-prefs.mjs';
import { api } from './api.mjs';

// Components
import { Nav } from '../components/nav.mjs';
import { ToastContainer } from '../components/toast.mjs';

// Pages
import { DashboardPage } from '../pages/dashboard.mjs';
import { CommandQueuePage } from '../pages/command-queue.mjs';
import { FleetPage } from '../pages/fleet.mjs';
import { GitHubAgentsPage } from '../pages/github-agents.mjs';
import { TmuxPage } from '../pages/tmux.mjs';
import { TmuxPanePage } from '../pages/tmux-pane.mjs';
import { AgentsPage } from '../pages/agents.mjs';
import { ClaudeSessionsPage } from '../pages/claude-sessions.mjs';
import { CodexSessionsPage } from '../pages/codex-sessions.mjs';
import { AgentSessionDetailPage } from '../pages/agent-session-detail.mjs';
import { AgentCollabPage } from '../pages/agent-collab.mjs';
import { ScheduledAgentsPage } from '../pages/scheduled-agents.mjs';
import { LoopSessionsPage } from '../pages/loop-sessions.mjs';
import { ThreatsPage } from '../pages/threats.mjs';
import { FilesPage } from '../pages/files.mjs';
import { RecordingsPage } from '../pages/recordings.mjs';
import { CaptureNotesPage, CapturePage } from '../pages/capture.mjs';
import { SettingsPage } from '../pages/settings.mjs';
import { SkillsPage } from '../pages/skills.mjs';

const NotFound = () => html`<div class="page"><h1>404</h1><p>Page not found</p></div>`;

function normalizeInitialRoute() {
  if (typeof window === 'undefined') return;
  const { pathname, search, hash } = window.location;
  if (pathname.length <= 1 || !pathname.endsWith('/')) return;
  window.history.replaceState({}, '', `${pathname.replace(/\/+$/, '')}${search}${hash}`);
}

const RedirectPage = ({ to = '/' }) => {
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.pathname !== to) {
      window.history.replaceState({}, '', to);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  }, [to]);
  return null;
};

function isActiveVisibleRoute(targetRoute) {
  if (typeof window === 'undefined' || typeof targetRoute !== 'string' || !targetRoute) return false;
  return document.visibilityState === 'visible' && window.location.pathname === targetRoute;
}

function promptNotificationTitle(kind, sessionId, fallback = '') {
  const label = kind === 'claude' ? 'Claude' : kind === 'pi' ? 'Pi' : kind === 'deepseek' ? 'DeepSeek Harness' : 'Codex';
  const sessionStore = kind === 'claude'
    ? claudeSessions
    : kind === 'pi'
      ? piSessions
      : kind === 'deepseek'
        ? deepseekSessions
        : codexSessions;
  const session = sessionStore.value.find((item) => item.id === sessionId);
  return `${label}: ${sessionTitle(session || { id: sessionId }, kind, agentThreads.value, fallback)}`;
}

function App({ onRouteChange }) {
  return html`
    <${Nav} />
    <main class="main">
      <${Router} onChange=${onRouteChange}>
        <${DashboardPage} path="/" />
        <${CommandQueuePage} path="/queue" />
        <${FleetPage} path="/fleet" />
        <${GitHubAgentsPage} path="/github-agents" />
        <${TmuxPanePage} path="/tmux/pane/:target" />
        <${TmuxPage} path="/tmux" />
        <${AgentsPage} path="/agents" />
        <${AgentSessionDetailPage} path="/claude/:id" provider="claude" />
        <${ClaudeSessionsPage} path="/claude" />
        <${AgentSessionDetailPage} path="/codex/:id" provider="codex" />
        <${CodexSessionsPage} path="/codex" />
        <${AgentSessionDetailPage} path="/pi/:id" provider="pi" />
        <${AgentSessionDetailPage} path="/deepseek/:id" provider="deepseek" />
        <${AgentCollabPage} path="/collab/:id?" />
        <${ScheduledAgentsPage} path="/scheduled-agents" />
        <${LoopSessionsPage} path="/loop-sessions" />
        <${ThreatsPage} path="/threats" />
        <${FilesPage} path="/files" />
        <${RecordingsPage} path="/recordings" />
        <${CaptureNotesPage} path="/capture/notes" />
        <${CapturePage} path="/capture" />
        <${SkillsPage} path="/skills" />
        <${SettingsPage} path="/settings/:section?" />
        <${NotFound} default />
      <//>
    </main>
    <${ToastContainer} />
  `;
}

// ── Initialize ──
await initAuth();
normalizeInitialRoute();
installSpaLinkNavigation();
installViewportKeyboardInset();
connectWs();
const routeScrollRestoration = installRouteScrollRestoration();

effect(() => {
  const decisions = queueOpenCount.value;
  const unread = unreadAlerts.value + unreadAgentAlerts.value + visibleSessionPromptNotificationCount.value;
  const count = decisions + unread;
  const parts = [];
  if (decisions) parts.push(`${decisions} decisions`);
  if (unread) parts.push(`${unread} unread`);
  document.title = `${count ? `(${count}) ` : ''}Cadre${parts.length ? ` - ${parts.join(', ')}` : ''}`;
});

// Subscribe to claude session list updates via WebSocket
subscribe('claude:sessions', (type, data) => {
  if (type === 'sessions' && data?.sessions) {
    setClaudeSessions(data.sessions);
  }
});

subscribe('codex:sessions', (type, data) => {
  if (type === 'sessions' && data?.sessions) {
    setCodexSessions(data.sessions);
  }
});

subscribe('pi:sessions', (type, data) => {
  if (type === 'sessions' && data?.sessions) setPiSessions(data.sessions);
});

subscribe('deepseek:sessions', (type, data) => {
  if (type === 'sessions' && data?.sessions) setDeepseekSessions(data.sessions);
});

for (const kind of ['claude', 'codex', 'pi']) {
  subscribe(`${kind}:alerts`, (type, data) => {
    if (type !== 'alert' || !data) return;
    const route = data.route || `/${kind}/${data.sessionId}`;
    if (isActiveVisibleRoute(route)) return;
    if (data.status === 'ready' && data.attentionKey && hasSeenPromptNotification(kind, data.attentionKey)) return;
    if (!shouldNotifyForSession(kind, data.sessionId, data.status)) return;
    upsertPromptNotificationFromAlert(kind, data);
    const title = promptNotificationTitle(kind, data.sessionId, data.sessionName);
    const body = data.interaction?.detail || data.reason || 'Waiting for your next prompt';
    showNotification(title, body, { tag: `${kind}-${data.sessionId}`, url: route, pushed: true });
  });
}

subscribe('agent-bus:threads', (type, data) => {
  if (type === 'threads' && data?.threads) {
    agentThreads.value = data.threads;
  }
  if ((type === 'thread_created' || type === 'thread_updated') && data?.thread) {
    const next = [...agentThreads.value];
    const idx = next.findIndex(t => t.id === data.thread.id);
    if (idx === -1) {
      next.unshift(data.thread);
    } else {
      next[idx] = data.thread;
    }
    agentThreads.value = next.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  if (type === 'thread_deleted' && data?.threadId) {
    agentThreads.value = agentThreads.value.filter(t => t.id !== data.threadId);
  }
});

subscribe('agent-bus:alerts', (type, data) => {
  if (!type || !data) return;
  const alert = { id: `${type}:${data.deliveryId || data.messageId || Date.now()}`, type, ...data };
  agentBusAlerts.value = [alert, ...agentBusAlerts.value].slice(0, 25);
  if (document.hidden) {
    showNotification('Agent Collab', data.error || type, {
      tag: alert.id,
      url: data.threadId ? `/collab/${data.threadId}` : '/collab',
    });
  }
});

// Reconnects can miss queue broadcasts, so refetch the open count on every socket open.
effect(() => {
  if (!wsOpens.value) return;
  api.get('/command-center/work-queue').then((data) => { queueOpenCount.value = data?.openCount || 0; }).catch(() => {});
});

subscribe('command-center:work-queue', (type, data) => {
  if (!data?.items) return;
  queueOpenCount.value = data.openCount || 0;
  const item = data.items.find((entry) => entry.status === 'open');
  if (type === 'item_created' && item) {
    showNotification('Decision needed', item.title || item.question, { tag: item.id, url: '/queue' });
  }
});

render(html`<${App} onRouteChange=${routeScrollRestoration.handleRouteChange} />`, document.getElementById('app'));
