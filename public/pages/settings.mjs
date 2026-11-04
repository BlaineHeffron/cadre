import { h } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useMemo, useEffect } from 'preact/hooks';
import { loginWithToken, logoutBrowserSession, isAuthenticated, addToast } from '../app/state.mjs';
import { api } from '../app/api.mjs';
import { connectWs, disconnectWs } from '../app/ws-client.mjs';
import { isLowDataModeEnabled, setLowDataModeEnabled, connectionPrefersLowData } from '../app/network-profile.mjs';
import {
  requestPermission,
  isNotificationPermitted,
  isSoundEnabled,
  setSoundEnabled,
  isPushSubscribed,
  setPushEnabled,
} from '../app/notifications.mjs';
import {
  isApprovalOnlyEnabled,
  setApprovalOnlyEnabled,
  isBrowserNotificationsEnabled,
  setBrowserNotificationsEnabled,
} from '../app/notification-prefs.mjs';
import { encodeQr, qrSvgPath } from '../lib/qrcodegen.mjs';
import { MachinesCard } from '../components/machines.mjs';

function makeSaveToken(inputToken) {
  return async function saveToken() {
    if (!inputToken.value.trim()) {
      addToast('Enter a token', 'warning');
      return;
    }
    try {
      await loginWithToken(inputToken.value.trim());
      inputToken.value = '';
      addToast('Signed in', 'success');
      connectWs();
    } catch (error) {
      addToast(error.message, 'error');
    }
  };
}

async function logout() {
  // Stop pushing private alerts to this device once it is signed out.
  await setPushEnabled(false).catch((error) => addToast(`Phone notifications still on: ${error.message}`, 'error'));
  disconnectWs();
  await logoutBrowserSession();
  addToast('Logged out', 'info');
}

// One on/off row: the label says what it controls, the switch shows its state.
function SettingSwitch({ label, hint = '', checked, disabled = false, onChange }) {
  return html`
    <label class="setting-switch">
      <span class="setting-switch-text">
        <span>${label}</span>
        ${hint ? html`<span class="setting-switch-hint">${hint}</span>` : null}
      </span>
      <input type="checkbox" role="switch" class="switch" checked=${checked} disabled=${disabled} onInput=${async (e) => {
        // Flips at once; a change that reports failure (false) flips back.
        const input = e.currentTarget;
        if (await onChange(input.checked) === false) input.checked = !input.checked;
      }} />
    </label>
  `;
}

export function SettingsPage({ section }) {
  const inputToken = useMemo(() => signal(''), []);
  const pairing = useMemo(() => signal(null), []);
  const saveToken = useMemo(() => makeSaveToken(inputToken), []);
  const notifPermitted = useMemo(() => signal(isNotificationPermitted()), []);
  const browserOn = useMemo(() => signal(isBrowserNotificationsEnabled()), []);
  const soundOn = useMemo(() => signal(isSoundEnabled()), []);
  const pushOn = useMemo(() => signal(false), []);
  const approvalOnly = useMemo(() => signal(isApprovalOnlyEnabled()), []);
  const lowDataMode = useMemo(() => signal(isLowDataModeEnabled()), []);
  const connectionSaver = useMemo(() => signal(connectionPrefersLowData()), []);
  const agentProviders = useMemo(() => signal({
    loading: true,
    claudeEnabled: true,
    codexEnabled: true,
    deepseekEnabled: false,
    piEnabled: true,
    headroomEnabled: true,
    collabEnabled: true,
    availableSpawnTypes: ['claude', 'codex', 'pi', 'collab'],
    preferredSingleAgent: 'codex',
  }), []);
  async function loadAgentProviderPreferences() {
    if (!isAuthenticated.value) {
      agentProviders.value = { ...agentProviders.value, loading: false };
      return;
    }
    try {
      const prefs = await api.get('/agent-provider-preferences');
      agentProviders.value = {
        loading: false,
        ...prefs,
      };
    } catch (error) {
      agentProviders.value = { ...agentProviders.value, loading: false };
      addToast(`Agent provider settings error: ${error.message}`, 'error');
    }
  }

  async function saveAgentProviderPreferences(next) {
    try {
      const prefs = await api.put('/agent-provider-preferences', next);
      agentProviders.value = {
        loading: false,
        ...prefs,
      };
      addToast('Agent provider settings updated', 'success');
    } catch (error) {
      addToast(`Agent provider settings error: ${error.message}`, 'error');
      return false;
    }
  }

  async function pairPhone() {
    try {
      const { code, expiresAt } = await api.post('/auth/pair');
      const url = `${window.location.origin}/#pair=${code}`;
      const modules = encodeQr(url);
      pairing.value = { url, expiresAt, size: modules.length, path: qrSvgPath(modules) };
    } catch (error) {
      addToast(`Pairing error: ${error.message}`, 'error');
    }
  }

  async function copyPairLink() {
    try {
      await navigator.clipboard.writeText(pairing.value.url);
      addToast('Pairing link copied', 'success');
    } catch {
      addToast('Copy failed; select the link and copy it manually', 'warning');
    }
  }

  async function enableNotifications() {
    const granted = await requestPermission();
    notifPermitted.value = granted;
    if (granted) {
      browserOn.value = true;
      setBrowserNotificationsEnabled(true);
      addToast('Notifications enabled', 'success');
    } else {
      addToast('Notification permission denied', 'warning');
    }
  }

  function toggleBrowser() {
    browserOn.value = !browserOn.value;
    setBrowserNotificationsEnabled(browserOn.value);
    addToast(browserOn.value ? 'Browser notifications enabled' : 'Browser notifications disabled', 'info');
  }

  async function togglePush() {
    try {
      await setPushEnabled(!pushOn.value);
      pushOn.value = !pushOn.value;
      notifPermitted.value = isNotificationPermitted();
      addToast(pushOn.value ? 'Phone notifications enabled' : 'Phone notifications disabled', 'success');
    } catch (error) {
      addToast(`Phone notifications: ${error.message}`, 'error');
      return false;
    }
  }

  function toggleSound() {
    soundOn.value = !soundOn.value;
    setSoundEnabled(soundOn.value);
    addToast(soundOn.value ? 'Sound enabled' : 'Sound disabled', 'info');
  }

  function toggleApprovalOnly() {
    approvalOnly.value = !approvalOnly.value;
    setApprovalOnlyEnabled(approvalOnly.value);
    addToast(approvalOnly.value ? 'Approval-only notifications enabled' : 'All attention notifications enabled', 'info');
  }

  function toggleLowDataMode() {
    lowDataMode.value = !lowDataMode.value;
    setLowDataModeEnabled(lowDataMode.value);
    disconnectWs();
    connectWs();
    addToast(lowDataMode.value ? 'Low data mode enabled' : 'Low data mode disabled', 'info');
  }

  useEffect(() => {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!connection?.addEventListener) return undefined;
    const update = () => {
      connectionSaver.value = connectionPrefersLowData();
    };
    connection.addEventListener('change', update);
    return () => connection.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    isPushSubscribed().then((subscribed) => { pushOn.value = subscribed; }, () => {});
  }, []);

  useEffect(() => {
    loadAgentProviderPreferences();
  }, [isAuthenticated.value]);

  return html`
    <div class="page">
      <div class="settings-shell">
        <div class="settings-shell-head">
          <div>
            <h1 class="page-title" style="margin-bottom:4px">Settings</h1>
            <p style="color:var(--text-secondary)">System controls, auth, providers, notifications, and network behavior.</p>
          </div>
        </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">Authentication</span>
          <span class="badge ${isAuthenticated.value ? 'badge-success' : 'badge-critical'}">
            ${isAuthenticated.value ? 'Authenticated' : 'Not authenticated'}
          </span>
        </div>

        ${isAuthenticated.value ? html`
          <div style="display:flex; gap:8px; flex-wrap:wrap">
            <button class="btn btn-primary" onclick=${pairPhone}>Pair phone</button>
            <button class="btn btn-danger" onclick=${logout}>Logout</button>
          </div>
          ${pairing.value ? html`
            <div style="display:grid; gap:8px; justify-items:start; margin-top:12px">
              <svg viewBox="-4 -4 ${pairing.value.size + 8} ${pairing.value.size + 8}" width="220" height="220" role="img" aria-label="Pairing QR code" style="background:#fff; border-radius:8px">
                <path d=${pairing.value.path} fill="#000" shape-rendering="crispEdges" />
              </svg>
              <div style="display:flex; gap:8px; width:100%">
                <input readonly value=${pairing.value.url} onFocus=${e => e.target.select()} aria-label="Pairing link"
                  style="flex:1; min-width:0; padding:8px; background:var(--bg-input); border:1px solid var(--border); border-radius:var(--radius); color:var(--text-primary)" />
                <button class="btn" onclick=${copyPairLink}>Copy</button>
              </div>
              <div class="goals-inline-note">
                Scan with your phone camera to sign it in. Single use; expires at ${new Date(pairing.value.expiresAt).toLocaleTimeString()}.
                ${/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname) ? ' This page is on a loopback address your phone cannot reach; open Cadre at its Tailscale Serve URL and pair from there.' : ''}
              </div>
            </div>
          ` : null}
        ` : html`
          <div style="display:flex; gap:8px">
            <input
              type="password"
              placeholder="Enter bearer token"
              value=${inputToken.value}
              onInput=${e => { inputToken.value = e.target.value; }}
              onKeyDown=${e => { if (e.key === 'Enter') saveToken(); }}
              style="flex:1; padding:8px; background:var(--bg-input); border:1px solid var(--border); border-radius:var(--radius); color:var(--text-primary)"
            />
            <button class="btn btn-primary" onclick=${saveToken}>Save</button>
          </div>
        `}
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">Agent Providers</span>
          <span class="badge ${agentProviders.value.collabEnabled ? 'badge-success' : 'badge-warning'}">
            ${agentProviders.value.availableSpawnTypes?.join(', ') || 'none'}
          </span>
        </div>
        <p class="note" style="margin-bottom:8px">
          Toggle which agent backends are available for generated tasks and review workflows. Disabled providers are removed from the UI and the server falls back automatically.
        </p>
        <div style="display:grid">
          <${SettingSwitch} label="Enable Claude-backed workflows" checked=${agentProviders.value.claudeEnabled} disabled=${agentProviders.value.loading} onChange=${(claudeEnabled) => saveAgentProviderPreferences({ claudeEnabled })} />
          <${SettingSwitch} label="Enable Codex-backed workflows" checked=${agentProviders.value.codexEnabled} disabled=${agentProviders.value.loading} onChange=${(codexEnabled) => saveAgentProviderPreferences({ codexEnabled })} />
          <${SettingSwitch} label="Enable DeepSeek Harness (ACP)" checked=${agentProviders.value.deepseekEnabled} disabled=${agentProviders.value.loading} onChange=${(deepseekEnabled) => saveAgentProviderPreferences({ deepseekEnabled })} />
          <${SettingSwitch} label="Enable Pi-backed providers" checked=${agentProviders.value.piEnabled} disabled=${agentProviders.value.loading} onChange=${(piEnabled) => saveAgentProviderPreferences({ piEnabled })} />
          <${SettingSwitch} label="Enable Headroom context compression" checked=${agentProviders.value.headroomEnabled !== false} disabled=${agentProviders.value.loading} onChange=${(headroomEnabled) => saveAgentProviderPreferences({ headroomEnabled })} />
          <div class="note">
            Uses the local Headroom proxy for all providers. Applies to new sessions and resumed processes;
            running sessions keep their current connection. Turn off to connect directly.
          </div>
        </div>
        <div style="font-size:var(--fs-xs); color:var(--text-secondary); margin-top:10px">
          Preferred single-agent fallback: ${agentProviders.value.preferredSingleAgent || 'unknown'}<br />
          Collaboration available: ${agentProviders.value.collabEnabled ? 'yes' : 'no'}
        </div>
      </div>

      ${isAuthenticated.value ? html`<${MachinesCard} />` : null}

      <div class="card">
        <div class="card-header">
          <span class="card-title">Notifications</span>
          <span class="badge ${notifPermitted.value && browserOn.value ? 'badge-success' : 'badge-low'}">
            ${notifPermitted.value && browserOn.value ? 'Enabled' : 'Disabled'}
          </span>
        </div>
        <p class="note" style="margin-bottom:8px">
          Get notified when agent sessions need your input.
        </p>
        ${!notifPermitted.value ? html`
          <button class="btn btn-primary" style="margin-bottom:8px" onclick=${enableNotifications}>Enable Notifications</button>
        ` : html`
          <${SettingSwitch} label="Browser notifications" hint="Alert in this browser when a session needs you." checked=${browserOn.value} onChange=${toggleBrowser} />
        `}
        <${SettingSwitch} label="Phone notifications" hint="Push to paired phones." checked=${pushOn.value} onChange=${togglePush} />
        <${SettingSwitch} label="Sound" hint="Play a sound with each alert." checked=${soundOn.value} onChange=${toggleSound} />
        <${SettingSwitch} label="Approval prompts only" hint="Skip alerts for sessions that are just idle." checked=${approvalOnly.value} onChange=${toggleApprovalOnly} />
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">Network</span>
          <span class="badge ${lowDataMode.value || connectionSaver.value ? 'badge-warning' : 'badge-low'}">
            ${lowDataMode.value ? 'Low Data On' : (connectionSaver.value ? 'Network Saver' : 'Normal')}
          </span>
        </div>
        <p class="note" style="margin-bottom:8px">
          Low data mode slows background refreshes and pauses live WebSocket updates when the tab is hidden. This is most useful on mobile data.
        </p>
        <${SettingSwitch}
          label="Low data mode"
          hint=${connectionSaver.value ? 'Browser connection saver is also active.' : ''}
          checked=${lowDataMode.value}
          onChange=${toggleLowDataMode} />
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">About</span>
        </div>
        <p style="font-size:var(--fs-sm); color:var(--text-secondary)">
          Cadre — Self-hosted control plane for running, coordinating and monitoring coding-agent sessions.
        </p>
        <p class="note" style="margin-top:4px">
          Preact + HTM • Fastify • WebSocket
        </p>
      </div>
      </div>
    </div>
  `;
}
