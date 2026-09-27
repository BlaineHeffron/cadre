import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isDurableTaskRecord } from '../sessions/task-record.mjs';

const id = { type: 'string', minLength: 1, maxLength: 240 };
const object = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });
const thread = { thread_id: id };
const task = { ...thread, task_id: id };

export const TASK_TOOLS = [
  { name: 'task_spawn', description: 'Persist and launch one bounded child task. Reusing parent/task_key returns the same task, including unknown startup outcomes.',
    inputSchema: object({ ...thread, parent_task_id: id, task_key: id,
      spec: object({ provider: id, workDir: { ...id, maxLength: 4096 }, model: id,
        displayName: id, initialPrompt: { type: 'string', maxLength: 200000 } }, ['provider', 'workDir', 'model']),
    }, ['thread_id', 'task_key', 'spec']) },
  { name: 'task_send', description: 'Persist idempotent task input. Ordinary input queues while busy; explicit steer requires the expected active turn and negotiated support.',
    inputSchema: object({ ...task, message_key: id, input: { type: 'string', minLength: 1, maxLength: 200000 },
      mode: { enum: ['queue', 'steer'] }, expected_turn_id: id }, ['thread_id', 'task_id', 'message_key', 'input']) },
  { name: 'task_wait', description: 'Collect durable task events/results after an opaque cursor across sessions and replacement attempts. Returning a cursor does not acknowledge its consumption; pass it on the next wait.',
    inputSchema: object({ ...thread, task_ids: { type: 'array', minItems: 1, maxItems: 24, uniqueItems: true, items: id },
      after: { type: 'string', maxLength: 100000 }, timeout_ms: { type: 'integer', minimum: 0, maximum: 30000 },
    }, ['thread_id', 'task_ids']) },
  { name: 'task_status', description: 'Read stable task/session/attempt/turn identities, startup evidence, mailbox state and durable outcomes.',
    inputSchema: object(task, ['thread_id', 'task_id']) },
  { name: 'task_cancel', description: 'Persist idempotent cancellation and fence further input. Provider confirmation and unknown outcomes remain distinct.',
    inputSchema: object({ ...task, request_key: id, scope: { enum: ['child', 'descendants'] } }, ['thread_id', 'task_id', 'request_key']) },
  { name: 'task_resume', description: 'Reconcile or explicitly replace an interrupted task attempt without replaying uncertain external effects.',
    inputSchema: object({ ...task, request_key: id }, ['thread_id', 'task_id', 'request_key']) },
];

const sameRef = (a, b) => Boolean(a && b && a.kind === b.kind && a.sessionId === b.sessionId);
function forbidden(message, reason) {
  return Object.assign(new Error(message), { statusCode: 403, code: 'mcp_forbidden', reason });
}

export function registerTaskRoutes({ app, store, service }) {
  for (const tool of TASK_TOOLS) {
    app.post(`/api/agent-bus/tasks/${tool.name.slice(5)}`, { schema: { body: tool.inputSchema } }, async (req, reply) => {
      try {
        const auth = req.duenoAuth;
        if (!auth?.authenticated || auth.legacyUntrusted) throw forbidden('Task operations require an authenticated principal', 'principal_missing');
        const principal = auth.principal;
        if (!principal?.kind || !principal.sessionId) throw forbidden('Task principal has no stable session identity', 'principal_missing');
        const actor = { kind: principal.kind, sessionId: principal.sessionId };
        const args = req.body;
        const room = store.getThread(args.thread_id)?.thread;
        if (!room) return reply.code(404).send({ error: 'Thread not found', code: 'thread_not_found' });
        const operator = principal.type === 'ui';
        if (!operator) {
          const scopes = auth.toolScopes || [];
          if (!scopes.includes('*') && !scopes.includes(tool.name)) throw forbidden(`Credential does not grant ${tool.name}`, 'scope_missing');
          const rooms = auth.threadAllowlist || [];
          if (!rooms.includes('*') && !rooms.includes(room.id) && !rooms.includes('@member')) throw forbidden('Credential is not valid for this thread', 'thread_not_allowlisted');
          if (!sameRef(room.createdBy, actor) && !room.participants.some((ref) => sameRef(ref, actor))) throw forbidden('Task caller is not a room participant', 'thread_membership_required');
        }
        const requireTask = async (taskId) => {
          const value = await service.status(taskId);
          if (value.parentThreadId !== room.id && value.threadId !== room.id) throw forbidden('Task belongs to another thread', 'task_thread_mismatch');
          if (tool.name === 'task_wait' && !operator && !sameRef(value.currentParentRef || value.parentRef, actor)) throw forbidden('Only the immediate parent may consume task results', 'task_consumer_required');
          if (!operator) {
            let owned = sameRef(value.ownerRef, actor) || sameRef(value.parentRef, actor);
            let current = value;
            const visited = new Set();
            while (!owned && current && !visited.has(current.taskId)) {
              visited.add(current.taskId);
              owned = current.sessionId === actor.sessionId && (current.kind || current.provider) === actor.kind;
              current = current.parentTaskId ? await service.status(current.parentTaskId) : null;
            }
            if (!owned) throw forbidden('Task is outside the authenticated parent scope', 'task_owner_required');
          }
          return value;
        };
        if (args.task_id) await requireTask(args.task_id);
        if (args.parent_task_id) await requireTask(args.parent_task_id);
        for (const taskId of args.task_ids || []) await requireTask(taskId);
        switch (tool.name) {
          case 'task_spawn': {
            const assigned = (store.listThreads?.() || []).find((entry) => isDurableTaskRecord(entry.metadata?.task) && entry.metadata.task.provider === actor.kind
              && entry.metadata.task.attempts?.at(-1)?.sessionId === actor.sessionId);
            if (!operator && assigned && args.parent_task_id !== assigned.id) throw forbidden('A task child must delegate through its own parent_task_id', 'task_parent_required');
            if (!isAbsolute(args.spec.workDir)) return reply.code(400).send({ error: 'workDir must be absolute', code: 'invalid_workdir' });
            const workDir = await realpath(args.spec.workDir);
            const allowed = ['mcp:discover', 'room_context', 'room_send', ...TASK_TOOLS.map((entry) => entry.name)];
            const toolScopes = operator || auth.toolScopes.includes('*') ? allowed : allowed.filter((scope) => auth.toolScopes.includes(scope));
            return await service.spawn(args.parent_task_id || null, args.task_key, {
              ...args.spec, workDir, threadId: room.id, ownerRef: actor, parentRef: actor, toolScopes,
              permissionMode: 'workspace-write',
              ...(!args.parent_task_id ? { scope: { providers: [args.spec.provider], workDirs: [workDir], maxDepth: 1, maxChildren: 2, toolScopes } } : {}),
            });
          }
          case 'task_send':
            return await service.send(args.task_id, args.message_key, args.input,
              { mode: args.mode || 'queue', expectedTurnId: args.expected_turn_id });
          case 'task_wait':
            return await service.wait(args.task_ids, args.after, args.timeout_ms || 0, { consumerId: `${actor.kind}:${actor.sessionId}` });
          case 'task_status': return await service.status(args.task_id);
          case 'task_cancel': return await service.cancel(args.task_id, args.request_key, args.scope || 'child');
          case 'task_resume': return await service.resume(args.task_id, args.request_key);
        }
      } catch (error) {
        return reply.code(error.statusCode || 500).send({ error: error.message, code: error.code || null, ...(error.reason ? { reason: error.reason } : {}) });
      }
    });
  }
}
