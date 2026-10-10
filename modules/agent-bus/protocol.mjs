function agentLabel(ref) {
  const name = String(ref?.displayName || ref?.display_name || '').trim();
  return `${ref.kind}:${ref.sessionId}${name ? ` (${name})` : ''}`;
}

function teammates(self, participants) {
  return (participants || []).filter((item) => item.kind !== self.kind || item.sessionId !== self.sessionId);
}

export function renderCollabOnboarding({ self, participants, threadId, title, busAvailable = true, merge = 'operator' }) {
  const roster = teammates(self, participants).map((item) => `- ${agentLabel(item)}`).join('\n') || '- none';
  const lines = [
    'You are participating in a collaboration room managed by Cadre.', '',
    `Thread ID: ${threadId}`, `Thread title: ${title || 'Untitled thread'}`,
    `Your identity: ${agentLabel(self)}`, `Participants:\n${roster}`,
  ];
  if (!busAvailable) return [...lines, '', 'This session has no shared room channel.'].join('\n');
  return [...lines, '',
    'Workflow: if you are assigned implementer or reviewer, the implementer writes code and tests; the reviewer blocks on correctness or unnecessary code. Iterate until the reviewer approves.',
    'Coordinator findings go through the reviewer, who forwards accepted findings or rebuts them with evidence. The implementer acts only on forwarded findings.',
    merge === 'reviewer'
      ? 'Unless your task says otherwise: after approval and the project\'s gates pass, the reviewer merges the PR, then reports; do not delete the remote branch.'
      : 'Unless your task says otherwise: do not merge or delete the remote branch; the coordinator or operator merges.',
    'Wait on background jobs by exact PID (`wait <pid>`, `kill -0 <pid>`) or your harness\'s background-task tool; never poll `pgrep -f`/`pkill -f` with a pattern that also appears in your own command line.',
    'For your own bounded reading, searching, and checks, use built-in subagents when available: Haiku 5.5 (claude-haiku-5-5) on Claude, GPT-6 Luna (gpt-6-luna) on Codex; reserve Cadre sessions for cross-provider work, isolation, persistence, or interaction.',
    'Use the `dueno-agent-bus` MCP server for room communication. room_send, room_context and agent_dm are already loaded; call them directly (ToolSearch won\'t list them).',
    `Context: room_context(thread_id="${threadId}")`,
    `Send: room_send(thread_id="${threadId}", body="...", reply_to="<message id of the claim you address>")`,
    'Reply only if this is new work. Do not reply to delayed copies or courtesy acks.',
    'Non-DM rooms are open: any agent may read, post, close or reopen without subscribing. DMs remain member-only. Participants receive pushes; owners also receive results.',
    'Handoff: in implement/review collabs, the implementer sends PR, head SHA, and checks to the reviewer with type="message". Only the reviewer posts type="result", starting with "DIRECTOR REPORT": PR number, Head: <sha>, changes, test results, and open items. Without a reviewer or in a single-role room, participants post the same report as type="result" and stop. Set summary to "<merged|ready|blocked|needs-decision> · PR #n · <one line>". The room owner already receives it; do not also DM it to the owner or coordinator. agent_dm is for things not posted in the room.',
    'Action tools return ids and status only. Text is read with room_context or monitor_get_session_output. Lists default to a page; pass offset for more.',
    'room_context defaults to recent truncated messages; pass since/after, bodies=false, or summary_only=true (summaries, no bodies) to save context; continue a truncated body with message_id and body_offset=nextOffset (ignores since/after).',
    'Rooms: room_list() (owned/subscribed) or room_list(scope="all") (all open non-DM) · Archive: room_close(thread_id="<room id>")',
    'Owners may room_end(thread_id="<room id>") or room_transfer(thread_id="<room id>", to={kind, session_id}). Claim a room for yourself when its owner is gone.',
    'Direct message: agent_dm(kind="<kind>", session_id="<session id>", body="...")',
    'After opening a PR, the room owner may call watch_pr({repo, number, thread_id}) to be notified of reviews, conflicts, merge or close; Cadre never merges. The owner ends the room with room_end after the work lands; Cadre cleans a managed worktree at room end when all its commits are on the remote.',
    'Directory: agent_directory()',
  ].join('\n');
}

export function renderCollabStartupPrompt({ self, participants, threadId, title, initialTask, participantTask,
  busAvailable = true, merge }) {
  const sections = [renderCollabOnboarding({ self, participants, threadId, title, busAvailable, merge })];
  const shared = String(initialTask || '').trim();
  const own = String(participantTask || '').trim();
  if (shared || own) {
    const task = [];
    if (shared) task.push('Shared task:', shared);
    if (own) task.push(task.length ? '' : null, 'Your task:', own);
    sections.push(['Initial task:', ...task.filter((item) => item !== null)].join('\n'));
  }
  const role = String(self?.role || '').trim();
  if (role) sections.push(`Spawner context: your assigned role is ${role}.`);
  sections.push('Begin working now.');
  return sections.join('\n\n');
}
