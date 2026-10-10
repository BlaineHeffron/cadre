import { h } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { route } from 'preact-router';
import {
  wsConnected,
  isAuthenticated,
  unreadAlerts,
  unseenDoneCount,
  unseenSessionCount,
  unseenCodexSessionCount,
  unseenPiSessionCount,
  openAgentThreadCount,
  unreadAgentAlerts,
  queueOpenCount,
} from '../app/state.mjs';
import {
  visibleSessionPromptNotifications,
  visibleSessionPromptNotificationCount,
} from '../app/notification-prefs.mjs';

const PRIMARY_NAV = [
  { label: 'Command Center', path: '/' },
  { label: 'Queue', path: '/queue' },
  { label: 'Capture', path: '/capture', mobileDefault: true },
  { label: 'Fleet', path: '/fleet' },
  { label: 'GitHub', path: '/github-agents' },
  { label: 'Agents', path: '/agents', mobileDefault: true },
  { label: 'Collab', path: '/collab' },
  { label: 'Schedules', path: '/scheduled-agents' },
  { label: 'Loop Sessions', path: '/loop-sessions' },
  { label: 'Tmux', path: '/tmux' },
];

const MORE_NAV = [
  { label: 'Saved Notes', path: '/capture/notes' },
  { label: 'Skills', path: '/skills' },
  { label: 'Recordings', path: '/recordings' },
  { label: 'Threats', path: '/threats' },
  { label: 'Files', path: '/files' },
  { label: 'Settings', path: '/settings' },
];

function isPathActive(path, pathname) {
  if (!path || !pathname) return false;
  if (path === '/agents' && ['/claude', '/codex', '/pi'].some((prefix) => pathname.startsWith(prefix))) return true;
  if (path === '/') return pathname === '/';
  return pathname === path || pathname.startsWith(`${path}/`);
}

function navBadge(path) {
  if (path === '/agents') {
    if (unseenDoneCount.value > 0) return html`<span class="badge badge-info nav-link-badge">${unseenDoneCount.value} done</span>`;
    const unseen = unseenSessionCount.value + unseenCodexSessionCount.value + unseenPiSessionCount.value;
    if (unseen > 0) return html`<span class="badge badge-info nav-link-badge">${unseen} new</span>`;
    return null;
  }
  if (path === '/queue') {
    const waiting = queueOpenCount.value;
    if (waiting > 0) return html`<span class="badge badge-critical badge-pulse nav-link-badge">${waiting}</span>`;
    return null;
  }
  if (path === '/collab') {
    if (unreadAgentAlerts.value > 0) return html`<span class="badge badge-critical nav-link-badge">${unreadAgentAlerts.value}</span>`;
    if (openAgentThreadCount.value > 0) return html`<span class="badge badge-info nav-link-badge">${openAgentThreadCount.value}</span>`;
    return null;
  }
  if (path === '/threats' && unreadAlerts.value > 0) {
    return html`<span class="badge badge-critical nav-link-badge">${unreadAlerts.value}</span>`;
  }
  return null;
}

export function Nav() {
  const showPromptBell = useMemo(() => signal(false), []);
  const showMoreMenu = useMemo(() => signal(false), []);
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '/';
  const promptPopoverId = 'prompt-ready-popover';
  const morePopoverId = 'nav-more-popover';
  const connectionLabel = wsConnected.value ? 'Connected' : (isAuthenticated.value ? 'Polling' : 'Offline');
  const connectionClass = wsConnected.value ? 'badge-success' : (isAuthenticated.value ? 'badge-low' : 'badge-critical');

  function openPromptNotification(item) {
    showPromptBell.value = false;
    route(item.route);
  }

  function navigateTo(path) {
    showPromptBell.value = false;
    showMoreMenu.value = false;
    route(path);
  }

  function onNavClick(event, path) {
    event.preventDefault();
    showPromptBell.value = false;
    showMoreMenu.value = false;
    route(path);
  }

  useEffect(() => {
    function handlePointerDown(event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('.nav-bell-wrap')) showPromptBell.value = false;
      if (!target.closest('.nav-more-wrap')) showMoreMenu.value = false;
    }

    function handleEscape(event) {
      if (event.key !== 'Escape') return;
      showPromptBell.value = false;
      showMoreMenu.value = false;
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

  return html`
    <nav class="nav" aria-label="Main navigation">
      <div class="nav-brand">
        <span style="margin-right:8px">Cadre</span>
        <span class="badge nav-connection-badge ${connectionClass}" style="font-size:10px">
          ${connectionLabel}
        </span>
      </div>
      <div class="nav-links">
        <div class="nav-bell-wrap">
          <button
            class="nav-bell-btn ${visibleSessionPromptNotificationCount.value > 0 ? 'nav-bell-btn-active' : ''}"
            onclick=${() => {
              showPromptBell.value = !showPromptBell.value;
              if (showPromptBell.value) showMoreMenu.value = false;
            }}
            title="Prompt-ready session notifications"
            aria-label="Prompt-ready session notifications"
            aria-expanded=${showPromptBell.value ? 'true' : 'false'}
            aria-controls=${promptPopoverId}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" class="nav-bell-icon">
              <path d="M12 3a4 4 0 0 0-4 4v2.2c0 1.1-.4 2.1-1.1 2.9L5.6 13.6A1 1 0 0 0 6.4 15h11.2a1 1 0 0 0 .8-1.4l-1.3-1.5A4.5 4.5 0 0 1 16 9.2V7a4 4 0 0 0-4-4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
              <path d="M10 18a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
            ${visibleSessionPromptNotificationCount.value > 0 ? html`
              <span class="badge badge-critical badge-pulse" style="margin-left:6px; font-size:10px">
                ${visibleSessionPromptNotificationCount.value}
              </span>
            ` : null}
          </button>
          ${showPromptBell.value ? html`
            <div class="nav-bell-popover" id=${promptPopoverId} role="menu">
              ${visibleSessionPromptNotifications.value.length === 0 ? html`
                <div class="nav-bell-empty">No unseen prompt-ready sessions</div>
              ` : visibleSessionPromptNotifications.value.map(item => html`
                <button class="nav-bell-item" onclick=${() => openPromptNotification(item)} role="menuitem">
                  <span class="nav-bell-item-title">${item.sessionName}</span>
                  <span class="nav-bell-item-meta">${item.meta || item.label}</span>
                  <span class="nav-bell-item-detail">${item.detail}</span>
                </button>
              `)}
            </div>
          ` : null}
        </div>
        ${PRIMARY_NAV.map((item) => html`
          <a
            href=${item.path}
            class="nav-link nav-link-primary ${item.mobileDefault ? 'nav-link-mobile-default' : ''} ${isPathActive(item.path, pathname) ? 'active' : ''}"
            onclick=${(event) => onNavClick(event, item.path)}
            aria-current=${isPathActive(item.path, pathname) ? 'page' : undefined}
          >
            ${item.label}
            ${navBadge(item.path)}
          </a>
        `)}
        <div class="nav-more-wrap">
          <button
            class="nav-link nav-more-btn ${MORE_NAV.some((item) => isPathActive(item.path, pathname)) ? 'active' : ''}"
            type="button"
            onclick=${() => {
              showMoreMenu.value = !showMoreMenu.value;
              if (showMoreMenu.value) showPromptBell.value = false;
            }}
            aria-expanded=${showMoreMenu.value ? 'true' : 'false'}
            aria-controls=${morePopoverId}
            aria-label="More navigation items"
          >
            More
            ${unreadAlerts.value > 0 ? html`
              <span class="badge badge-critical nav-link-badge">${unreadAlerts.value}</span>
            ` : null}
          </button>
          ${showMoreMenu.value ? html`
            <div class="nav-more-popover" id=${morePopoverId} role="menu">
              ${PRIMARY_NAV.map((item) => html`
                <button
                  class="nav-more-item nav-more-item-mobile ${isPathActive(item.path, pathname) ? 'active' : ''}"
                  type="button"
                  onclick=${() => navigateTo(item.path)}
                  role="menuitem"
                >
                  ${item.label}
                  ${navBadge(item.path)}
                </button>
              `)}
              ${MORE_NAV.map((item) => html`
                <button class="nav-more-item ${isPathActive(item.path, pathname) ? 'active' : ''}" type="button" onclick=${() => navigateTo(item.path)} role="menuitem">
                  ${item.label}
                  ${navBadge(item.path)}
                </button>
              `)}
            </div>
          ` : null}
        </div>
      </div>
    </nav>
  `;
}
