function normalizeStatus(value, fallback = 'failed') {
  const normalized = String(value || '').trim().toLowerCase();
  return ['ok', 'degraded', 'failed'].includes(normalized) ? normalized : fallback;
}

export function summarizeReadiness(components = {}) {
  const normalizedComponents = Object.fromEntries(
    Object.entries(components).map(([key, component]) => [
      key,
      {
        status: normalizeStatus(component?.status),
        detail: component?.detail || '',
        data: component?.data ?? null,
      },
    ])
  );

  const statuses = Object.values(normalizedComponents).map((component) => component.status);
  const failed = statuses.includes('failed');
  const degraded = statuses.includes('degraded');
  return {
    status: failed ? 'failed' : (degraded ? 'degraded' : 'ok'),
    ready: !failed,
    components: normalizedComponents,
  };
}
