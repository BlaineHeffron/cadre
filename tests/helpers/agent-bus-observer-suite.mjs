import { setTimeout as delay } from 'node:timers/promises';
import { createAgentBusHarness } from './agent-bus-test-harness.mjs';

export const OBSERVER_SETTLE_MS = 500;
export const OBSERVER_WAIT_TIMEOUT_MS = 2500;

export async function waitFor(assertion, { timeoutMs = OBSERVER_WAIT_TIMEOUT_MS, intervalMs = 50 } = {}) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
      return await Promise.race([
        assertion(),
        delay(remainingMs).then(() => {
          throw new Error(`Condition not met within ${timeoutMs}ms`);
        }),
      ]);
    } catch (error) {
      lastError = error;
      await delay(intervalMs);
    }
  }
  throw lastError || new Error(`Condition not met within ${timeoutMs}ms`);
}

export function createObserverHarness() {
  return createAgentBusHarness({
    ackTimeoutMs: 200,
    replyTimeoutMs: 260,
  });
}
