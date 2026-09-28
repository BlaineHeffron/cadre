import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { AsyncEventQueue, createBaseCapabilities, createTransportEvent, questionInteraction, unsupportedCapability } from './agent-transport.mjs';
import { NdjsonJsonRpcCodec, DEFER_JSON_RPC_RESPONSE } from './ndjson-json-rpc.mjs';
import { ProcessSupervisor, buildSupervisedEnv } from './process-supervisor.mjs';

const execute = promisify(execFile);
export const CODEX_APP_SERVER_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'DUENO_SESSION_ID', 'DUENO_PROVIDER', 'DUENO_AGENT_BUS_TOKEN',
  'DUENO_DISABLE_SIDE_EFFECTS', 'DM_GITHUB_AGENT_POLLER_ENABLED', 'DM_GITHUB_AGENTS_ENABLED',
  'DM_SCHEDULED_AGENT_PUMP_ENABLED', 'TELEGRAM_BRIDGE', 'PORT', 'AGENT_BUS_MCP_HTTP_PORT',
]);
const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

// Generate the stable schema with the very binary we launch; initialize does not
// return a server method catalog. Never infer support from the provider name.
export async function readCodexAppServerSchema({ binary = 'codex', cwd, env = {}, argsPrefix = [], timeoutMs = 15_000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dueno-codex-schema-'));
  try {
    const options = { cwd, env, timeout: timeoutMs, maxBuffer: 1024 * 1024 };
    const { stdout } = await execute(binary, [...argsPrefix, '--version'], options);
    await execute(binary, [...argsPrefix, 'app-server', 'generate-json-schema', '--out', root], options);
    const bytes = await readFile(join(root, 'ClientRequest.json'));
    const schema = JSON.parse(bytes);
    const requests = schema.oneOf || [];
    const steer = requests.find((entry) => entry.properties?.method?.enum?.includes('turn/steer'));
    const params = schema.definitions?.[steer?.properties?.params?.$ref?.split('/').at(-1)];
    return {
      source: 'installed_cli_schema', cliVersion: stdout.trim(),
      schemaSha256: createHash('sha256').update(bytes).digest('hex'),
      methods: requests.flatMap((entry) => entry.properties?.method?.enum || []),
      steerExpectedTurnId: params?.required?.includes('expectedTurnId') === true,
    };
  } finally { await rm(root, { recursive: true, force: true }); }
}

export function codexAppServerCapabilities(evidence = null) {
  const has = (method) => evidence?.methods?.includes(method) === true;
  return createBaseCapabilities({
    protocol: { name: 'codex-app-server', version: evidence?.cliVersion || '' },
    turn: { admission: 'single', steer: has('turn/steer') && evidence.steerExpectedTurnId === true, followup: false },
    cancellation: has('turn/interrupt') ? 'best_effort' : 'none',
    interaction: { permissions: 'structured_options', elicitation: false, answerOnce: true },
    streaming: 'deltas_and_committed_messages',
    streamFeatures: { tool_events: true, thought_events: true, plan: true, usage: true },
    sessionOps: { list: 'unsupported', load: has('thread/read') ? 'supported' : 'unsupported',
      resume: has('thread/resume') && has('thread/read') ? 'supported' : 'unsupported',
      fork: 'unsupported', close: 'unsupported', delete: 'supported' },
    recovery: { processSurvivesFleetRestart: false, fleetRecoverable: has('thread/read') && has('thread/resume') ? 'provider_thread' : 'none' },
    identity: 'connection_bound',
    promptCapabilities: { types: ['text'], deliveryMode: 'inline', mimeAllowlist: [], maxBytes: 0, maxCount: 0, maxSessionBytes: 0 },
    evidence,
  });
}

function inputBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) throw new TypeError('Nonempty prompt blocks required');
  return blocks.map((block) => {
    if (block?.type !== 'text') throw unsupportedCapability(`prompt.${block?.type || 'unknown'}`);
    if (!String(block.text || '').trim()) throw new TypeError('Text prompt cannot be empty');
    return { type: 'text', text: String(block.text) };
  });
}

export class CodexAppServerTransport {
  constructor({ binary = 'codex', argsPrefix = [], env = process.env, allowedEnvKeys = CODEX_APP_SERVER_ENV_ALLOWLIST,
    supervisor = null, requestTimeoutMs = 30_000, schemaReader = readCodexAppServerSchema, maxFrameBytes } = {}) {
    Object.assign(this, { binary, argsPrefix, env, allowedEnvKeys, requestTimeoutMs, schemaReader, maxFrameBytes });
    this.supervisor = supervisor || new ProcessSupervisor({ ledgerPath: null });
    this.eventQueue = new AsyncEventQueue();
    this.interactions = new Map();
    this.lifecycle = 'created';
    this.attemptId = ''; this.instanceId = ''; this.protocolSessionId = '';
    this.currentTurn = null; this.startup = null; this.exitEmitted = false;
    this.negotiated = codexAppServerCapabilities();
  }
  get closed() { return ['ended', 'failed'].includes(this.lifecycle) || this.codec?.closed === true; }
  capabilities() { return this.negotiated; }
  events() { return this.eventQueue; }
  snapshot() {
    return structuredClone({ attemptId: this.attemptId, protocolSessionId: this.protocolSessionId,
      providerThreadId: this.protocolSessionId, providerTurnId: this.currentTurn?.providerTurnId || null,
      currentTurnId: this.currentTurn?.turnId || null, lifecycle: this.lifecycle,
      startup: this.startup, negotiated: this.negotiated, openInteractions: [...this.interactions.keys()],
      runtime: this.supervisor.runtime(this.instanceId) });
  }
  async attach(spec = {}) {
    if (!spec.protocolSessionId && !spec.providerThreadId) throw new TypeError('Provider thread identity required for resume');
    return this.start(spec);
  }

  async start(spec = {}) {
    if (this.lifecycle !== 'created') throw new Error('App Server already started');
    const cwd = spec.cwd || spec.workDir;
    if (!isAbsolute(cwd || '')) throw new TypeError('App Server cwd must be absolute');
    this.lifecycle = 'starting';
    this.attemptId = spec.attemptId || randomUUID(); this.instanceId = spec.instanceId || this.attemptId;
    const env = buildSupervisedEnv(spec.env || this.env, spec.allowedEnvKeys || this.allowedEnvKeys);
    try {
      const evidence = await this.schemaReader({ binary: this.binary, argsPrefix: this.argsPrefix, cwd, env });
      this.negotiated = codexAppServerCapabilities(evidence);
      for (const method of ['initialize', 'thread/start', 'turn/start']) this.#require(method);
      const runtime = await this.supervisor.spawn({ instanceId: this.instanceId, driver: 'codex-app-server',
        driverVersion: evidence.cliVersion, command: this.binary, args: [...this.argsPrefix, 'app-server', ...(spec.args || [])],
        cwd, env, allowedEnvKeys: Object.keys(env), negotiated: this.negotiated,
        metadata: { ...(spec.metadata || {}), attemptId: this.attemptId, provider: 'codex-app-server' } });
      this.child = runtime.child;
      this.codec = new NdjsonJsonRpcCodec({ readable: this.child.stdout, writable: this.child.stdin,
        omitJsonrpc: true, requestTimeoutMs: this.requestTimeoutMs, maxFrameBytes: this.maxFrameBytes,
        onNotification: (method, params) => this.#notification(method, params),
        onRequest: (method, params, message) => this.#request(method, params, message),
      });
      this.codec.once('close', (error) => {
        if (this.currentTurn || !this.terminating) this.#uncertain(error);
        if (!this.terminating) void this.terminate().catch(() => {});
      });
      this.child.stderr.on('data', () => {}); // Runtime stderr may contain credentials; never journal it.
      this.child.once('exit', (code, signal) => this.#exit(code, signal));
      this.child.once('error', (error) => { this.#uncertain(error); this.#exit(null, null); });
      const initialized = await this.#rpc('initialize', {
        clientInfo: { name: 'dueno_fleet', version: '1.0.0' }, capabilities: { experimentalApi: false },
      });
      await this.codec.notify('initialized', {});
      const config = { ...(spec.config || {}), ...(spec.thinkingLevel ? { model_reasoning_effort: spec.thinkingLevel } : {}) };
      if (spec.allowedMcpServers) {
        config.mcp_servers = { ...(config.mcp_servers || {}) };
        for (const server of await this.#inventory()) {
          if (spec.allowedMcpServers.includes(server.name)) continue;
          if (server.pluginId) {
            config.plugins ||= {};
            config.plugins[server.pluginId] ||= {};
            config.plugins[server.pluginId].mcp_servers ||= {};
            config.plugins[server.pluginId].mcp_servers[server.name] = { enabled: false };
          } else config.mcp_servers[server.name] = { enabled: false };
        }
        if (spec.allowedMcpTools) {
          for (const name of spec.allowedMcpServers) config.mcp_servers[name] = { ...(config.mcp_servers[name] || {}), enabled_tools: spec.allowedMcpTools };
        }
      }
      this.protocolSessionId = spec.providerThreadId || spec.protocolSessionId || '';
      let reconciliation = null;
      if (this.protocolSessionId) {
        reconciliation = await this.reconcile({ providerTurnId: spec.providerTurnId });
        if (reconciliation.active || reconciliation.status === 'inProgress' || reconciliation.status === 'unknown') {
          throw failure('resume_uncertain', 'Provider thread has unresolved work; refusing admission or replay', { reconciliation });
        }
      }
      const method = this.protocolSessionId ? 'thread/resume' : 'thread/start';
      const response = await this.#rpc(method, {
        ...(this.protocolSessionId ? { threadId: this.protocolSessionId } : {}), cwd,
        ...(spec.model ? { model: spec.model } : {}),
        config,
        ...(spec.developerInstructions ? { developerInstructions: spec.developerInstructions } : {}),
        ...(spec.ephemeral !== undefined && method === 'thread/start' ? { ephemeral: spec.ephemeral } : {}),
        sandbox: spec.permissionMode || 'read-only', approvalPolicy: spec.approvalPolicy || 'on-request',
      });
      if (!response?.thread?.id) throw failure('invalid_thread_response', 'App Server did not return a thread identity');
      this.protocolSessionId = response.thread.id;
      this.startup = { protocol: 'codex-app-server', initialize: {
        userAgent: initialized.userAgent, platformFamily: initialized.platformFamily, platformOs: initialized.platformOs,
      }, schema: evidence, requestedModel: spec.model || null, effectiveModel: response.model || null,
      modelEvidence: { source: `${method}.response.model`, inferenceIdentityVerified: false },
      requestedReasoningEffort: config.model_reasoning_effort || null,
      effectiveReasoningEffort: response.reasoningEffort || null,
      providerThreadId: this.protocolSessionId, attemptId: this.attemptId,
      taskId: spec.metadata?.taskId || null,
      sessionId: spec.metadata?.sessionId || spec.sessionId || null, reconciliation,
      tools: [], roomRead: { status: 'unverified' }, roomReply: { status: 'unverified' } };
      if (spec.model && response.model !== spec.model) throw failure('model_mismatch', `Requested model ${spec.model}; provider reported ${response.model || 'unknown'}`);
      if (this.negotiated.evidence.methods.includes('mcpServerStatus/list')) {
          for (const server of await this.#inventory(this.protocolSessionId)) this.startup.tools.push({ server: server.name, authStatus: server.authStatus,
            runtimeStatus: server.runtimeStatus, names: Object.keys(server.tools || {}), resourceCount: (server.resources || []).length + (server.resourceTemplates || []).length });
      }
      const available = new Set(this.startup.tools.flatMap((server) => server.names));
      const unexpected = this.startup.tools.filter((server) => spec.allowedMcpServers && !spec.allowedMcpServers.includes(server.server)
        && (server.runtimeStatus !== 'disabled' || server.names.length || server.resourceCount));
      if (unexpected.length) throw failure('startup_mcp_scope_expanded', `Unexpected provider MCP servers: ${unexpected.map((server) => server.server).join(', ')}`);
      const extraTools = [...available].filter((name) => spec.allowedMcpTools && !spec.allowedMcpTools.includes(name));
      if (extraTools.length) throw failure('startup_tool_scope_expanded', `Unexpected provider MCP tools: ${extraTools.join(', ')}`);
      const missing = (spec.requiredTools || []).filter((name) => !available.has(name));
      if (missing.length) throw failure('startup_tools_missing', `Required provider tools missing: ${missing.join(', ')}`);
      this.negotiated = createBaseCapabilities({ ...this.negotiated,
        requestedModel: this.startup.requestedModel, effectiveModel: this.startup.effectiveModel,
        effectiveThinkingLevel: this.startup.effectiveReasoningEffort,
        modelEvidence: this.startup.modelEvidence, startup: this.startup });
      this.lifecycle = 'ready';
      this.supervisor.markConnection(this.instanceId, 'open', this.negotiated);
      const started = { attemptId: this.attemptId, protocolSessionId: this.protocolSessionId,
        providerThreadId: this.protocolSessionId, negotiated: this.negotiated, startup: this.startup };
      this.#emit('attempt.started', started);
      return started;
    } catch (error) {
      this.#emit('transport.error', { kind: error.code || 'startup_failed', message: error.message, startup: this.startup });
      await this.terminate().catch(() => {});
      this.lifecycle = 'failed';
      throw error;
    }
  }

  async prompt({ turnId = randomUUID(), blocks, idempotencyKey = '' } = {}) {
    if (this.lifecycle !== 'ready' || this.currentTurn) throw failure('turn_inflight', `App Server is ${this.lifecycle}`, { statusCode: 409 });
    const input = inputBlocks(blocks);
    const turn = { turnId, idempotencyKey, providerTurnId: null, events: [], accepted: false, pending: [], committed: new Set() };
    const settled = new Promise((resolve, reject) => Object.assign(turn, { resolve, reject }));
    this.currentTurn = turn; this.lifecycle = 'working';
    this.#emit('turn.started', { turnId, phase: 'queued', evidence: { accepted: false, settled: false, quiescent: false } });
    // App Server has no exactly-once turn/start contract: never retry a lost ack.
    void this.#rpc('turn/start', { threadId: this.protocolSessionId, input })
      .then((response) => {
        if (this.currentTurn !== turn) return;
        if (!response?.turn?.id) throw failure('invalid_turn_response', 'Missing provider turn identity');
        turn.providerTurnId = response.turn.id; turn.accepted = true;
        this.#emit('turn.started', { turnId, providerTurnId: turn.providerTurnId, providerThreadId: this.protocolSessionId,
          idempotencyKey, phase: 'inflight', evidence: { accepted: true, settled: false, quiescent: false } });
        for (const [method, params] of turn.pending.splice(0)) this.#notification(method, params);
        if (this.currentTurn === turn && ['completed', 'failed', 'interrupted'].includes(response.turn.status)) this.#complete(response.turn);
      }).catch((error) => {
        if (this.currentTurn !== turn) return;
        if (error.responseReceived && !turn.accepted) this.#failTurn(error, true);
        else this.#uncertain(error);
      });
    return settled;
  }

  async steer({ blocks, expectedTurnId } = {}) {
    if (!this.negotiated.turn.steer) throw unsupportedCapability('turn.steer');
    const turn = this.currentTurn;
    if (!expectedTurnId || expectedTurnId !== turn?.providerTurnId || this.lifecycle !== 'working') {
      throw failure('turn_not_active', 'Steering requires the matching active provider turn ID', { statusCode: 409 });
    }
    const input = inputBlocks(blocks);
    try {
      const result = await this.#rpc('turn/steer', { threadId: this.protocolSessionId, expectedTurnId, input });
      if (result?.turnId !== expectedTurnId) throw failure('invalid_steer_response', 'Steering receipt has a different provider turn ID');
      return { ...result, providerTurnId: result.turnId, accepted: true };
    } catch (error) { if (!error.responseReceived) this.#uncertain(error); throw error; }
  }

  async cancel({ turnId } = {}) {
    this.#require('turn/interrupt');
    const turn = this.currentTurn;
    if (!turn?.providerTurnId || (turnId && turnId !== turn.turnId && turnId !== turn.providerTurnId)) {
      throw failure('turn_not_active', 'No matching admitted provider turn to interrupt', { statusCode: 409 });
    }
    this.lifecycle = 'cancelling';
    try {
      await this.#rpc('turn/interrupt', { threadId: this.protocolSessionId, turnId: turn.providerTurnId });
      return { mode: 'best_effort', providerTurnId: turn.providerTurnId }; // completion notification confirms cancellation
    } catch (error) { if (!error.responseReceived) this.#uncertain(error); else if (this.currentTurn === turn) this.lifecycle = 'working'; throw error; }
  }

  async reconcile({ providerThreadId = this.protocolSessionId, providerTurnId } = {}) {
    if (!providerThreadId || providerThreadId !== this.protocolSessionId) throw failure('thread_mismatch', 'Reconciliation requires this transport thread identity');
    const { thread } = await this.#rpc('thread/read', { threadId: providerThreadId, includeTurns: true });
    if (thread?.id !== providerThreadId) throw failure('thread_mismatch', 'Read returned a different provider thread');
    const turn = providerTurnId ? thread.turns?.find((entry) => entry.id === providerTurnId) : thread.turns?.at(-1);
    const terminal = ['completed', 'failed', 'interrupted'].includes(turn?.status);
    return { providerThreadId, providerTurnId: turn?.id || providerTurnId || null,
      active: thread.status?.type === 'active' || thread.turns?.some((entry) => entry.status === 'inProgress') === true,
      status: turn?.status || (providerTurnId || !Array.isArray(thread.turns) ? 'unknown' : 'empty'),
      evidence: { source: 'thread/read', accepted: Boolean(turn), settled: terminal, quiescent: terminal || (!providerTurnId && thread.turns?.length === 0) },
      turn: turn || null };
  }

  async answerInteraction({ interactionId, optionId, text } = {}) {
    const entry = this.interactions.get(interactionId);
    if (!entry || entry.answered) throw failure('interaction_not_open', 'Interaction is not open', { statusCode: 409 });
    const answer = String(text || optionId || '');
    const closed = entry.question?.options?.length && !entry.question.isOther && !entry.question.options.some((item) => item.label === answer);
    if (entry.question ? !answer || closed : !entry.options.includes(optionId)) throw failure('invalid_interaction_option', 'Unsupported approval decision', { statusCode: 400 });
    entry.answered = true;
    // Response shapes per codex-cli 0.157.1 schema; permissions/requestUserInput mappings follow t3code (MIT).
    if (entry.question) entry.pending.answers[entry.question.id] = { answers: [answer] };
    const result = entry.question ? { answers: entry.pending.answers }
      : entry.permissions ? { permissions: optionId === 'decline' ? {} : entry.permissions, ...(optionId === 'acceptForSession' ? { scope: 'session' } : {}) }
        : { decision: optionId };
    if (!entry.question || !--entry.pending.remaining) {
      try { await this.codec.respond(entry.id, result); }
      catch (error) { this.#uncertain(error); throw error; }
    }
    this.interactions.delete(interactionId);
    this.#emit('interaction.answered', { interactionId, optionId });
    if (this.currentTurn && !this.interactions.size && this.lifecycle === 'blocked') this.lifecycle = 'working';
    return { ok: true };
  }

  async terminate({ grace = 300 } = {}) {
    this.terminating = true;
    this.codec?.close(failure('transport_closed', 'App Server terminated'));
    const verdict = await this.supervisor.terminate(this.instanceId, { graceMs: grace });
    this.lifecycle = verdict.ok ? 'ended' : 'failed';
    this.#exit(null, null, verdict);
    return verdict;
  }
  #require(method) { if (!this.negotiated.evidence?.methods?.includes(method)) throw unsupportedCapability(method); }
  #rpc(method, params) { this.#require(method); return this.codec.request(method, params); }
  async #inventory(threadId) {
    const servers = [], seen = new Set(); let cursor;
    do {
      const page = await this.#rpc('mcpServerStatus/list', { ...(threadId ? { threadId } : {}), ...(cursor ? { cursor } : {}) });
      servers.push(...(page.data || [])); cursor = page.nextCursor;
      if (cursor && (seen.has(cursor) || seen.size >= 100)) throw failure('invalid_tool_cursor', 'MCP inventory pagination limit or repeated cursor');
      seen.add(cursor);
    } while (cursor);
    return servers;
  }
  #emit(type, payload = {}) {
    const event = createTransportEvent(type, payload, { attemptId: this.attemptId, provider: 'codex-app-server', transport: 'codex-app-server' });
    this.currentTurn?.events.push(event); this.eventQueue.push(event); return event;
  }
  #request(method, params, message) {
    // Cadre hosts no MCP elicitation forms; decline instead of leaving the tool call hanging.
    if (method === 'mcpServer/elicitation/request') return { action: 'decline' };
    const permissions = method === 'item/permissions/requestApproval';
    if (!permissions && !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput'].includes(method)) return undefined;
    if (params.threadId !== this.protocolSessionId || !this.currentTurn || (this.currentTurn.providerTurnId && params.turnId !== this.currentTurn.providerTurnId)) return undefined;
    const interactionId = `${this.attemptId}:${message.id}`;
    if (this.interactions.has(interactionId)) return DEFER_JSON_RPC_RESPONSE;
    const turnId = this.currentTurn.turnId;
    if (method === 'item/tool/requestUserInput') {
      // Secret answers would be stored in plaintext in the journal and delivery audit; decline them.
      if (!params.questions?.length || params.questions.some((question) => question.isSecret)) return { answers: {} };
      const pending = { answers: {}, remaining: params.questions.length };
      params.questions.forEach((question, index) => {
        const id = index ? `${interactionId}:${index}` : interactionId;
        this.interactions.set(id, { id: message.id, question, pending, answered: false });
        const { kind, options, toolCall } = questionInteraction(question);
        this.#emit('interaction.requested', { interactionId: id, turnId, kind, options, toolCall: { ...toolCall, toolCallId: params.itemId, name: method } });
      });
      this.lifecycle = 'blocked';
      return DEFER_JSON_RPC_RESPONSE;
    }
    const options = (params.availableDecisions || ['accept', 'acceptForSession', 'decline', ...(permissions ? [] : ['cancel'])])
      .filter((decision) => ['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision));
    this.interactions.set(interactionId, { id: message.id, options, permissions: permissions && (params.permissions || {}), answered: false });
    this.lifecycle = 'blocked';
    this.#emit('interaction.requested', { interactionId, turnId, kind: 'permission',
      options: options.map((optionId) => ({ optionId, name: optionId, kind: { accept: 'allow_once', acceptForSession: 'allow_always' }[optionId] || 'reject_once' })),
      toolCall: { toolCallId: params.itemId, name: method, title: params.reason || 'Codex approval required',
        input: { command: params.command, cwd: params.cwd, permissions: params.permissions } } });
    return DEFER_JSON_RPC_RESPONSE;
  }
  #notification(method, params) {
    if (params.threadId !== this.protocolSessionId) return;
    const turn = this.currentTurn;
    if (!turn) return;
    if (!turn.providerTurnId) { turn.pending.push([method, params]); return; }
    if ((params.turnId || params.turn?.id) !== turn.providerTurnId) return;
    const ids = { turnId: turn.turnId, providerTurnId: turn.providerTurnId, providerThreadId: this.protocolSessionId };
    if (method === 'model/rerouted') {
      const modelEvidence = { source: 'model/rerouted', inferenceIdentityVerified: false,
        fromModel: params.fromModel, reason: params.reason, providerTurnId: turn.providerTurnId };
      this.negotiated = createBaseCapabilities({ ...this.negotiated, effectiveModel: params.toModel, modelEvidence });
      this.#emit('diagnostic', { ...ids, kind: 'model_rerouted', requestedModel: this.startup?.requestedModel,
        effectiveModel: params.toModel, modelEvidence });
      return;
    }
    if (method === 'turn/completed') return this.#complete(params.turn);
    if (method === 'item/agentMessage/delta') this.#emit('message.delta', { ...ids, delta: { type: 'text', text: params.delta } });
    else if (method === 'item/reasoning/summaryTextDelta') this.#emit('thought.delta', { ...ids, delta: { type: 'text', text: params.delta } });
    else if (method === 'turn/plan/updated') this.#emit('plan.update', { ...ids, plan: params.plan });
    else if (method === 'thread/tokenUsage/updated') this.#emit('usage', { ...ids, ...(params.tokenUsage?.last || {}) });
    else if (method === 'item/started' || method === 'item/completed') {
      const item = params.item || {};
      if (item.type === 'agentMessage' && method === 'item/completed' && !turn.committed.has(item.id)) {
        turn.committed.add(item.id);
        this.#emit('message.committed', { ...ids, messageId: item.id, blocks: [{ type: 'text', text: item.text || '' }] });
      }
      else if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(item.type)) {
        this.#emit(method === 'item/started' ? 'tool.call' : 'tool.update', { ...ids, toolCallId: item.id,
          name: item.tool || item.type, status: item.status || (method === 'item/started' ? 'inProgress' : 'completed'), input: item.arguments });
      }
    } else if (method === 'error') this.#emit('diagnostic', { ...ids, kind: 'provider_error', message: params.error?.message, willRetry: params.willRetry });
  }
  #clearInteractions() {
    for (const interactionId of this.interactions.keys()) this.#emit('interaction.cancelled', { interactionId, reason: 'turn_ended' });
    this.interactions.clear();
  }
  #complete(providerTurn) {
    const turn = this.currentTurn;
    if (!turn || !['completed', 'failed', 'interrupted'].includes(providerTurn.status)) return;
    for (const item of providerTurn.items || []) {
      this.#notification('item/completed', { threadId: this.protocolSessionId, turnId: turn.providerTurnId, item });
    }
    if (providerTurn.status === 'failed') {
      const error = failure('codex_turn_failed', providerTurn.error?.message || 'Codex turn failed', { responseReceived: true });
      this.#failTurn(error, true); return;
    }
    const evidence = { accepted: true, settled: true, quiescent: true };
    const stopReason = providerTurn.status === 'interrupted' ? 'cancelled' : 'end_turn';
    this.#emit('turn.settled', { turnId: turn.turnId, providerTurnId: turn.providerTurnId, stopReason, evidence });
    this.#clearInteractions(); this.currentTurn = null; this.lifecycle = 'ready';
    turn.resolve({ stopReason, evidence, providerTurnId: turn.providerTurnId, events: turn.events });
  }
  #failTurn(error, remotelySettled = false) {
    const turn = this.currentTurn;
    if (!turn) return;
    const evidence = { accepted: turn.accepted, settled: remotelySettled, quiescent: remotelySettled };
    this.#emit('turn.settled', { turnId: turn.turnId, providerTurnId: turn.providerTurnId,
      error: { code: error.code, message: error.message }, evidence });
    this.#clearInteractions(); this.currentTurn = null; this.lifecycle = remotelySettled ? 'ready' : 'failed';
    Object.assign(error, { responseReceived: remotelySettled, uncertain: !remotelySettled, evidence, providerThreadId: this.protocolSessionId, providerTurnId: turn.providerTurnId });
    turn.reject(error);
  }
  #uncertain(error) {
    this.#failTurn(error);
    if (this.lifecycle !== 'ended') this.lifecycle = 'failed';
    this.#emit('transport.error', { kind: error.code || 'transport_error', message: error.message, uncertain: true });
  }
  #exit(code, signal, verdict = null) {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    if (this.currentTurn) this.#uncertain(failure('transport_eof', 'App Server exited before a terminal turn receipt'));
    this.lifecycle = this.terminating ? 'ended' : 'failed';
    this.#emit('attempt.exited', { code, signal, verdict }); this.eventQueue.close();
  }
}
