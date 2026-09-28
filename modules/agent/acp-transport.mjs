import { randomUUID } from 'node:crypto';
import { buildDeepSeekLaunchArgs } from './runtime-args.mjs';
import {
  AsyncEventQueue,
  createBaseCapabilities,
  createTransportEvent,
  unsupportedCapability,
} from './agent-transport.mjs';
import { sniffMimeType } from './attachment-store.mjs';
import { assertPromptBlocksSupported } from './prompt-blocks.mjs';
import {
  DEFER_JSON_RPC_RESPONSE,
  DEFAULT_MAX_FRAME_BYTES,
  NdjsonJsonRpcCodec,
} from './ndjson-json-rpc.mjs';
import { ProcessSupervisor } from './process-supervisor.mjs';

const ACP_PROTOCOL_VERSION = 1;
const ACP_IMAGE_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const ACP_AUDIO_MIME_TYPES = Object.freeze(['audio/mpeg', 'audio/wav', 'audio/ogg']);
const ACP_PROMPT_MAX_BYTES = 8 * 1024 * 1024;
const ACP_PROMPT_MAX_COUNT = 8;
const ACP_PROMPT_MAX_SESSION_BYTES = 64 * 1024 * 1024;

function acpPromptContent(blocks, capabilities) {
  assertPromptBlocksSupported(blocks, capabilities);
  const types = new Set(capabilities?.types || ['text', 'resource_link']);
  return blocks.map((block) => {
    const type = String(block?.type || '');
    if (!types.has(type)) throw unsupportedCapability(`prompt.${type || 'unknown'}`);
    if (type === 'text') {
      if (!String(block.text || '').trim()) throw new TypeError('text prompt blocks cannot be empty');
      return { type: 'text', text: String(block.text) };
    }
    if (type === 'image' || type === 'audio') {
      assertAcpAttachmentBytes(Buffer.from(block.data, 'base64'), block.mimeType, type);
      return { type, data: String(block.data || ''), mimeType: String(block.mimeType || '') };
    }
    if (type === 'embedded_resource') {
      const resource = block.resource || {};
      const bytes = resource.text != null
        ? Buffer.from(resource.text, 'utf8')
        : Buffer.from(resource.blob, 'base64');
      assertAcpAttachmentBytes(bytes, resource.mimeType, 'embedded_resource');
      return {
        type: 'resource',
        resource: resource.text != null
          ? { uri: String(resource.uri || ''), mimeType: String(resource.mimeType || 'text/plain'), text: String(resource.text) }
          : { uri: String(resource.uri || ''), mimeType: String(resource.mimeType || ''), blob: String(resource.blob || '') },
      };
    }
    if (type === 'resource_link') {
      return { type: 'resource_link', uri: String(block.uri || ''), name: String(block.name || block.uri || '') };
    }
    throw unsupportedCapability(`prompt.${type || 'unknown'}`);
  });
}

function assertAcpAttachmentBytes(bytes, declaredMimeType, blockType) {
  const declared = String(declaredMimeType || '').toLowerCase();
  const sniffed = sniffMimeType(bytes);
  if (sniffed !== declared) {
    const error = new Error(`${blockType} declared ${declared || 'no MIME type'} but contains ${sniffed}`);
    error.code = 'attachment_mime_mismatch';
    error.statusCode = 400;
    throw error;
  }
}

export class AcpTransport {
  constructor({
    binary = 'dsh-acp-demo',
    configPath,
    env = {},
    allowedEnvKeys = [],
    supervisor = null,
    spawnImpl,
    requestTimeoutMs = 30_000,
    startTimeoutMs = 60_000,
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    provider = 'deepseek',
    driverVersion = '',
    capabilityEvidence = null,
    onSessionUpdate = () => {},
    onPermissionRequest = null,
    onDiagnostic = () => {},
    onExit = () => {},
  } = {}) {
    if (!configPath) throw new Error('ACP config path is required');
    this.binary = binary;
    this.configPath = configPath;
    this.env = env;
    this.allowedEnvKeys = [...allowedEnvKeys];
    this.supervisor = supervisor || new ProcessSupervisor({ ledgerPath: null, spawnImpl });
    this.requestTimeoutMs = requestTimeoutMs;
    this.startTimeoutMs = startTimeoutMs;
    this.maxFrameBytes = maxFrameBytes;
    this.provider = provider;
    this.driverVersion = driverVersion;
    this.capabilityEvidence = capabilityEvidence ? structuredClone(capabilityEvidence) : null;
    this.onSessionUpdate = onSessionUpdate;
    this.onPermissionRequest = onPermissionRequest;
    this.onDiagnostic = onDiagnostic;
    this.onExit = onExit;
    this.eventQueue = new AsyncEventQueue();
    this.eventHistory = [];
    this.interactions = new Map();
    this.currentTurn = null;
    this.codec = null;
    this.child = null;
    this.instanceId = '';
    this.attemptId = '';
    this.protocolSessionId = '';
    this.lifecycle = 'created';
    this.terminating = false;
    this.exitEmitted = false;
    this.negotiated = this.#capabilities();
  }

  get closed() {
    return ['ended', 'failed'].includes(this.lifecycle) || this.codec?.closed === true;
  }

  get pid() { return this.supervisor.runtime(this.instanceId)?.pid || this.child?.pid || null; }
  get pgid() { return this.supervisor.runtime(this.instanceId)?.containment?.pgid || this.pid; }
  get processStartTime() { return this.supervisor.runtime(this.instanceId)?.processStartTime || null; }

  async start(attemptSpec = {}) {
    if (this.lifecycle !== 'created') throw new Error('ACP transport is already started');
    const cwd = String(attemptSpec.cwd || attemptSpec.workDir || '').trim();
    if (!cwd.startsWith('/')) throw new Error('ACP session cwd must be absolute');
    this.attemptId = String(attemptSpec.attemptId || randomUUID());
    this.instanceId = String(attemptSpec.instanceId || this.attemptId);
    this.lifecycle = 'starting';
    const runtime = await this.supervisor.spawn({
      instanceId: this.instanceId,
      driver: 'deepseek-acp',
      driverVersion: this.driverVersion,
      command: this.binary,
      args: attemptSpec.args || buildDeepSeekLaunchArgs({ configPath: this.configPath }),
      cwd,
      env: attemptSpec.env || this.env,
      allowedEnvKeys: attemptSpec.allowedEnvKeys || this.allowedEnvKeys,
      negotiated: this.negotiated,
      metadata: { attemptId: this.attemptId, provider: this.provider, ...(attemptSpec.metadata || {}) },
    });
    this.child = runtime.child;
    this.child.stdout?.setEncoding?.('utf8');
    this.child.stderr?.setEncoding?.('utf8');
    this.child.stderr?.on('data', (chunk) => this.#diagnostic(String(chunk || ''), 'stderr'));
    this.child.once?.('error', (error) => this.#processExit({ code: error?.code || null, signal: null, error }));
    this.child.once?.('exit', (code, signal) => this.#processExit({ code, signal }));

    this.codec = new NdjsonJsonRpcCodec({
      readable: this.child.stdout,
      writable: this.child.stdin,
      maxFrameBytes: this.maxFrameBytes,
      requestTimeoutMs: this.requestTimeoutMs,
      onRequest: (method, params, message) => this.#inboundRequest(method, params, message),
      onNotification: (method, params) => this.#notification(method, params),
      onDiagnostic: (message) => this.#diagnostic(message, 'protocol'),
    });
    this.codec.once('close', (error) => {
      if (!this.terminating && ['ready', 'working', 'cancelling'].includes(this.lifecycle)) {
        this.lifecycle = 'failed';
        this.#emit('transport.error', { kind: error?.code || 'connection_closed', message: error?.message || 'ACP connection closed' }, 'secret');
        this.supervisor.terminate(this.instanceId, { graceMs: 200 })
          .then((verdict) => this.#emitExit({ code: null, signal: null, error, verdict }))
          .catch((terminateError) => this.#emitExit({ code: null, signal: null, error: terminateError }));
      }
    });

    try {
      const initialized = await this.codec.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'dueno-fleet', version: '0.1.0' },
      }, { timeoutMs: this.startTimeoutMs });
      const result = await this.codec.request('session/new', {
        cwd,
        mcpServers: [],
        additionalDirectories: [],
      }, { timeoutMs: this.startTimeoutMs });
      this.protocolSessionId = String(result?.sessionId || '').trim();
      if (!this.protocolSessionId) throw new Error('ACP server returned no session id');
      this.negotiated = this.#capabilities(initialized);
      this.lifecycle = 'ready';
      this.supervisor.markConnection(this.instanceId, 'open', this.negotiated);
      this.#emit('attempt.started', { protocolSessionId: this.protocolSessionId, negotiated: this.negotiated });
      return { attemptId: this.attemptId, protocolSessionId: this.protocolSessionId, negotiated: this.negotiated };
    } catch (error) {
      this.lifecycle = 'failed';
      this.codec?.close(error);
      await this.supervisor.terminate(this.instanceId, { graceMs: 200 }).catch(() => {});
      throw error;
    }
  }

  async attach() {
    throw unsupportedCapability('sessionOps.attach', 'ACP live-process attachment is not supported');
  }

  async prompt({ turnId = randomUUID(), blocks, idempotencyKey = '' } = {}) {
    if (this.lifecycle !== 'ready') throw new Error(`ACP transport is ${this.lifecycle}`);
    if (this.currentTurn) {
      const error = new Error('ACP transport already has an in-flight turn');
      error.code = 'turn_inflight';
      error.statusCode = 409;
      throw error;
    }
    const prompt = acpPromptContent(blocks, this.negotiated.promptCapabilities);
    const turn = {
      turnId: String(turnId), idempotencyKey: String(idempotencyKey || ''), events: [], text: '', writeCompleted: false,
    };
    this.currentTurn = turn;
    this.lifecycle = 'working';
    this.#emit('turn.started', {
      turnId: turn.turnId,
      idempotencyKey: turn.idempotencyKey,
      phase: 'queued',
      evidence: { accepted: false, settled: false, quiescent: false },
    });
    try {
      const result = await this.codec.request('session/prompt', {
        sessionId: this.protocolSessionId,
        prompt,
      }, {
        timeoutMs: 0,
        onWritten: () => {
          turn.writeCompleted = true;
          this.#emit('turn.started', {
            turnId: turn.turnId,
            idempotencyKey: turn.idempotencyKey,
            phase: 'admitted',
            evidence: { accepted: true, settled: false, quiescent: false },
          });
          this.#emit('turn.started', {
            turnId: turn.turnId,
            idempotencyKey: turn.idempotencyKey,
            phase: 'inflight',
            evidence: { accepted: true, settled: false, quiescent: false },
          });
        },
      });
      if (turn.text) this.#emit('message.committed', { turnId: turn.turnId, blocks: [{ type: 'text', text: turn.text }] });
      const stopReason = result?.stopReason || 'end_turn';
      this.#emit('turn.settled', {
        turnId: turn.turnId,
        stopReason,
        evidence: { accepted: true, settled: true, quiescent: true },
      });
      return { stopReason, events: [...turn.events] };
    } catch (error) {
      const remotelySettled = error?.responseReceived === true;
      this.#emit('turn.settled', {
        turnId: turn.turnId,
        error: { code: error?.code || 'transport_error', message: error?.message || String(error) },
        evidence: {
          accepted: turn.writeCompleted || remotelySettled,
          settled: remotelySettled,
          quiescent: remotelySettled,
        },
      });
      throw error;
    } finally {
      if (this.currentTurn === turn) this.currentTurn = null;
      if (!this.terminating && this.lifecycle !== 'ended' && !this.closed) this.lifecycle = 'ready';
    }
  }

  async cancel({ turnId } = {}) {
    if (!this.protocolSessionId || !this.codec || this.codec.closed) return { mode: 'best_effort' };
    if (turnId && this.currentTurn && String(turnId) !== this.currentTurn.turnId) {
      const error = new Error(`Turn is not active: ${turnId}`);
      error.code = 'turn_not_active';
      throw error;
    }
    await this.codec.notify('session/cancel', { sessionId: this.protocolSessionId });
    this.lifecycle = this.currentTurn ? 'cancelling' : 'ready';
    return { mode: 'best_effort', settledTurnId: undefined };
  }

  async answerInteraction({ interactionId, optionId, text } = {}) {
    const id = String(interactionId || '');
    const entry = this.interactions.get(id);
    if (!entry || entry.answered) {
      const error = new Error('Interaction is missing or already answered');
      error.code = 'interaction_not_open';
      error.statusCode = 409;
      throw error;
    }
    const first = this.interactions.values().next().value;
    if (first !== entry) {
      const error = new Error('Interactions must be answered in request order');
      error.code = 'interaction_out_of_order';
      error.statusCode = 409;
      throw error;
    }
    const selected = String(optionId || '').trim();
    if (selected && !entry.options.some((option) => String(option.optionId) === selected)) {
      const error = new Error(`Unknown interaction option: ${selected}`);
      error.code = 'interaction_option_invalid';
      error.statusCode = 409;
      throw error;
    }
    const outcome = selected ? { outcome: 'selected', optionId: selected } : { outcome: 'selected', text: String(text || '') };
    await this.codec.respond(entry.requestId, { outcome });
    entry.answered = true;
    this.interactions.delete(id);
    this.#emit('interaction.answered', { interactionId: id, optionId: selected || undefined, text: selected ? undefined : String(text || '') }, 'secret');
    return { ok: true, interactionId: id };
  }

  events() { return this.eventQueue; }

  snapshot() {
    return Object.freeze({
      attemptId: this.attemptId,
      protocolSessionId: this.protocolSessionId || undefined,
      lifecycle: this.lifecycle,
      currentTurnId: this.currentTurn?.turnId || null,
      openInteractions: [...this.interactions.values()].map((entry) => ({ interactionId: entry.interactionId, options: structuredClone(entry.options) })),
      runtime: this.supervisor.runtime(this.instanceId),
      negotiated: this.negotiated,
    });
  }

  async terminate({ grace = 500 } = {}) {
    if (!this.instanceId) return { ok: true, status: 'already_gone', residual: [] };
    this.terminating = true;
    // Graceful writes are bounded by the grace period: a child that stops reading
    // stdin (or a hung earlier write) must never block the kill below.
    let timer;
    await Promise.race([(async () => {
      for (const entry of [...this.interactions.values()]) {
        try {
          await this.codec?.respond(entry.requestId, { outcome: { outcome: 'cancelled' } });
          this.#emit('interaction.cancelled', { interactionId: entry.interactionId }, 'secret');
        } catch {
          // Termination still proceeds; transport failure is reflected by verdict.
        }
      }
      if (this.currentTurn && this.codec && !this.codec.closed) {
        await this.codec.notify('session/cancel', { sessionId: this.protocolSessionId }).catch(() => {});
      }
    })(), new Promise((resolve) => { timer = setTimeout(resolve, Number(grace) || 0); })]);
    clearTimeout(timer);
    this.interactions.clear();
    try { this.child?.stdin?.end?.(); } catch { /* ignored */ }
    const verdict = await this.supervisor.terminate(this.instanceId, { graceMs: Number(grace) || 0 });
    this.codec?.close(new Error('ACP transport terminated'));
    this.lifecycle = verdict.ok ? 'ended' : 'failed';
    this.#emitExit({ code: null, signal: null, verdict });
    this.eventQueue.close();
    return verdict;
  }

  capabilities() { return this.negotiated; }

  request(method, params, options) {
    if (!this.codec) return Promise.reject(new Error('ACP transport is not started'));
    return this.codec.request(method, params, options);
  }

  async cancelInteraction(interactionId) {
    const entry = this.interactions.get(String(interactionId));
    if (!entry) return false;
    await this.codec.respond(entry.requestId, { outcome: { outcome: 'cancelled' } });
    this.interactions.delete(entry.interactionId);
    this.#emit('interaction.cancelled', { interactionId: entry.interactionId }, 'secret');
    return true;
  }

  async cancelAllInteractions() {
    for (const id of [...this.interactions.keys()]) await this.cancelInteraction(id).catch(() => {});
  }

  #capabilities(initializeResult = {}) {
    const advertised = initializeResult?.agentCapabilities?.promptCapabilities || {};
    // ACP requires every agent to support resource links; image, audio, and
    // embedded resources are the capability-gated additions.
    const types = ['text', 'resource_link'];
    const mimeAllowlist = [];
    if (advertised.image === true) {
      types.push('image');
      mimeAllowlist.push(...ACP_IMAGE_MIME_TYPES);
    }
    if (advertised.audio === true) {
      types.push('audio');
      mimeAllowlist.push(...ACP_AUDIO_MIME_TYPES);
    }
    if (advertised.embeddedContext === true) {
      types.push('embedded_resource');
      mimeAllowlist.push('application/pdf', 'application/json', 'text/plain');
    }
    const hasBinaryPromptType = types.some((type) => !['text', 'resource_link'].includes(type));
    return createBaseCapabilities({
      protocol: { name: 'acp', version: String(initializeResult?.protocolVersion || ACP_PROTOCOL_VERSION) },
      delivery: 'structured',
      cancellation: 'best_effort',
      interaction: { permissions: 'structured_options', elicitation: false, answerOnce: true },
      streaming: 'committed_messages',
      streamFeatures: { tool_events: false, thought_events: false, plan: false, usage: false },
      transcript: 'committed_text',
      recovery: { processSurvivesFleetRestart: false, fleetRecoverable: 'none' },
      ...(this.capabilityEvidence ? {
        mcpAttachment: this.capabilityEvidence.mcpAttachment,
        mcpFeatures: this.capabilityEvidence.mcpFeatures,
        busParticipation: this.capabilityEvidence.busParticipation,
        collaborationE2eProven: this.capabilityEvidence.collaborationE2eProven === true,
      } : {}),
      identity: 'connection_bound',
      promptCapabilities: {
        types,
        deliveryMode: 'inline',
        mimeAllowlist,
        maxBytes: hasBinaryPromptType ? ACP_PROMPT_MAX_BYTES : 0,
        maxCount: hasBinaryPromptType ? ACP_PROMPT_MAX_COUNT : 0,
        maxSessionBytes: hasBinaryPromptType ? ACP_PROMPT_MAX_SESSION_BYTES : 0,
      },
      runtimeSharing: 'exclusive',
    });
  }

  #emit(type, payload = {}, redactionClass = 'internal') {
    const event = createTransportEvent(type, payload, {
      attemptId: this.attemptId,
      provider: this.provider,
      transport: 'acp',
      redactionClass,
    });
    this.eventHistory.push(event);
    if (this.eventHistory.length > 1000) this.eventHistory.splice(0, this.eventHistory.length - 1000);
    if (this.currentTurn) this.currentTurn.events.push(event);
    this.eventQueue.push(event);
    return event;
  }

  #notification(method, params) {
    if (method !== 'session/update') {
      this.#diagnostic(`Unknown ACP notification: ${method}`, 'protocol');
      return;
    }
    this.onSessionUpdate(params || {});
    const update = params?.update || {};
    const turnId = this.currentTurn?.turnId || '';
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      const delta = String(update.content.text || '');
      if (!delta) return;
      if (this.currentTurn) this.currentTurn.text += delta;
      this.#emit('message.delta', { turnId, delta: { type: 'text', text: delta } });
      return;
    }
    this.#emit('diagnostic', { kind: 'unknown_session_update', update }, 'secret');
  }

  #inboundRequest(method, params, message) {
    if (method !== 'session/request_permission') return undefined;
    const interactionId = `${this.attemptId}:${String(message.id)}`;
    const entry = {
      interactionId,
      requestId: message.id,
      kind: 'permission',
      options: Array.isArray(params?.options) ? structuredClone(params.options) : [],
      toolCall: structuredClone(params?.toolCall || {}),
      answered: false,
    };
    this.interactions.set(interactionId, entry);
    this.#emit('interaction.requested', {
      interactionId,
      kind: 'permission',
      options: entry.options,
      toolCall: entry.toolCall,
      turnId: this.currentTurn?.turnId || '',
    }, 'secret');
    if (typeof this.onPermissionRequest === 'function') this.onPermissionRequest({ requestId: message.id, ...params, interactionId });
    return DEFER_JSON_RPC_RESPONSE;
  }

  #diagnostic(message, source) {
    const value = String(message || '');
    if (!value) return;
    this.onDiagnostic(value.endsWith('\n') ? value : `${value}\n`);
    this.#emit('diagnostic', { kind: source, message: value }, 'secret');
  }

  #processExit({ code, signal, error = null }) {
    if (this.lifecycle !== 'ended') this.lifecycle = error ? 'failed' : 'ended';
    this.codec?.close(error || new Error(`ACP process exited${signal ? ` on ${signal}` : ` with code ${code}`}`));
    this.#emitExit({ code, signal, error });
  }

  #emitExit(info) {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.#emit('attempt.exited', {
      code: info.code ?? null,
      signal: info.signal ?? null,
      error: info.error?.message || undefined,
      verdict: info.verdict,
    });
    this.onExit(info);
    this.eventQueue.close();
  }
}
