import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const scenario = process.argv[2] || 'normal';
const log = process.argv[3];
let initialized = false, notified = false, next = 0, active = null, config = {}, awaiting = null;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const thread = (turns = []) => ({ id: 'thread-1', turns });
const notify = (method, params) => send({ method, params: { threadId: 'thread-1', ...params } });
function finish(status = 'completed', text = 'answer') {
  notify('turn/completed', { turn: { id: active, status, items: [{ type: 'agentMessage', id: 'answer-' + active, text }], error: status === 'failed' ? { message: 'provider refused' } : null } }); active = null;
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line); if (log) appendFileSync(log, line + '\n');
  if ('jsonrpc' in message) throw new Error('App Server wire must omit jsonrpc');
  const { id, method, params } = message;
  const reply = (result) => send({ id, result });
  const reject = (message) => send({ id, error: { code: -32602, message } });
  if (method === 'initialize') {
    if (scenario === 'startup-timeout') return;
    initialized = true; return reply({ userAgent: 'fixture/0.153.4', platformFamily: 'unix', platformOs: 'linux' });
  }
  if (method === 'initialized') { notified = initialized; return; }
  if (method && !notified) return reject('Not initialized');
  if (method === 'thread/start' || method === 'thread/resume') { config = params.config || {}; return reply({ thread: thread(), model: scenario === 'mismatch' ? 'other' : params.model || 'fixture-model', reasoningEffort: 'high' }); }
  if (method === 'mcpServerStatus/list' && scenario === 'isolation') {
    const topDisabled = config.mcp_servers?.external?.enabled === false;
    const pluginDisabled = config.plugins?.['fixture@local']?.mcp_servers?.pluginTool?.enabled === false;
    return reply({ data: [
      { name: 'dueno', tools: { room_context: {}, room_send: {} }, runtimeStatus: 'connected' },
      { name: 'external', tools: topDisabled ? {} : { write: {} }, runtimeStatus: topDisabled ? 'disabled' : 'connected' },
      { name: 'pluginTool', pluginId: 'fixture@local', tools: pluginDisabled ? {} : { write: {} }, runtimeStatus: pluginDisabled ? 'disabled' : 'connected' },
    ], nextCursor: null });
  }
  if (method === 'mcpServerStatus/list') {
    const names = scenario === 'task-approvals'
      ? config.mcp_servers?.dueno?.enabled_tools || ['room_context', 'room_send', 'task_spawn', 'task_send', 'task_wait', 'task_status', 'task_cancel', 'task_resume']
      : ['room_context', 'room_send'];
    return reply({ data: [{ name: 'dueno', authStatus: 'bearerToken', tools: Object.fromEntries(names.filter((name) => name !== 'mcp:discover').map((name) => [name, {}])) }], nextCursor: null });
  }
  if (method === 'thread/read') return reply({ thread: thread(scenario === 'resume-active' ? [{ id: 'old-turn', status: 'inProgress', items: [] }] : [{ id: 'old-turn', status: 'completed', items: [{ type: 'agentMessage', id: 'old-output', text: 'persisted answer' }] }]) });
  if (method === 'turn/start') {
    if (scenario === 'headroom') {
      const routed = process.env.OPENAI_BASE_URL === 'http://127.0.0.1:8787/v1'
        && process.argv.includes('model_provider="dueno-headroom"')
        && process.argv.includes('model_providers.dueno-headroom.base_url="http://127.0.0.1:8787/v1"')
        && process.argv.includes('model_providers.dueno-headroom.http_headers.x-headroom-base-url="https://api.openai.com"');
      active = 'routing-turn';
      reply({ turn: { id: active, status: 'inProgress', items: [] } });
      return setTimeout(() => finish('completed', routed ? 'headroom-routed' : 'direct-routed'), 10);
    }
    if (scenario === 'reject') return reject('scoped rejection');
    const requestedTool = params.input?.[0]?.text;
    if (scenario === 'task-approvals' && config.mcp_servers?.dueno?.tools?.[requestedTool]?.approval_mode !== 'approve') return reject('tool requires approval');
    active = 'provider-turn-' + (++next);
    if (scenario === 'malformed') return process.stdout.write('{broken\n');
    if (scenario === 'lost-ack') return;
    if (scenario === 'early') {
      finish(); return reply({ turn: { id: 'provider-turn-' + next, status: 'inProgress', items: [] } });
    }
    reply({ turn: { id: active, status: 'inProgress', items: [] } });
    if (scenario === 'task-approvals') {
      notify('item/completed', { turnId: active, item: { type: 'mcpToolCall', id: 'tool-' + active, server: 'dueno', tool: requestedTool,
        arguments: {}, status: 'completed', result: { content: [{ type: 'text', text: 'fixture task receipt' }] } } });
      return setTimeout(() => finish('completed', `Executed ${requestedTool}`), 10);
    }
    if (scenario === 'reroute') notify('model/rerouted', { turnId: active, fromModel: 'fixture-model', toModel: 'fallback-model', reason: 'highRisk' });
    notify('item/agentMessage/delta', { turnId: active, delta: 'partial ' });
    notify('item/agentMessage/delta', { threadId: 'foreign', turnId: active, delta: 'FOREIGN' });
    notify('item/started', { turnId: active, item: { type: 'mcpToolCall', id: 'tool-1', tool: 'room_context', arguments: {} } });
    if (scenario === 'death') return setTimeout(() => process.exit(9), 15);
    if (scenario === 'hold') return;
    if (scenario === 'requests') {
      const base = { threadId: 'thread-1', turnId: active };
      awaiting = new Set(['elicit-1', 'unknown-1', 'file-1', 'perm-1', 'input-1']);
      send({ id: 'elicit-1', method: 'mcpServer/elicitation/request', params: { ...base, serverName: 'fixture', mode: 'form', message: 'Token?', requestedSchema: { type: 'object', properties: {} } } });
      send({ id: 'unknown-1', method: 'item/tool/call', params: { ...base, callId: 'call-1', tool: 'fixture', arguments: {} } });
      send({ id: 'file-1', method: 'item/fileChange/requestApproval', params: { ...base, itemId: 'patch-1', reason: 'Write fixture file' } });
      send({ id: 'perm-1', method: 'item/permissions/requestApproval', params: { ...base, itemId: 'perm-1', cwd: '/tmp', reason: 'Needs network', permissions: { network: { enabled: true } } } });
      return send({ id: 'input-1', method: 'item/tool/requestUserInput', params: { ...base, itemId: 'ask-1', isBlocking: true, questions: [
        { id: 'color', header: 'Color', question: 'Pick a color', isOther: true, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] },
        { id: 'name', header: 'Name', question: 'Name the file', options: null }] } });
    }
    if (scenario === 'approval') return send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: active, itemId: 'tool-1', availableDecisions: ['accept', 'decline'] } });
    return setTimeout(() => finish(scenario === 'failed' ? 'failed' : 'completed'), 10);
  }
  if (method === 'turn/steer') return params.expectedTurnId === active ? reply({ turnId: active }) : reject('expectedTurnId mismatch');
  if (method === 'turn/interrupt') {
    if (params.turnId !== active) return reject('turnId mismatch');
    reply({}); return setTimeout(() => finish('interrupted'), 15);
  }
  if (!method && (id === 'approval-1' || (awaiting?.delete(id) && !awaiting.size))) return finish();
  return reject('unsupported method');
});
