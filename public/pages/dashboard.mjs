import { h } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { route } from 'preact-router';
import { api } from '../app/api.mjs';
import { ErrorState, LoadingState } from '../components/page-state.mjs';
import { addToast } from '../app/state.mjs';

const DEFAULT_PROVIDER = 'codex';
const DEFAULT_MODEL = 'gpt-6-sol';

const REPORT_TASK_LABELS = {
  sched_bhc_daily_ceo_brief: 'Daily CEO Brief',
  sched_bhc_followup_controller_daily: 'Follow-Up Controller',
  sched_bhc_pipeline_builder_48h: 'Pipeline Builder',
  sched_bhc_seo_publishing_weekly: 'SEO Publishing',
  sched_fleet_hygiene_biweekly: 'Fleet Hygiene Audit',
  sched_fleet_hygiene_daily: 'Fleet Hygiene Audit',
  sched_dependency_watch_15day: 'Dependency Watch',
};

function normalizeProvider(provider = '') {
  const text = String(provider || '').trim().toLowerCase();
  if (!text) return DEFAULT_PROVIDER;
  if (text === 'chatgpt') return 'codex';
  if (text === 'anthropic') return 'claude';
  return text;
}

function sessionRoute(session = {}, fallbackProvider = DEFAULT_PROVIDER) {
  const id = session?.id || session?.sessionId || '';
  if (!id) return '';
  const backendType = String(session?.backendType || '').trim().toLowerCase();
  const provider = normalizeProvider(session?.provider || fallbackProvider);
  const sessionName = String(session?.sessionName || '').trim().toLowerCase();
  const kind = ['claude', 'codex', 'pi'].includes(backendType)
    ? backendType
    : ['xai', 'google', 'gemini', 'opencode-go', 'opencode', 'openrouter'].includes(provider)
      ? 'pi'
      : provider === 'codex' || sessionName.startsWith('codex-')
        ? 'codex'
        : 'claude';
  return `/${kind}/${id}`;
}

function formatTimestamp(value) {
  if (!value) return 'never';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function formatInterval(seconds) {
  const value = Number(seconds || 0);
  if (!value) return 'manual';
  if (value % 86400 === 0) return `${value / 86400}d`;
  if (value % 3600 === 0) return `${value / 3600}h`;
  if (value % 60 === 0) return `${value / 60}m`;
  return `${value}s`;
}

function stripAnsi(value = '') {
  return String(value || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
    .trim();
}

function reportExcerpt(payload = {}) {
  const raw = payload.content || payload.transcript || payload.output || '';
  const cleaned = stripAnsi(raw);
  if (!cleaned) return '';
  const lines = cleaned
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith('›') && !line.includes('Implement {feature}'));
  return lines.slice(-28).join('\n').slice(-3600);
}

function isReportTask(task = {}) {
  const id = String(task.id || '');
  return id.startsWith('sched_bhc_')
    || id === 'sched_fleet_hygiene_biweekly'
    || id === 'sched_fleet_hygiene_daily'
    || id === 'sched_dependency_watch_15day';
}

function reportTitle(task = {}) {
  return REPORT_TASK_LABELS[task.id] || String(task.id || 'Scheduled report').replace(/^sched_/, '').replaceAll('_', ' ');
}

function severityRank(severity = '') {
  return { critical: 4, high: 3, error: 3, degraded: 2, warning: 2, medium: 2, low: 1 }[String(severity || '').toLowerCase()] || 0;
}

function badgeTone(severity = '') {
  const rank = severityRank(severity);
  if (rank >= 4) return 'critical';
  if (rank >= 3) return 'critical';
  if (rank >= 2) return 'warning';
  return 'info';
}

async function fetchJson(path, fallback) {
  return api.get(path).catch(() => fallback);
}

async function loadSessionReports(tasks = []) {
  const entries = await Promise.all(tasks.map(async (task) => {
    if (!task.lastSessionId) return [task.id, ''];
    const kind = normalizeProvider(task.provider || DEFAULT_PROVIDER);
    const payload = await fetchJson(`/${kind}/sessions/${encodeURIComponent(task.lastSessionId)}?lines=120`, null);
    return [task.id, payload ? reportExcerpt(payload) : 'Report session not available.'];
  }));
  return Object.fromEntries(entries);
}

async function loadDashboard(state) {
  state.loading.value = true;
  state.error.value = '';
  try {
    const [
      ccStatus,
      opsSummary,
      deployments,
      incidents,
      threatOverview,
      threatAlerts,
      scheduled,
    ] = await Promise.all([
      fetchJson('/command-center/status', null),
      fetchJson('/ops/summary', null),
      fetchJson('/fleet/deployments', { deployments: [] }),
      fetchJson('/fleet/incidents?status=open&limit=20', { incidents: [] }),
      fetchJson('/threats/overview', { summary: {}, recentAlerts: [] }),
      fetchJson('/threats/alerts?limit=100', { alerts: [] }),
      fetchJson('/agents/scheduled', { tasks: [] }),
    ]);

    const reportTasks = (scheduled.tasks || []).filter(isReportTask)
      .sort((a, b) => Number(a.intervalSeconds || 0) - Number(b.intervalSeconds || 0));

    state.ccStatus.value = ccStatus;
    state.opsSummary.value = opsSummary;
    state.deployments.value = deployments.deployments || [];
    state.incidents.value = incidents.incidents || [];
    state.threatOverview.value = threatOverview;
    state.threatAlerts.value = (threatAlerts.alerts || [])
      .filter((alert) => !alert.acknowledged && severityRank(alert.severity) >= severityRank('high'));
    state.reportTasks.value = reportTasks;
    state.reportOutputs.value = await loadSessionReports(reportTasks);

  } catch (error) {
    state.error.value = error.message || 'Unable to load command center.';
    addToast(`Command center load failed: ${error.message}`, 'error');
  } finally {
    state.loading.value = false;
  }
}

async function replayEligibleDeliveries(state) {
  const replayCount = Number(state.opsSummary.value?.agentBus?.replayEligibleCount || 0);
  if (!window.confirm(`Replay ${replayCount || 'eligible'} failed/timed-out agent bus deliver${replayCount === 1 ? 'y' : 'ies'} now?`)) {
    return;
  }
  try {
    const result = await api.post('/agent-bus/deliveries/replay-eligible', {
      limit: 50,
      requestedBy: 'dashboard',
    });
    addToast(`Replayed ${result.replayedCount || 0}; ${result.failedCount || 0} failed`, result.failedCount ? 'error' : 'success');
    await loadDashboard(state);
  } catch (err) {
    addToast(`Replay failed: ${err.message}`, 'error');
  }
}

function buildAttentionItems(state) {
  const deployments = state.deployments.value || [];
  const incidents = state.incidents.value || [];
  const ops = state.opsSummary.value || {};
  const threats = state.threatAlerts.value || [];
  const items = [];

  for (const deployment of deployments) {
    const snap = deployment.latestSnapshot || {};
    const errorCount = Number(snap.debugCounts?.bySeverity?.error || 0);
    const warningCount = Number(snap.debugCounts?.bySeverity?.warning || 0);
    if (snap.reachable === false || snap.status !== 'ok' || errorCount > 0) {
      items.push({
        id: `deployment-${deployment.deploymentId}`,
        severity: snap.reachable === false || snap.status === 'failed' ? 'critical' : 'high',
        title: `${snap.displayName || deployment.deploymentId} ${snap.status || 'unknown'}`,
        detail: snap.error || `${errorCount} errors, ${warningCount} warnings · ${(snap.markers || []).join(', ') || 'diagnostics'}`,
        actionLabel: 'Open Fleet',
        action: () => route('/fleet'),
      });
    }
  }

  for (const incident of incidents) {
    items.push({
      id: `incident-${incident.id}`,
      severity: incident.severity || 'high',
      title: incident.title || incident.message || incident.id,
      detail: incident.deploymentId || incident.status || 'fleet incident',
      actionLabel: 'Open Fleet',
      action: () => route('/fleet'),
    });
  }

  const readiness = ops.readiness || {};
  if (readiness.status && readiness.status !== 'ok') {
    items.push({
      id: 'fleet-readiness',
      severity: readiness.status === 'failed' ? 'critical' : 'high',
      title: `Fleet readiness ${readiness.status}`,
      detail: Object.entries(readiness.components || {})
        .filter(([, component]) => component?.status && component.status !== 'ok')
        .map(([key, component]) => `${key}: ${component.detail || component.status}`)
        .join(' · ') || 'readiness degraded',
      actionLabel: 'Refresh',
      action: () => loadDashboard(state),
    });
  }

  const replayCount = Number(ops.agentBus?.replayEligibleCount || 0);
  if (replayCount > 0) {
    items.push({
      id: 'fleet-replay',
      severity: 'high',
      title: `${replayCount} failed/timed-out agent deliveries`,
      detail: 'Agent Bus replay queue has eligible failures.',
      actionLabel: 'Open Collab',
      action: () => route('/collab'),
      secondaryActionLabel: 'Replay Eligible',
      secondaryAction: () => replayEligibleDeliveries(state),
    });
  }

  for (const alert of threats) {
    items.push({
      id: alert.id,
      severity: alert.severity,
      title: alert.message,
      detail: `${alert.category || 'threat'} · ${formatTimestamp(alert.timestamp)}`,
      actionLabel: 'Open Threats',
      action: () => route('/threats'),
    });
  }

  return items.sort((a, b) => severityRank(b.severity) - severityRank(a.severity)).slice(0, 8);
}

export function DashboardPage() {
  const loading = useMemo(() => signal(false), []);
  const error = useMemo(() => signal(''), []);
  const ccStatus = useMemo(() => signal(null), []);
  const opsSummary = useMemo(() => signal(null), []);
  const deployments = useMemo(() => signal([]), []);
  const incidents = useMemo(() => signal([]), []);
  const threatOverview = useMemo(() => signal({ summary: {} }), []);
  const threatAlerts = useMemo(() => signal([]), []);
  const reportTasks = useMemo(() => signal([]), []);
  const reportOutputs = useMemo(() => signal({}), []);
  const supervisorLaunching = useMemo(() => signal(false), []);
  const reportBusy = useMemo(() => signal(''), []);

  const state = {
    loading,
    error,
    ccStatus,
    opsSummary,
    deployments,
    incidents,
    threatOverview,
    threatAlerts,
    reportTasks,
    reportOutputs,
  };

  useEffect(() => { loadDashboard(state); }, []);

  async function launchSupervisor() {
    supervisorLaunching.value = true;
    try {
      const result = await api.post('/command-center/supervisor/launch', {
        provider: DEFAULT_PROVIDER,
        model: DEFAULT_MODEL,
      });
      ccStatus.value = { ...(ccStatus.value || {}), supervisor: { active: true, session: result } };
      addToast(result.alreadyRunning ? 'Fleet Supervisor already running' : 'Fleet Supervisor launched', 'success');
      const path = sessionRoute(result, DEFAULT_PROVIDER);
      if (path) route(path);
    } catch (err) {
      addToast(`Supervisor launch failed: ${err.message}`, 'error');
    } finally {
      supervisorLaunching.value = false;
    }
  }

  async function runReportNow(task) {
    reportBusy.value = task.id;
    try {
      await api.post('/agents/scheduled', {
        ...task,
        status: 'active',
        startImmediately: true,
        nextRunAtEpochMs: Date.now(),
      });
      const step = await api.post('/agents/scheduled/step-now', {});
      addToast(step.spawned ? 'Report run queued' : 'Scheduler tick complete', 'success');
      await loadDashboard(state);
    } catch (err) {
      addToast(`Report run failed: ${err.message}`, 'error');
    } finally {
      reportBusy.value = '';
    }
  }

  if (loading.value && !opsSummary.value) {
    return html`<div class="page"><${LoadingState} message="Loading command center..." /></div>`;
  }

  if (error.value && !opsSummary.value) {
    return html`
      <div class="page">
        <${ErrorState} message=${`Command Center failed to load: ${error.value}`} actionLabel="Retry" onAction=${() => loadDashboard(state)} />
      </div>
    `;
  }

  const supervisorSession = ccStatus.value?.supervisor?.session || null;
  const supervisorPath = sessionRoute(supervisorSession, DEFAULT_PROVIDER);
  const attentionItems = buildAttentionItems(state);

  return html`
    <div class="page goals-page">
      <div class="goals-hero">
        <div>
          <div class="goals-kicker">Command Center</div>
          <h1 class="goals-title">Alerts and briefs</h1>
        </div>
        <div class="goals-hero-actions">
          ${ccStatus.value?.supervisor?.active && supervisorPath
            ? html`<button class="btn btn-primary" onclick=${() => route(supervisorPath)}>Open Supervisor</button>`
            : html`<button class="btn btn-primary" disabled=${supervisorLaunching.value} onclick=${launchSupervisor}>${supervisorLaunching.value ? 'Launching...' : 'Launch Supervisor'}</button>`
          }
          <button class="btn btn-subtle" onclick=${() => loadDashboard(state)}>Refresh</button>
        </div>
      </div>

      <div class="card goals-command-card">
        <div class="card-header">
          <div>
            <div class="goals-command-kicker">Attention</div>
            <h2 class="card-title">Outages, Fleet Errors, Threats</h2>
          </div>
        </div>
        <div class="dashboard-attention-list">
          ${attentionItems.map((item) => html`
            <div class="dashboard-action-row">
              <div>
                <div class="dashboard-action-title">
                  <span class="badge badge-${badgeTone(item.severity)}">${item.severity}</span>
                  ${item.title}
                </div>
                <div class="dashboard-action-detail">${item.detail}</div>
              </div>
              <div class="dashboard-row-actions">
                ${item.secondaryAction ? html`<button class="btn btn-primary" onclick=${item.secondaryAction}>${item.secondaryActionLabel}</button>` : null}
                <button class="btn" onclick=${item.action}>${item.actionLabel}</button>
              </div>
            </div>
          `)}
          ${attentionItems.length === 0 ? html`<div class="goals-inline-note">No watched-system outages, fleet errors, or high-risk threats right now.</div>` : null}
        </div>
      </div>

      <section class="fleet-section">
        <div class="card-header">
          <div>
            <div class="goals-command-kicker">Briefs</div>
            <h2 class="card-title">Latest Scheduled Reports</h2>
          </div>
          <button class="btn btn-subtle" onclick=${() => route('/scheduled-agents')}>Manage schedules</button>
        </div>
        <div class="grid grid-2">
          ${reportTasks.value.map((task) => {
            const output = reportOutputs.value[task.id] || '';
            const path = task.lastSessionId ? sessionRoute({ id: task.lastSessionId, provider: task.provider }, task.provider) : '';
            return html`
              <article class="card fleet-card">
                <div class="card-header">
                  <div>
                    <h3 class="card-title" style="font-size:16px">${reportTitle(task)}</h3>
                    <div class="fleet-meta">every ${formatInterval(task.intervalSeconds)} · next ${formatTimestamp(task.nextRunAtEpochMs)}</div>
                  </div>
                  <span class="badge badge-${task.status === 'active' ? 'success' : task.status === 'canceled' ? 'low' : 'info'}">${task.status}</span>
                </div>
                <div class="dashboard-ops-summary">
                  <div class="dashboard-ops-row">
                    <span>Last report</span>
                    <span>${task.lastSessionId || 'none'}</span>
                  </div>
                  <div class="dashboard-ops-row">
                    <span>Runs</span>
                    <span>${task.currentIteration || 0}${task.maxIterations ? `/${task.maxIterations}` : ''}</span>
                  </div>
                </div>
                <pre class="terminal" style="max-height:260px; margin-top:12px">${output || 'No last report captured yet.'}</pre>
                <div class="fleet-incident-actions" style="margin-top:12px">
                  ${path ? html`<button class="btn btn-subtle" onclick=${() => route(path)}>Open report</button>` : null}
                  <button class="btn" disabled=${reportBusy.value === task.id} onclick=${() => runReportNow(task)}>
                    ${reportBusy.value === task.id ? 'Running...' : 'Run now'}
                  </button>
                </div>
              </article>
            `;
          })}
        </div>
      </section>
    </div>
  `;
}
