import { h } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { route } from 'preact-router';
import { api } from '../app/api.mjs';
import { subscribe } from '../app/ws-client.mjs';
import { addToast } from '../app/state.mjs';
import { EmptyState, ErrorState, LoadingState } from '../components/page-state.mjs';

function sessionRoute(item = {}) {
  const kind = String(item.sessionKind || '').trim();
  const id = String(item.sessionId || '').trim();
  if (!kind || !id) return '';
  return `/${kind}/${id}`;
}

function queueItems(payload = {}, status = 'open') {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (status === 'all') return items;
  return items.filter((item) => item.status === status);
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function statusBadgeClass(status = '') {
  if (status === 'open') return 'warning';
  if (status === 'delivery_failed') return 'critical';
  if (status === 'routed') return 'info';
  return 'success';
}

function deliveryNote(item = {}) {
  const delivery = item.answer?.delivery || {};
  if (item.status === 'delivery_failed') return `Delivery failed: ${item.deliveryError || delivery.error || 'route failed'}`;
  if (item.status === 'routed') return `Delivered to ${delivery.kind || item.sessionKind}:${delivery.sessionId || item.sessionId}`;
  if (item.status === 'acknowledged') return `Acknowledged ${formatTime(item.acknowledgedAt)}`;
  if (item.status === 'answered' && item.deliveryStatus) return `Delivery: ${item.deliveryStatus}`;
  return '';
}

export function CommandQueuePage() {
  const loading = useMemo(() => signal(false), []);
  const loadError = useMemo(() => signal(''), []);
  const queue = useMemo(() => signal({ items: [], openCount: 0 }), []);
  const statusFilter = useMemo(() => signal('open'), []);

  async function loadQueue() {
    loading.value = true;
    loadError.value = '';
    try {
      queue.value = await api.get('/command-center/work-queue?status=all');
    } catch (error) {
      loadError.value = error.message || 'Unable to load queue.';
    } finally {
      loading.value = false;
    }
  }

  async function answerQueueItem(item, payload, form = null) {
    try {
      const answered = await api.post(`/command-center/work-queue/${encodeURIComponent(item.id)}/answer`, payload);
      const current = Array.isArray(queue.value?.items) ? queue.value.items : [];
      queue.value = {
        ...(queue.value || {}),
        openCount: Math.max(0, Number(queue.value?.openCount || 0) - (item.status === 'open' ? 1 : 0)),
        items: current.map((entry) => entry.id === answered.id ? answered : entry),
      };
      form?.reset?.();
      if (answered.status === 'delivery_failed') {
        addToast(`Delivery failed: ${answered.deliveryError || answered.answer?.delivery?.error || 'route failed'}`, 'error');
      } else {
        addToast('Decision sent', 'success');
      }
    } catch (error) {
      addToast(`Decision failed: ${error.message}`, 'error');
    }
  }

  useEffect(() => {
    loadQueue();
    return subscribe('command-center:work-queue', (type, data) => {
      if ((type === 'updated' || type === 'item_created' || type === 'item_answered' || type === 'item_routed' || type === 'item_delivery_failed' || type === 'item_acknowledged') && data?.items) {
        queue.value = data;
      }
    });
  }, []);

  const items = queueItems(queue.value, statusFilter.value);

  return html`
    <div class="page">
      <div class="card-header">
        <div>
          <h1 class="card-title" style="font-size:18px">Command Queue</h1>
          <p class="collab-helper" style="margin:4px 0 0">Human decisions requested by Fleet Supervisor.</p>
        </div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
          <select class="input" value=${statusFilter.value} onInput=${(event) => { statusFilter.value = event.target.value; }}>
            <option value="open">Open</option>
            <option value="answered">Answered</option>
            <option value="routed">Routed</option>
            <option value="delivery_failed">Failed</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="all">All</option>
          </select>
          <button class="btn" onclick=${loadQueue}>Refresh</button>
        </div>
      </div>

      <div class="dashboard-topline" style="margin-bottom:12px">
        <div class="dashboard-metric">
          <span>Open</span>
          <strong>${queue.value?.openCount || 0}</strong>
        </div>
        <div class="dashboard-metric">
          <span>Shown</span>
          <strong>${items.length}</strong>
        </div>
      </div>

      ${loading.value && items.length === 0
        ? html`<${LoadingState} message="Loading queue..." />`
        : loadError.value
          ? html`<${ErrorState} message=${`Queue failed to load: ${loadError.value}`} actionLabel="Retry" onAction=${loadQueue} />`
          : items.length === 0
            ? html`<${EmptyState} message="No queue items match this filter." />`
            : html`
              <div class="dashboard-attention-list">
                ${items.map((item) => {
                  const routePath = sessionRoute(item);
                  return html`
                    <div class="dashboard-action-row">
                      <div>
                        <div class="dashboard-action-title">
                          <span class="badge badge-${statusBadgeClass(item.status)}">${item.status}</span>
                          ${item.passThrough ? html`<span class="badge badge-info">pass-through</span>` : null}
                          ${item.deliveryStatus && item.deliveryStatus !== 'none' ? html`<span class="badge badge-low">${item.deliveryStatus}</span>` : null}
                          ${item.title || item.question}
                        </div>
                        <div class="dashboard-action-detail">${item.question}</div>
                        ${item.details ? html`<div class="dashboard-action-detail">${item.details}</div>` : null}
                        <div class="dashboard-action-meta">
                          <span>${item.source || 'supervisor'}</span>
                          <span>${formatTime(item.updatedAt || item.createdAt)}</span>
                          ${item.sessionKind && item.sessionId ? html`<span>${item.sessionKind}:${item.sessionId}</span>` : null}
                        </div>
                        ${item.status === 'answered' ? html`
                          <div class="goals-inline-note" style="margin-top:8px">${item.answer?.text || 'Answered'}</div>
                        ` : null}
                        ${deliveryNote(item) ? html`
                          <div class="dashboard-action-detail" style="margin-top:8px">${deliveryNote(item)}</div>
                        ` : null}
                        ${item.status === 'open' && item.options?.length ? html`
                          <div class="dashboard-row-actions" style="margin-top:8px">
                            ${item.options.map((option) => html`
                              <button class="btn" onclick=${() => answerQueueItem(item, { optionId: option.id })}>${option.label}</button>
                            `)}
                          </div>
                        ` : null}
                        ${item.status === 'open' && item.allowFreeform ? html`
                          <form
                            class="dashboard-row-actions"
                            style="margin-top:8px"
                            onsubmit=${(event) => {
                              event.preventDefault();
                              const answer = String(new FormData(event.currentTarget).get('answer') || '').trim();
                              if (!answer) return;
                              answerQueueItem(item, { answer }, event.currentTarget);
                            }}
                          >
                            <input class="input" name="answer" placeholder="Reply..." style="min-width:260px" />
                            <button class="btn btn-primary" type="submit">Send</button>
                          </form>
                        ` : null}
                      </div>
                      <div class="dashboard-row-actions">
                        ${routePath ? html`<button class="btn btn-subtle" onclick=${() => route(routePath)}>Open</button>` : null}
                      </div>
                    </div>
                  `;
                })}
              </div>
            `}
    </div>
  `;
}
