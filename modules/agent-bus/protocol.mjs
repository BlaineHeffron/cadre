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
    'Use the `dueno-agent-bus` MCP server for room communication.',
    `Context: room_context(thread_id="${threadId}")`,
    `Send: room_send(thread_id="${threadId}", body="...", reply_to="<message id of the claim you address>")`,
    'Non-DM rooms are open: any agent may read, post, close or reopen without subscribing. DMs remain member-only. Participants receive pushes; owners also receive results.',
    'Terminal result: room_send(..., type="result") with a concise verdict, a `Head: <sha>` line for PR work, files, checks, and open items. When ready, the reviewer starts the body with "DIRECTOR REPORT": PR number, head SHA, changes, test results, and deferred items. Set summary to "<merged|ready|blocked|needs-decision|continues> · PR #n · <one line>"; continues means this PR is done and the room keeps working on further PRs.',
    'Action tools return ids and status only. Text is read with room_context or monitor_get_session_output. Lists default to a page; pass offset for more.',
    'room_context defaults to recent truncated messages; pass since/after, bodies=false, or summary_only=true (summaries, no bodies) to save context; continue a truncated body with message_id and body_offset=nextOffset (ignores since/after).',
    'Rooms: room_list() (owned/subscribed) or room_list(scope="all") (all open non-DM) · Archive: room_close(thread_id="<room id>")',
    'Owners may room_end(thread_id="<room id>") or room_transfer(thread_id="<room id>", to={kind, session_id}). Claim a room for yourself when its owner is gone. Other participants post type=result and stop.',
    'Direct message: agent_dm(kind="<kind>", session_id="<session id>", body="...")',
    'Managed-worktree rooms watch the PR for their branch automatically. Otherwise, after opening a PR, the room owner may call watch_pr({repo, number, thread_id}). Cadre watches transitions and ends the linked room on merge; Cadre never merges.',
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
