import { html } from 'htm/preact';
import { useEffect } from 'preact/hooks';
import { api } from '../app/api.mjs';
import { useSignal } from '../app/use-signal.mjs';
import { addToast } from '../app/state.mjs';

// Multi-machine UI (docs/multi-machine-design.md §4.9). Every piece renders nothing until a machine is registered.
const away = (machine) => (machine.status === 'unreachable' ? `offline since ${new Date(machine.since).toLocaleString()}` : machine.status);

export function MachineChip({ machine }) {
  if (!machine) return null;
  return html`
    <span class="badge badge-low" title=${`Runs on ${machine.id}`}>${machine.id}</span>
    ${machine.status !== 'live' ? html`<span class="badge badge-warning" title=${away(machine)}>${machine.status}</span>` : null}
  `;
}

// A machine is offered only while it is live and runs the chosen provider.
export function RunOnSelect({ machines, provider, value, onChange }) {
  if (!machines.length) return null;
  const note = (machine) => (machine.status !== 'live' ? ` (${away(machine)})` : machine.providers.includes(provider) ? '' : ` (no ${provider})`);
  return html`
    <label class="new-agent-field">
      <span>Run on</span>
      <select class="input" value=${value} onInput=${(e) => onChange(e.target.value)}>
        <option value="">This machine</option>
        ${machines.map((machine) => html`
          <option value=${machine.id} disabled=${machine.status !== 'live' || !machine.providers.includes(provider)}>${machine.id}${note(machine)}</option>
        `)}
      </select>
    </label>
  `;
}

// Settings: a worker issues a pairing link (`cadre pair`); a hub with CADRE_HUB_MCP_URL redeems one (`cadre machine add`).
export function MachinesCard() {
  const info = useSignal(null);
  const link = useSignal('');
  const load = () => api.get('/machines').then((data) => { info.value = data; }, () => {});
  useEffect(() => { load(); }, []);
  const data = info.value;
  if (!data || (data.role !== 'worker' && !data.canAdd && !data.machines.length)) return null;

  async function pair() {
    try {
      link.value = (await api.post('/pairing/code')).link;
    } catch (error) {
      addToast(`Pairing error: ${error.message}`, 'error');
    }
  }
  async function add(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const added = await api.post('/machines', { name: form.elements.name.value.trim(), link: form.elements.link.value.trim() });
      addToast(`Paired ${added.id}${added.warning ? `; ${added.warning}` : ''}`, 'success');
      form.reset();
      await load();
    } catch (error) {
      addToast(`Add machine failed: ${error.message}`, 'error');
    }
  }

  return html`
    <div class="card">
      <div class="card-header"><span class="card-title">Machines</span></div>
      ${data.role === 'worker' ? html`
        <p style="font-size:12px; color:var(--text-muted); margin-bottom:8px">
          Pair this worker with its hub: paste the link into the hub's Machines settings within 5 minutes. Single use; treat it like a password.
        </p>
        <button class="btn btn-primary" onclick=${pair}>Pair with hub</button>
        ${link.value ? html`<input readonly class="input" style="width:100%; margin-top:8px" value=${link.value} onFocus=${(e) => e.target.select()} aria-label="Machine pairing link" />` : null}
      ` : html`
        ${data.machines.map((machine) => html`
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:13px; margin-bottom:6px">
            <span class="badge badge-low">${machine.id}</span>
            <span>${machine.label}</span>
            <span style="color:var(--text-muted)">${machine.os || 'unknown OS'}</span>
            <span class="badge ${machine.status === 'live' ? 'badge-success' : 'badge-warning'}">${away(machine)}</span>
          </div>
        `)}
        ${data.canAdd ? html`
          <form onSubmit=${add} style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px">
            <input class="input" name="name" required placeholder="name, e.g. laptop" aria-label="Machine name" style="flex:0 1 180px" />
            <input class="input" name="link" required placeholder="link from cadre pair on the worker" aria-label="Pairing link" style="flex:1; min-width:200px" />
            <button class="btn btn-primary" type="submit">Add machine</button>
          </form>
        ` : null}
      `}
    </div>
  `;
}
