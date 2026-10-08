function formatAgentRef(ref) {
  return `${ref?.kind || 'unknown'}:${ref?.sessionId || 'unknown'}`;
}

function parentSnippet(parent) {
  if (!parent) return null;
  const body = String(parent.body || '').trim().replace(/\s+/g, ' ');
  const snippet = body.length > 240 ? `${body.slice(0, 240)}…` : body;
  return `In reply to ${parent.id} (${formatAgentRef(parent.from)}): ${snippet}`;
}

export function busMessageMarker(message) {
  return `id=${message?.id || 'unknown'}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sessionHasBusMessage(content, message) {
  const id = String(message?.id || '').trim();
  if (!id || !content) return false;
  return new RegExp(`(?:^|[\\s\\[])id=${escapeRegExp(id)}(?:[\\s\\]])`).test(String(content));
}

export function messageSummary(message) {
  const own = typeof message.metadata?.summary === 'string' ? message.metadata.summary.trim() : '';
  const line = (own || String(message.body || '').split(/\r?\n/).find((line) => line.trim()) || '').trim().replace(/\s+/g, ' ');
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

export function renderBusEnvelope(message, parent = null) {
  const dm = message.metadata?.dm === true;
  const marker = busMessageMarker(message);
  const opening = dm
    ? `[DM ${marker} from=${formatAgentRef(message.from)}]`
    : `[ROOM_MESSAGE ${marker} room=${message.threadId} from=${formatAgentRef(message.from)}]`;
  const closing = dm ? '[/DM]' : '[/ROOM_MESSAGE]';
  const reply = [
    `Tool: room_send(thread_id="${message.threadId}", body="...", reply_to="<id if answering a claim>") · Context: room_context(thread_id="${message.threadId}")`,
    'Reply only if this is new work. Do not reply to delayed copies or courtesy acks.'
  ].join('\n');
  const body = String(message.body || '');
  // A returned spawn result arrives whole, like a subagent's answer.
  const content = body.length > 1200 && message.type !== 'startup_prompt' && !(dm && message.type === 'result')
    ? `Summary: ${messageSummary(message)}\nBody length: ${body.length} characters\nFull body: room_context(thread_id="${message.threadId}", message_id="${message.id}")`
    : body.trim();
  const type = message.type && message.type !== 'message' ? `Type: ${message.type}` : null;
  return [opening, parentSnippet(parent), type, content, closing, reply].filter((line) => line != null && line !== '').join('\n');
}
