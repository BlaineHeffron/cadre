export function createKeyedSingleFlight(operation) {
  const inFlight = new Map();

  return function run(key, ...args) {
    const existing = inFlight.get(key);
    if (existing) return existing;

    const pending = Promise.resolve().then(() => operation(key, ...args));
    inFlight.set(key, pending);
    pending.finally(() => {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    }).catch(() => {});
    return pending;
  };
}
