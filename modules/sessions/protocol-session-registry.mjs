const bindings = new Map();

export function registerProtocolSessionProvider(provider, binding) {
  const key = String(provider || '').trim();
  if (!key) throw new TypeError('provider is required');
  if (!binding?.service) throw new TypeError('protocol session service binding is required');
  bindings.set(key, binding);
  return () => {
    if (bindings.get(key) === binding) bindings.delete(key);
  };
}

export function getProtocolSessionProvider(provider) {
  return bindings.get(String(provider || '').trim()) || null;
}

