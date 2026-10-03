import type { Register } from 'claude-code';

// Forwards the events Cadre's session-state hook slot maps (modules/session-state/providers/hook.mjs)
// to scripts/agent-hooks/log-event.mjs, the recorder the per-session command hooks ran.

// One reporter at a time keeps events in order; the tool and the turn never wait on it.
let queue: Promise<unknown> = Promise.resolve();
let queued = 0;
let skipThrough = 0;

function record($: any, payload: object) {
  const n = ++queued;
  queue = queue
    .then(() => n > skipThrough && $.process.run(['node', `${$.plugin.root}/../log-event.mjs`, '--provider', 'claude'], {
      stdin: JSON.stringify(payload),
    }))
    .catch(() => {});
  return queue;
}

async function relay($: any, e: any, next: any) {
  // The process exits after SessionEnd within a short bound, so its record skips any backlog and lands first.
  const ending = e.hook_event_name === 'SessionEnd';
  if (ending) skipThrough = queued;
  const recorded = record($, e);
  if (ending) await recorded;
  return next(e);
}

// PreToolUse arrives as the tool-call envelope, without the classic base fields.
async function relayToolUse($: any, e: any, next: any) {
  // Tool arguments sit beside the envelope fields, so they go first and never shadow the base fields.
  record($, { ...e, hook_event_name: 'PreToolUse', session_id: await $.session.id(), cwd: await $.session.cwd(), tool_name: e.tool });
  return next(e);
}

export const register: Register = (on) => {
  on('classic.SessionStart', relay);
  on('classic.UserPromptSubmit', relay);
  on('classic.PreToolUse', relayToolUse);
  on('classic.PostToolUse', relay);
  on('classic.PermissionRequest', relay);
  on('classic.Notification', relay);
  on('classic.Stop', relay);
  on('classic.SessionEnd', relay);
};
