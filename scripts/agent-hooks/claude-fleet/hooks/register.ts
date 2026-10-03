import type { Register } from 'claude-code';

// Forwards the events Cadre's session-state hook slot maps (modules/session-state/providers/hook.mjs)
// to scripts/agent-hooks/log-event.mjs, the recorder the per-session command hooks ran.

// One reporter at a time keeps events in order; the tool and the turn never wait on it.
let queue: Promise<unknown> = Promise.resolve();

function record($: any, payload: object) {
  queue = queue
    .then(() => $.process.run(['node', `${$.plugin.root}/../log-event.mjs`, '--provider', 'claude'], {
      stdin: JSON.stringify(payload),
    }))
    .catch(() => {});
  return queue;
}

async function relay($: any, e: any, next: any) {
  const recorded = record($, e);
  // The process exits after SessionEnd, so its record must land first.
  if (e.hook_event_name === 'SessionEnd') await recorded;
  return next(e);
}

// PreToolUse arrives as the tool-call envelope, without the classic base fields.
async function relayToolUse($: any, e: any, next: any) {
  record($, { hook_event_name: 'PreToolUse', session_id: await $.session.id(), cwd: await $.session.cwd(), tool_name: e.tool, ...e });
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
