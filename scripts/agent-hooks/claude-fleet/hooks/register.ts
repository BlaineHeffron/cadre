import type { Register } from 'claude-code';

// Forwards the events Cadre's session-state hook slot maps (modules/session-state/providers/hook.mjs)
// to scripts/agent-hooks/log-event.mjs, the recorder the per-session command hooks ran.

// One reporter at a time keeps events in order; the tool and the turn never wait on it.
let queue: Promise<unknown> = Promise.resolve();
let queued = 0;
let skipThrough = 0;

function report($: any, payload: object) {
  return $.process.run(['node', `${$.plugin.root}/../log-event.mjs`, '--provider', 'claude'], {
    stdin: JSON.stringify(payload),
  });
}

function record($: any, payload: object) {
  const n = ++queued;
  queue = queue
    .then(() => n > skipThrough && report($, payload))
    .catch(() => {});
  return queue;
}

async function relay($: any, e: any, next: any) {
  // SessionEnd shares a short bound with session.end; start its record now and skip not-yet-started backlog.
  if (e.hook_event_name === 'SessionEnd') {
    skipThrough = queued;
    await report($, e).catch(() => {});
    return next(e);
  }
  record($, e);
  return next(e);
}

// PreToolUse arrives as the tool-call envelope, without the classic base fields.
async function relayToolUse($: any, e: any, next: any) {
  // Tool arguments sit beside the envelope fields, so they go first and never shadow the base fields.
  record($, { ...e, hook_event_name: 'PreToolUse', session_id: await $.session.id(), cwd: await $.session.cwd(), tool_name: e.tool });
  return next(e);
}

// A failed hook still lets the event go on: next(e) replays the call it made, or makes the one it missed.
const passThrough = ($: any, e: any, next: any) => next(e);

export const register: Register = (on) => {
  on('classic.SessionStart', relay).catch(passThrough);
  on('classic.UserPromptSubmit', relay).catch(passThrough);
  on('classic.PreToolUse', relayToolUse).catch(passThrough);
  on('classic.PostToolUse', relay).catch(passThrough);
  on('classic.PermissionRequest', relay).catch(passThrough);
  on('classic.Notification', relay).catch(passThrough);
  on('classic.Stop', relay).catch(passThrough);
  on('classic.SessionEnd', relay).catch(passThrough);
};
