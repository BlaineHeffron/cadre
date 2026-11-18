// The provider, model and thinking-level fields of the new-session form, shared with Hand off….
import { html } from 'htm/preact';
import { api } from '../app/api.mjs';
import { normalizeProvider } from '../app/agent-session-nav.mjs';
import { addToast } from '../app/state.mjs';

export const DEFAULT_THINKING_LEVEL = 'medium';

const FALLBACK_PROVIDER_MODELS = Object.freeze({
  codex: 'gpt-6.1-sol',
  claude: 'claude-opus-5-5',
});

const CODEX_REASONING_LEVELS = Object.freeze([
  { id: 'low', label: 'Low', description: 'Fast responses with lighter reasoning' },
  { id: 'medium', label: 'Medium', description: 'Balances speed and reasoning depth' },
  { id: 'high', label: 'High', description: 'Greater reasoning depth for complex problems' },
  { id: 'xhigh', label: 'Extra high', description: 'Extra high reasoning depth for complex problems' },
]);

const SOL_REASONING_LEVELS = Object.freeze([
  ...CODEX_REASONING_LEVELS,
  { id: 'max', label: 'Max', description: 'Maximum reasoning depth for the hardest problems' },
  { id: 'ultra', label: 'Ultra', description: 'Maximum reasoning with automatic task delegation' },
]);

export function providerLabel(provider = '') {
  const normalized = normalizeProvider(provider);
  if (normalized === 'codex') return 'Codex';
  if (normalized === 'claude') return 'Claude';
  return normalized || 'Agent';
}

export function sessionKindForProvider(provider = '', modelCatalog = null) {
  const normalized = normalizeProvider(provider);
  const entry = (modelCatalog?.providers || [])
    .find((item) => normalizeProvider(item?.id) === normalized);
  if (entry?.sessionKind || entry?.backendType) return String(entry.sessionKind || entry.backendType);
  if (normalized === 'codex' || normalized === 'claude') return normalized;
  return '';
}

export function defaultModelForProvider(provider = '', modelCatalog = null) {
  const normalizedProvider = normalizeProvider(provider);
  const providerCatalog = modelCatalog?.providers || [];
  const catalogEntry = providerCatalog.find((entry) => normalizeProvider(entry?.id) === normalizedProvider) || null;
  const discoveredDefault = String(catalogEntry?.defaultModel || '').trim();
  if (discoveredDefault) return discoveredDefault;
  return FALLBACK_PROVIDER_MODELS[normalizedProvider] || '';
}

export function isCodexSolModel(model = '') {
  const id = String(model || '').trim().toLowerCase();
  return id === 'gpt-6.1-sol' || id === 'gpt-5.6-sol';
}

export function codexReasoningLevels(model = '') {
  return isCodexSolModel(model) ? SOL_REASONING_LEVELS : CODEX_REASONING_LEVELS;
}

export function defaultThinkingLevelFor(provider = '', model = '') {
  if (/fable/i.test(String(model))) return 'high';
  return normalizeProvider(provider) === 'codex' && isCodexSolModel(model)
    ? 'low'
    : DEFAULT_THINKING_LEVEL;
}

export function withDefaultModelChoice(provider = '', choices = [], modelCatalog = null) {
  const defaultModel = defaultModelForProvider(provider, modelCatalog);
  const normalizedChoices = Array.isArray(choices) ? choices : [];
  if (!defaultModel) return normalizedChoices;
  if (normalizedChoices.some((entry) => (entry?.id || entry) === defaultModel)) {
    return normalizedChoices;
  }
  return [{ id: defaultModel, label: defaultModel }, ...normalizedChoices];
}

export async function loadModelCatalog(modelCatalogState, modelCatalogLoading) {
  modelCatalogLoading.value = true;
  try {
    const [data, providerData] = await Promise.all([
      api.get('/agent-bus/model-catalog'),
      api.get('/agents/providers'),
    ]);
    const enabled = new Set((providerData?.providers || [])
      .filter((entry) => entry?.enabled !== false)
      .map((entry) => normalizeProvider(entry?.id)));
    const providers = (data?.providers || []).filter((entry) => enabled.has(normalizeProvider(entry?.id)));
    modelCatalogState.value = {
      ...(data || {}),
      providers,
      models: Object.fromEntries(providers.map((entry) => [entry.id, data?.models?.[entry.id] || []])),
    };
  } catch (e) {
    addToast(`Failed to load model catalog: ${e.message}`, 'error');
  } finally {
    modelCatalogLoading.value = false;
  }
}

// `value` is { provider, model, thinkingLevel }; onChange gets the whole next value. `afterProvider`
// renders between the provider and model fields (the new-session form's Run on).
export function ProviderModelFields({ catalog, value, onChange, afterProvider = null }) {
  const provider = normalizeProvider(value.provider);
  const providerChoices = catalog?.providers?.length
    ? catalog.providers.map((entry) => ({ id: normalizeProvider(entry.id), label: entry.label || providerLabel(entry.id) }))
    : [{ id: 'codex', label: 'Codex' }, { id: 'claude', label: 'Claude' }];
  const modelChoices = withDefaultModelChoice(provider, catalog?.models?.[provider] || [], catalog);
  const setModel = (model, next = provider) => onChange({ provider: next, model, thinkingLevel: defaultThinkingLevelFor(next, model) });
  return html`
    <label class="new-agent-field">
      <span>Provider</span>
      <select
        class="input"
        value=${provider}
        onInput=${(e) => { const next = normalizeProvider(e.target.value); setModel(defaultModelForProvider(next, catalog), next); }}>
        ${providerChoices.map((option) => html`<option value=${option.id}>${option.label}</option>`)}
      </select>
    </label>
    ${afterProvider}
    <label class="new-agent-field">
      <span>Model</span>
      <select class="input" value=${value.model} onInput=${(e) => setModel(e.target.value)}>
        ${modelChoices.length === 0 ? html`
          <option value=${value.model}>${value.model || 'Loading models...'}</option>
        ` : modelChoices.map((model) => html`
          <option value=${model.id || model}>${model.label || model.id || model}</option>
        `)}
      </select>
    </label>
    <label class="new-agent-field">
      <span>Thinking level</span>
      ${provider === 'codex' ? html`
        <select class="input" value=${value.thinkingLevel} onInput=${(e) => onChange({ ...value, thinkingLevel: e.target.value })}>
          ${codexReasoningLevels(value.model).map((level) => html`
            <option value=${level.id} title=${level.description}>${level.label}</option>
          `)}
        </select>
      ` : html`
        <input
          class="input"
          placeholder=${DEFAULT_THINKING_LEVEL}
          value=${value.thinkingLevel}
          onInput=${(e) => onChange({ ...value, thinkingLevel: e.target.value })} />
      `}
    </label>
  `;
}
