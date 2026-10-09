import { randomUUID } from 'node:crypto';
import {
  AsyncEventQueue,
  createBaseCapabilities,
  createTransportEvent,
  questionInteraction,
} from './agent-transport.mjs';
import { CLAUDE_FLEET_PLUGIN_DIR } from './hook-events.mjs';
import { mapPromptBlocksForClaude } from './prompt-blocks.mjs';
import { ProcessSupervisor } from './process-supervisor.mjs';

const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const CLAUDE_STREAM_JSON_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'CLAUDE_CODE_OAUTH_TOKEN',
  'DUENO_AGENT_BUS_TOKEN', 'DUENO_SESSION_ID', 'DUENO_PROVIDER', 'DUENO_SESSION_WORK_DIR',
]);

export function buildClaudeStreamJsonArgs({
  sessionId, resume = false, model = '', thinkingLevel = '', permissionMode = '', mcpConfigPath = '', promptArgs = [],
} = {}) {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    // Claude rejects --session-id with --resume; a resumed conversation keeps its id.
    '--include-partial-messages', '--verbose', resume ? '--resume' : '--session-id', String(sessionId),
    '--permission-prompt-tool', 'stdio',
  ];
  if (model) args.push('--model', String(model));
  if (thinkingLevel) args.push('--effort', String(thinkingLevel));
  if (permissionMode === 'danger-full-access') args.push('--dangerously-skip-permissions');
  else if (permissionMode === 'read-only' || permissionMode === 'plan') args.push('--permission-mode', 'plan');
  else if (permissionMode === 'workspace-write') args.push('--permission-mode', 'acceptEdits');
  else if (permissionMode) throw Object.assign(new Error(`Unsupported Claude permission mode: ${permissionMode}`), { code: 'unsupported_permission_mode' });
  if (mcpConfigPath) args.push('--mcp-config', String(mcpConfigPath), '--strict-mcp-config');
  args.push('--plugin-dir', CLAUDE_FLEET_PLUGIN_DIR);
  args.push(...promptArgs.map(String));
  return args;
}

function usagePayload(value = {}) {
  const usage = value.usage || value;
  return {
    inputTokens: Number(usage.input_tokens || usage.inputTokens || 0),
    outputTokens: Number(usage.output_tokens || usage.outputTokens || 0),
    cacheReadTokens: Number(usage.cache_read_input_tokens || usage.cacheReadInputTokens || 0),
    cacheWriteTokens: Number(usage.cache_creation_input_tokens || usage.cacheWriteInputTokens || 0),
    costUsd: Number(value.total_cost_usd || value.costUsd || 0),
  };
}

export class ClaudeStreamJsonTransport {
  constructor({
    binary = 'claude', env = process.env, allowedEnvKeys = CLAUDE_STREAM_JSON_ENV_ALLOWLIST,
    supervisor = null, spawnImpl, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    provider = 'claude', driverVersion = '', capabilityEvidence = null,
  } = {}) {
    this.binary = binary;
    this.env = env;
    this.allowedEnvKeys = [...allowedEnvKeys];
    this.supervisor = supervisor || new ProcessSupervisor({ ledgerPath: null, spawnImpl });
    this.maxFrameBytes = maxFrameBytes;
    this.provider = provider;
    this.driverVersion = driverVersion;
    this.eventQueue = new AsyncEventQueue();
    this.eventHistory = [];
    this.toolCalls = new Set();
    this.toolCallByIndex = new Map();
    this.interactions = new Map();
    this.buffer = '';
    this.attemptId = '';
    this.instanceId = '';
    this.protocolSessionId = '';
    this.lifecycle = 'created';
    this.currentTurn = null;
    this.child = null;
    this.terminating = false;
    this.exitEmitted = false;
    this.negotiated = createBaseCapabilities({
      protocol: { name: 'claude-stream-json', version: '1' },
      delivery: 'structured',
      cancellation: 'best_effort',
      interaction: { permissions: 'structured_options', elicitation: false, answerOnce: true },
      streaming: 'deltas_and_committed_messages',
      streamFeatures: { tool_events: true, thought_events: true, plan: false, usage: true },
      transcript: 'committed_text',
      sessionOps: {
        list: 'unsupported', load: 'unsupported', resume: 'supported', fork: 'unsupported', close: 'unsupported', delete: 'supported',
      },
      recovery: { processSurvivesFleetRestart: false, fleetRecoverable: 'provider_session' },
      identity: 'connection_bound',
      promptCapabilities: {
        types: ['text', 'image'], deliveryMode: 'inline',
        mimeAllowlist: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        maxBytes: 8 * 1024 * 1024, maxCount: 8, maxSessionBytes: 64 * 1024 * 1024,
      },
      runtimeSharing: 'exclusive',
      ...(capabilityEvidence || {}),
    });
  }

  get closed() { return ['ended', 'failed'].includes(this.lifecycle); }

  async start(spec = {}) {
    if (this.lifecycle !== 'created') throw new Error('Claude stream-json transport is already started');
    const cwd = String(spec.cwd || spec.workDir || '').trim();
    if (!cwd.startsWith('/')) throw new Error('Claude stream-json cwd must be absolute');
    this.attemptId = String(spec.attemptId || randomUUID());
    this.instanceId = String(spec.instanceId || this.attemptId);
    // Claude Code rejects --session-id values that are not UUIDs; Fleet session ids are 16 hex chars.
    this.protocolSessionId = String(spec.protocolSessionId || randomUUID());
    this.lifecycle = 'starting';
    let runtime;
    try {
      runtime = await this.supervisor.spawn({
        instanceId: this.instanceId,
        driver: 'claude-stream-json',
        driverVersion: this.driverVersion,
        command: this.binary,
        args: spec.args || buildClaudeStreamJsonArgs({
          sessionId: this.protocolSessionId, resume: spec.resume, model: spec.model, thinkingLevel: spec.thinkingLevel, permissionMode: spec.permissionMode,
          mcpConfigPath: spec.mcpConfigPath, promptArgs: spec.promptArgs,
        }),
        cwd,
        env: spec.env || this.env,
        allowedEnvKeys: spec.allowedEnvKeys || this.allowedEnvKeys,
        negotiated: this.negotiated,
        metadata: { attemptId: this.attemptId, provider: this.provider, ...(spec.metadata || {}) },
      });
    } catch (error) {
      this.lifecycle = 'failed';
      this.eventQueue.close();
      throw error;
    }
    this.child = runtime.child;
    this.child.stdout?.setEncoding?.('utf8');
    this.child.stderr?.setEncoding?.('utf8');
    this.child.stdout?.on('data', (chunk) => this.#read(String(chunk || '')));
    this.child.stderr?.on('data', (chunk) => this.#emit('diagnostic', { kind: 'stderr', message: String(chunk || '') }, 'secret'));
    this.child.once?.('error', (error) => this.#exit({ code: error?.code || null, signal: null, error }));
    this.child.once?.('exit', (code, signal) => this.#exit({ code, signal }));
    this.lifecycle = 'ready';
    this.#emit('attempt.started', { protocolSessionId: this.protocolSessionId, negotiated: this.negotiated });
    return { attemptId: this.attemptId, protocolSessionId: this.protocolSessionId, negotiated: this.negotiated };
  }

  // Resumes a stored conversation in a new process; live-process attachment is not supported.
  async attach(spec = {}) {
    if (!spec.protocolSessionId) throw new TypeError('Claude session id required for resume');
    return this.start({ ...spec, resume: true });
  }

  async prompt({ turnId = randomUUID(), blocks, idempotencyKey = '' } = {}) {
    if (this.lifecycle !== 'ready') throw new Error(`Claude stream-json transport is ${this.lifecycle}`);
    if (this.currentTurn) {
      const error = new Error('Claude stream-json transport already has an in-flight turn');
      error.code = 'turn_inflight';
      error.statusCode = 409;
      throw error;
    }
    const content = mapPromptBlocksForClaude(blocks);
    const turn = { turnId: String(turnId), idempotencyKey: String(idempotencyKey), events: [], text: '', accepted: false };
    this.currentTurn = turn;
    this.lifecycle = 'working';
    this.#emitStarted(turn, 'queued', false);
    const settled = new Promise((resolve, reject) => Object.assign(turn, { resolve, reject }));
    const frame = `${JSON.stringify({
      type: 'user', session_id: this.protocolSessionId,
      message: { role: 'user', content }, parent_tool_use_id: null,
    })}\n`;
    try {
      this.child.stdin.write(frame, (error) => {
        if (error) {
          this.#settleError(error);
          return;
        }
        turn.accepted = true;
        this.#emitStarted(turn, 'admitted', true);
        this.#emitStarted(turn, 'inflight', true);
      });
    } catch (error) { this.#settleError(error); }
    return settled;
  }

  async cancel({ turnId } = {}) {
    if (turnId && this.currentTurn && String(turnId) !== this.currentTurn.turnId) {
      const error = new Error(`Turn is not active: ${turnId}`);
      error.code = 'turn_not_active';
      throw error;
    }
    const frame = `${JSON.stringify({
      type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' },
    })}\n`;
    try {
      await new Promise((resolve, reject) => this.child.stdin.write(frame, (error) => error ? reject(error) : resolve()));
      this.lifecycle = this.currentTurn ? 'cancelling' : 'ready';
      return { mode: 'best_effort', settledTurnId: undefined };
    } catch {
      await this.terminate({ grace: 200 });
      return { mode: 'destructive', settledTurnId: undefined };
    }
  }

  async answerInteraction({ interactionId, optionId, text } = {}) {
    const entry = this.interactions.get(String(interactionId || ''));
    if (!entry) {
      const error = new Error('Interaction is missing or already answered');
      error.code = 'interaction_not_open'; error.statusCode = 409; throw error;
    }
    const answer = String(text || optionId || '');
    if (entry.question ? !answer : !entry.options.includes(optionId)) {
      const error = new Error(`Unknown permission option: ${optionId || '(empty)'}`);
      error.code = 'invalid_interaction_option'; error.statusCode = 400; throw error;
    }
    // AskUserQuestion answers are keyed by question text; allow-for-session re-scopes
    // the CLI's permission_suggestions. Both mappings follow t3code's ClaudeAdapter (MIT).
    if (entry.question) entry.pending.answers[entry.question] = answer;
    const response = entry.question
      ? { behavior: 'allow', updatedInput: { ...entry.input, answers: entry.pending.answers }, toolUseID: entry.toolUseId }
      : optionId === 'deny'
        ? { behavior: 'deny', message: 'Operator denied this tool request', toolUseID: entry.toolUseId }
        : { behavior: 'allow', updatedInput: entry.input, toolUseID: entry.toolUseId,
          ...(optionId === 'allow_session' ? { updatedPermissions: entry.suggestions.map((item) => ({ ...item, destination: 'session' })) } : {}) };
    if (!entry.question || entry.pending.remaining === 1) {
      await this.#write({
        type: 'control_response',
        response: { subtype: 'success', request_id: entry.requestId, response },
      });
    }
    if (entry.question) entry.pending.remaining -= 1;
    this.interactions.delete(entry.interactionId);
    if (this.currentTurn && !this.interactions.size) this.lifecycle = 'working';
    this.#emit('interaction.answered', { interactionId: entry.interactionId, optionId });
    return { ok: true };
  }

  events() { return this.eventQueue; }

  snapshot() {
    return Object.freeze({
      attemptId: this.attemptId,
      protocolSessionId: this.protocolSessionId || undefined,
      lifecycle: this.lifecycle,
      currentTurnId: this.currentTurn?.turnId || null,
      openInteractions: [...this.interactions.keys()],
      runtime: this.supervisor.runtime(this.instanceId),
      negotiated: this.negotiated,
    });
  }

  async terminate({ grace = 500 } = {}) {
    if (!this.instanceId) return { ok: true, status: 'already_gone', residual: [] };
    this.terminating = true;
    this.#cancelInteractions('attempt_terminated');
    try { this.child?.stdin?.end?.(); } catch { /* ignored */ }
    const verdict = await this.supervisor.terminate(this.instanceId, { graceMs: Number(grace) || 0 });
    if (this.currentTurn) this.#settleError(new Error('Claude stream-json transport terminated'));
    this.lifecycle = verdict.ok ? 'ended' : 'failed';
    this.#emitExit({ code: null, signal: null, verdict });
    this.eventQueue.close();
    return verdict;
  }

  capabilities() { return this.negotiated; }

  #emitStarted(turn, phase, accepted) {
    this.#emit('turn.started', {
      turnId: turn.turnId, idempotencyKey: turn.idempotencyKey, phase,
      evidence: { accepted, settled: false, quiescent: false },
    });
  }

  #emit(type, payload = {}, redactionClass = 'internal') {
    const event = createTransportEvent(type, payload, {
      attemptId: this.attemptId, provider: this.provider,
      transport: 'claude-stream-json', redactionClass,
    });
    this.eventHistory.push(event);
    if (this.eventHistory.length > 1000) this.eventHistory.splice(0, this.eventHistory.length - 1000);
    if (this.currentTurn) this.currentTurn.events.push(event);
    this.eventQueue.push(event);
    return event;
  }

  async #write(message) {
    const frame = `${JSON.stringify(message)}\n`;
    await new Promise((resolve, reject) => this.child.stdin.write(frame, (error) => error ? reject(error) : resolve()));
  }

  #read(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes && !this.buffer.includes('\n')) {
      this.#protocolError(Object.assign(new Error('Claude stream-json frame exceeds limit'), { code: 'frame_oversize' }));
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > this.maxFrameBytes) {
        this.#protocolError(Object.assign(new Error('Claude stream-json frame exceeds limit'), { code: 'frame_oversize' }));
        return;
      }
      try { this.#message(JSON.parse(line)); } catch (cause) {
        this.#protocolError(Object.assign(new Error('Malformed Claude stream-json frame', { cause }), { code: 'malformed_frame' }));
        return;
      }
    }
  }

  #message(message) {
    const turnId = this.currentTurn?.turnId || '';
    if (message.session_id) this.protocolSessionId = String(message.session_id);
    if (message.type === 'control_request' && message.request?.subtype === 'can_use_tool') {
      const requestId = String(message.request_id || '');
      if (!requestId || this.interactions.has(`${this.attemptId}:${requestId}`)) return;
      const interactionId = `${this.attemptId}:${requestId}`;
      const request = message.request;
      const base = { requestId, toolUseId: String(request.tool_use_id || ''), input: structuredClone(request.input || {}) };
      const questions = request.tool_name === 'AskUserQuestion' ? base.input.questions || [] : [];
      this.lifecycle = 'blocked';
      if (questions.length) {
        const pending = { answers: {}, remaining: questions.length };
        questions.forEach((question, index) => {
          const id = index ? `${interactionId}:${index}` : interactionId;
          this.interactions.set(id, { ...base, interactionId: id, question: String(question.question || ''), pending });
          const { kind, options, toolCall } = questionInteraction(question);
          this.#emit('interaction.requested', {
            interactionId: id, turnId, kind, options, toolCall: { ...toolCall, toolCallId: base.toolUseId, name: request.tool_name },
          }, 'secret');
        });
        return;
      }
      // Session grants forward only rule suggestions; setMode/addDirectories would silently widen the session.
      const suggestions = (request.permission_suggestions || []).filter((item) => /Rules$/.test(item?.type));
      const options = [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        ...(suggestions.length ? [{ optionId: 'allow_session', name: 'Allow for session', kind: 'allow_always' }] : []),
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ];
      this.interactions.set(interactionId, { ...base, interactionId, suggestions, options: options.map((option) => option.optionId) });
      this.#emit('interaction.requested', {
        interactionId, turnId, kind: 'permission', options,
        toolCall: {
          toolCallId: base.toolUseId, name: request.tool_name,
          title: request.title || request.display_name || `${request.tool_name} requires permission`,
          description: request.description || request.decision_reason || '', input: base.input,
        },
      }, 'secret');
      return;
    }
    if (message.type === 'control_request') {
      // Cadre does not host MCP elicitation forms: decline so the CLI does not hang.
      const elicitation = message.request?.subtype === 'elicitation';
      void this.#write({ type: 'control_response', response: elicitation
        ? { subtype: 'success', request_id: message.request_id, response: { action: 'decline' } }
        : { subtype: 'error', request_id: message.request_id, error: `Unsupported control request: ${message.request?.subtype}` } }).catch(() => {});
      return;
    }
    if (message.type === 'control_cancel_request') {
      for (const [interactionId, entry] of this.interactions) {
        if (entry.requestId !== String(message.request_id || '')) continue;
        this.interactions.delete(interactionId);
        this.#emit('interaction.cancelled', { interactionId, reason: 'provider_cancelled' });
      }
      return;
    }
    if (message.type === 'stream_event') {
      const event = message.event || {};
      const block = event.content_block || {};
      const delta = event.delta || {};
      if (event.type === 'content_block_start' && block.type === 'tool_use') {
        this.toolCalls.add(String(block.id));
        this.toolCallByIndex.set(String(event.index ?? ''), String(block.id));
        this.#emit('tool.call', { turnId, toolCallId: block.id, name: block.name, input: block.input || {} }, 'secret');
      } else if (event.type === 'content_block_delta' && delta.type === 'text_delta') {
        if (this.currentTurn) this.currentTurn.text += String(delta.text || '');
        this.#emit('message.delta', { turnId, delta: { type: 'text', text: String(delta.text || '') } });
      } else if (event.type === 'content_block_delta' && delta.type === 'thinking_delta') {
        this.#emit('thought.delta', { turnId, delta: { type: 'text', text: String(delta.thinking || '') } }, 'secret');
      } else if (event.type === 'content_block_delta' && delta.type === 'input_json_delta') {
        this.#emit('tool.update', {
          turnId, toolCallId: this.toolCallByIndex.get(String(event.index ?? '')),
          status: 'input_delta', delta: String(delta.partial_json || ''),
        }, 'secret');
      }
      if (event.usage || event.type === 'message_start' || event.type === 'message_delta') {
        this.#emit('usage', { turnId, ...usagePayload(event.message || event) });
      }
      return;
    }
    if (message.type === 'assistant') {
      const content = Array.isArray(message.message?.content) ? message.message.content : [];
      const blocks = content.filter((block) => block?.type === 'text').map((block) => ({ type: 'text', text: String(block.text || '') }));
      if (blocks.length) this.#emit('message.committed', { turnId, blocks });
      for (const block of content.filter((entry) => entry?.type === 'tool_use')) {
        if (this.toolCalls.has(String(block.id))) continue;
        this.toolCalls.add(String(block.id));
        this.#emit('tool.call', { turnId, toolCallId: block.id, name: block.name, input: block.input || {} }, 'secret');
      }
      if (message.message?.usage) this.#emit('usage', { turnId, ...usagePayload(message.message) });
      return;
    }
    if (message.type === 'user') {
      for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
        if (block?.type === 'tool_result') {
          this.#emit('tool.update', {
            turnId, toolCallId: block.tool_use_id, status: block.is_error ? 'failed' : 'completed',
          }, 'secret');
        }
      }
      return;
    }
    if (message.type === 'result') {
      if (message.usage || message.total_cost_usd != null) this.#emit('usage', { turnId, ...usagePayload(message) });
      if (message.is_error) {
        this.#settleError(Object.assign(new Error(String(message.result || message.subtype || 'Claude turn failed')), { code: message.subtype || 'claude_error' }), true);
      } else this.#settle(message.subtype || 'end_turn');
      return;
    }
    if (message.type === 'system') {
      this.#emit('diagnostic', {
        kind: message.subtype === 'init' ? 'claude_init' : 'claude_system',
        model: message.model || undefined,
      });
      return;
    }
    if (message.type === 'tool_progress' || message.type === 'tool_use_summary') {
      this.#emit('tool.update', { turnId, toolCallId: message.tool_use_id, status: message.type, detail: message.summary || message.content || '' }, 'secret');
      return;
    }
    this.#emit('diagnostic', { kind: 'unknown_stream_event', eventType: String(message.type || '') }, 'secret');
  }

  #settle(stopReason) {
    const turn = this.currentTurn;
    if (!turn) return;
    const event = this.#emit('turn.settled', {
      turnId: turn.turnId, stopReason,
      evidence: { accepted: true, settled: true, quiescent: true },
    });
    this.currentTurn = null;
    this.toolCalls.clear();
    this.toolCallByIndex.clear();
    this.#cancelInteractions('turn_settled');
    this.lifecycle = 'ready';
    turn.resolve({ stopReason, evidence: event.evidence, events: [...turn.events] });
  }

  #settleError(error, remotelySettled = false) {
    const turn = this.currentTurn;
    if (!turn) {
      this.#emit('transport.error', { kind: error.code || 'transport_error', message: error.message }, 'secret');
      return;
    }
    const event = this.#emit('turn.settled', {
      turnId: turn.turnId,
      error: { code: error.code || 'transport_error', message: error.message },
      evidence: { accepted: turn.accepted || remotelySettled, settled: remotelySettled, quiescent: remotelySettled },
    }, 'secret');
    this.currentTurn = null;
    this.toolCalls.clear();
    this.toolCallByIndex.clear();
    this.#cancelInteractions('turn_failed');
    this.lifecycle = remotelySettled ? 'ready' : 'failed';
    error.responseReceived = remotelySettled;
    turn.reject(error);
    if (!remotelySettled) this.#emit('transport.error', { kind: error.code || 'transport_error', message: error.message }, 'secret');
    return event;
  }

  #protocolError(error) {
    this.buffer = '';
    this.#settleError(error);
    void this.terminate({ grace: 200 }).catch(() => {});
  }

  #cancelInteractions(reason) {
    for (const interactionId of this.interactions.keys()) {
      this.#emit('interaction.cancelled', { interactionId, reason });
    }
    this.interactions.clear();
  }

  #exit({ code, signal, error = null } = {}) {
    if (this.exitEmitted) return;
    if (this.buffer.trim()) {
      this.#settleError(Object.assign(new Error('Claude stream-json ended with an incomplete frame'), { code: 'frame_no_newline' }));
      this.buffer = '';
    }
    if (this.currentTurn) this.#settleError(error || Object.assign(new Error(`Claude stream-json exited (${code ?? signal ?? 'unknown'})`), { code: 'transport_eof' }));
    this.lifecycle = this.terminating || code === 0 ? 'ended' : 'failed';
    this.#emitExit({ code, signal, error });
    this.eventQueue.close();
  }

  #emitExit({ code, signal, error = null, verdict = null } = {}) {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.#emit('attempt.exited', {
      code, signal, verdict,
      ...(error ? { error: { code: error.code || 'transport_error', message: error.message } } : {}),
    }, error ? 'secret' : 'internal');
  }
}
