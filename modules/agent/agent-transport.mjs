import { randomUUID } from 'node:crypto';

export const TRANSPORT_EVENT_TYPES = Object.freeze([
  'turn.started', 'turn.settled', 'message.delta', 'message.committed',
  'thought.delta', 'tool.call', 'tool.update', 'plan.update',
  'interaction.requested', 'interaction.answered', 'interaction.cancelled',
  'mode.changed', 'usage', 'diagnostic', 'attempt.started', 'attempt.exited',
  'transport.error',
]);

export function unsupportedCapability(capability, detail = '') {
  const error = new Error(detail || `Unsupported capability: ${capability}`);
  error.code = 'unsupported_capability';
  error.statusCode = 400;
  error.capability = capability;
  return error;
}

export function createTransportEvent(type, payload = {}, {
  attemptId = '',
  provider = '',
  transport = '',
  schemaVersion = 1,
  redactionClass = 'internal',
  now = Date.now,
} = {}) {
  if (!TRANSPORT_EVENT_TYPES.includes(type)) throw new TypeError(`Unknown TransportEvent type: ${type}`);
  return Object.freeze({
    schemaVersion,
    eventId: randomUUID(),
    type,
    observedAt: now(),
    provenance: { attemptId, provider, transport },
    redactionClass,
    ...structuredClone(payload || {}),
  });
}

export class AsyncEventQueue {
  constructor() {
    this.values = [];
    this.waiters = [];
    this.closed = false;
  }

  push(value) {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  next() {
    if (this.values.length) return Promise.resolve({ value: this.values.shift(), done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

export function createBaseCapabilities(overrides = {}) {
  const values = structuredClone(overrides);
  const promptCapabilities = values.promptCapabilities || values.attachments || {
    types: ['text', 'resource_link'], deliveryMode: 'inline', mimeAllowlist: [],
    maxBytes: 0, maxCount: 0, maxSessionBytes: 0,
  };
  return Object.freeze({
    schemaVersion: 1,
    protocol: { name: 'unknown', version: '' },
    delivery: 'structured',
    turn: { admission: 'single', steer: false, followup: false },
    cancellation: 'none',
    interaction: { permissions: 'none', elicitation: false, answerOnce: true },
    streaming: 'committed_messages',
    streamFeatures: { tool_events: false, thought_events: false, plan: false, usage: false },
    transcript: 'committed_text',
    sessionOps: {
      list: 'unsupported', load: 'unsupported', resume: 'unsupported', fork: 'unsupported',
      close: 'unsupported', delete: 'supported',
    },
    recovery: { processSurvivesFleetRestart: false, fleetRecoverable: 'none' },
    mcpAttachment: 'none',
    mcpFeatures: { tools: false, resources: false, prompts: false },
    identity: 'none',
    busParticipation: 'none',
    promptCapabilities: structuredClone(promptCapabilities),
    // Compatibility alias for pre-P2A descriptor consumers.
    attachments: structuredClone(promptCapabilities),
    runtimeSharing: 'exclusive',
    ...values,
    promptCapabilities: structuredClone(promptCapabilities),
    attachments: structuredClone(promptCapabilities),
  });
}

export function assertAgentTransport(transport) {
  const methods = [
    'start', 'attach', 'prompt', 'cancel', 'answerInteraction', 'events',
    'snapshot', 'terminate', 'capabilities',
  ];
  for (const method of methods) {
    if (typeof transport?.[method] !== 'function') throw new TypeError(`AgentTransport.${method}() is required`);
  }
  return transport;
}
