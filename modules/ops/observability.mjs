import { getProductionControlRegistry } from './production-controls.mjs';
import { buildOpsControlEventStore } from './control-events.mjs';

function normalizeText(value) {
  return String(value || '').trim();
}

function labelsKey(labels = {}) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(labels || {})
        .map(([key, value]) => [key, normalizeText(value)])
        .sort(([a], [b]) => a.localeCompare(b))
    )
  );
}

function toPrometheusName(name) {
  return String(name || '')
    .trim()
    .replace(/[^a-zA-Z0-9_:]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

class OpsMetricsRegistry {
  constructor() {
    this.reset();
  }

  reset() {
    this.warnings = new Map();
    this.counters = new Map();
    this.timings = new Map();
    this.gauges = new Map();
  }

  incrementCounter(name, value = 1, labels = {}) {
    const metricName = normalizeText(name);
    if (!metricName) return;
    const key = `${metricName}:${labelsKey(labels)}`;
    const entry = this.counters.get(key) || { name: metricName, labels, value: 0 };
    entry.value += Number(value || 0);
    this.counters.set(key, entry);
  }

  recordWarning(code) {
    if (typeof code !== 'string' || !code.trim()) return;
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const entry = this.warnings.get(code) || { times: [], escalatedDay: '' };
    entry.times = entry.times.filter((time) => time > now - 600_000).slice(-100);
    entry.times.push(now);
    this.incrementCounter('warning_total', 1, { code });
    if (entry.times.length > 100 && entry.escalatedDay !== day) {
      entry.escalatedDay = day;
      this.incrementCounter('warning_escalation_total', 1, { code });
    }
    this.warnings.set(code, entry);
  }

  warningHealth() {
    const codes = [...this.warnings].filter(([, entry]) => (
      entry.times.filter((time) => time > Date.now() - 600_000).length > 100
    )).map(([code]) => code);
    return { status: codes.length ? 'degraded' : 'ok', detail: codes.length ? 'repeated_warnings' : 'warnings_ok', data: { codes } };
  }

  recordTiming(name, durationMs, labels = {}) {
    const metricName = normalizeText(name);
    if (!metricName) return;
    const key = `${metricName}:${labelsKey(labels)}`;
    const entry = this.timings.get(key) || {
      name: metricName,
      labels,
      count: 0,
      totalMs: 0,
      minMs: null,
      maxMs: null,
      samples: [],
    };
    const normalizedDuration = Math.max(0, Number(durationMs || 0));
    entry.count += 1;
    entry.totalMs += normalizedDuration;
    entry.minMs = entry.minMs === null ? normalizedDuration : Math.min(entry.minMs, normalizedDuration);
    entry.maxMs = entry.maxMs === null ? normalizedDuration : Math.max(entry.maxMs, normalizedDuration);
    entry.samples.push(normalizedDuration);
    if (entry.samples.length > 500) {
      entry.samples = entry.samples.slice(-500);
    }
    this.timings.set(key, entry);
  }

  registerGauge(name, reader) {
    const metricName = normalizeText(name);
    if (!metricName || typeof reader !== 'function') return;
    this.gauges.set(metricName, reader);
  }

  observeDuration(name, labels, startedAtMs) {
    const elapsed = Date.now() - Number(startedAtMs || Date.now());
    this.recordTiming(name, elapsed, labels);
  }

  snapshot() {
    const counters = [...this.counters.values()].map((item) => ({ ...item }));
    const timings = [...this.timings.values()].map((item) => ({
      ...item,
      avgMs: item.count > 0 ? Math.round((item.totalMs / item.count) * 100) / 100 : 0,
      p50Ms: percentile(item.samples, 0.5),
      p95Ms: percentile(item.samples, 0.95),
      p99Ms: percentile(item.samples, 0.99),
    }));
    const gauges = [...this.gauges.entries()].map(([name, reader]) => {
      let value = null;
      try {
        value = reader();
      } catch (error) {
        value = { error: error.message || 'gauge_failed' };
      }
      return { name, value };
    });
    return {
      generatedAt: new Date().toISOString(),
      counters,
      timings,
      gauges,
    };
  }

  toPrometheus() {
    const lines = [];
    const snapshot = this.snapshot();
    for (const counter of snapshot.counters) {
      lines.push(formatPrometheusMetric(counter.name, counter.labels, counter.value));
    }
    for (const timing of snapshot.timings) {
      lines.push(formatPrometheusMetric(`${timing.name}_count`, timing.labels, timing.count));
      lines.push(formatPrometheusMetric(`${timing.name}_total_ms`, timing.labels, timing.totalMs));
      lines.push(formatPrometheusMetric(`${timing.name}_avg_ms`, timing.labels, timing.avgMs));
    }
    for (const gauge of snapshot.gauges) {
      if (typeof gauge.value === 'number') {
        lines.push(formatPrometheusMetric(gauge.name, {}, gauge.value));
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

function percentile(samples = [], quantile = 0.95) {
  if (!Array.isArray(samples) || samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

function formatPrometheusMetric(name, labels, value) {
  const metricName = toPrometheusName(name);
  const labelEntries = Object.entries(labels || {}).filter(([, labelValue]) => normalizeText(labelValue));
  const suffix = labelEntries.length > 0
    ? `{${labelEntries.map(([key, labelValue]) => `${toPrometheusName(key)}="${String(labelValue).replace(/"/g, '\\"')}"`).join(',')}}`
    : '';
  return `${metricName}${suffix} ${Number(value || 0)}`;
}

const registry = new OpsMetricsRegistry();

export function opsLogMethod(args, method, level) {
  if (level === 40) registry.recordWarning(args[0]?.code || args[0]?.err?.code);
  return method.apply(this, args);
}

export function getOpsMetricsRegistry() {
  return registry;
}

export function incrementOpsCounter(name, value = 1, labels = {}) {
  registry.incrementCounter(name, value, labels);
}

export function recordOpsTiming(name, durationMs, labels = {}) {
  registry.recordTiming(name, durationMs, labels);
}

export function registerOpsGauge(name, reader) {
  registry.registerGauge(name, reader);
}

export async function opsObservabilityPlugin(app, {
  productionControls = getProductionControlRegistry(),
  controlEventStore = buildOpsControlEventStore(),
} = {}) {
  if (typeof productionControls.ready === 'function') {
    await productionControls.ready();
  }

  registerOpsGauge('production_control_kill_switches_active', () => productionControls.snapshot().killSwitchesActive.length);

  app.addHook('onClose', async () => {
    if (controlEventStore && typeof controlEventStore.close === 'function') {
      await controlEventStore.close();
    }
    if (productionControls && typeof productionControls.close === 'function') {
      await productionControls.close();
    }
  });

  app.get('/api/ops/status', async () => ({
    status: 'ok',
    controls: productionControls.snapshot(),
    controlAudit: productionControls.getAuditSummary({ sinceHours: 24 }),
    controlEvents: await controlEventStore.getSummary({ sinceHours: 24 }),
  }));

  app.get('/api/ops/controls', async (req) => ({
    controls: productionControls.snapshot(),
    controlAudit: productionControls.getAuditSummary({
      sinceHours: req.query?.sinceHours === undefined ? 24 : Number(req.query.sinceHours),
    }),
  }));

  app.get('/api/ops/controls/audit', async (req) => ({
    summary: productionControls.getAuditSummary({
      sinceHours: req.query?.sinceHours === undefined ? 24 : Number(req.query.sinceHours),
    }),
    entries: productionControls.getAuditHistory({
      flagKey: req.query?.flagKey,
      module: req.query?.module,
      action: req.query?.action,
      changedBy: req.query?.changedBy,
      limit: req.query?.limit,
    }),
  }));

  app.put('/api/ops/controls/:flagKey/override', async (req, reply) => {
    try {
      const flag = await productionControls.setOverride(req.params.flagKey, {
        enabled: req.body?.enabled,
        changedBy: req.body?.changedBy,
        reason: req.body?.reason,
        metadata: req.body?.metadata,
      });
      return {
        ok: true,
        flag,
        controls: productionControls.snapshot(),
      };
    } catch (error) {
      if (/Unknown production control flag/i.test(error?.message || '')) {
        return reply.code(404).send({ error: error.message });
      }
      return reply.code(400).send({ error: error?.message || 'Failed to set override' });
    }
  });

  app.delete('/api/ops/controls/:flagKey/override', async (req, reply) => {
    try {
      const flag = await productionControls.clearOverride(req.params.flagKey, {
        changedBy: req.body?.changedBy,
        reason: req.body?.reason,
        metadata: req.body?.metadata,
      });
      if (!flag) {
        return reply.code(404).send({ error: `No runtime override exists for ${req.params.flagKey}` });
      }
      return {
        ok: true,
        flag,
        controls: productionControls.snapshot(),
      };
    } catch (error) {
      if (/Unknown production control flag/i.test(error?.message || '')) {
        return reply.code(404).send({ error: error.message });
      }
      return reply.code(400).send({ error: error?.message || 'Failed to clear override' });
    }
  });

  app.get('/api/ops/metrics', async (req, reply) => {
    const format = normalizeText(req.query?.format || '').toLowerCase();
    if (format === 'prometheus' || format === 'text') {
      reply.type('text/plain; version=0.0.4');
      return registry.toPrometheus();
    }
    return registry.snapshot();
  });

  app.get('/api/ops/events', async (req) => {
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
    const sinceHours = req.query?.sinceHours === undefined ? 24 : Number(req.query?.sinceHours);
    return {
      summary: await controlEventStore.getSummary({ sinceHours }),
      events: await controlEventStore.listEvents({
        type: req.query?.type,
        severity: req.query?.severity,
        module: req.query?.module,
        action: req.query?.action,
        outcome: req.query?.outcome,
        code: req.query?.code,
        limit,
      }),
    };
  });
}
