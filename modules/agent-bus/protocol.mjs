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
    'Wait on background jobs by exact PID (`wait <pid>`, `kill -0 <pid>`) or your harness\'s background-task tool; wait on a long command with one call and a long timeout, not repeated sleeps; never find or kill processes by matching their full command line with `pgrep`/`pkill`, since that can hit other agents.',
    'When a read, search, or check is large enough to crowd your context, delegate it to a built-in subagent when available: Haiku (model: "haiku") on Claude, GPT-6 Luna (gpt-6-luna) on Codex; otherwise do it yourself. Cadre sessions and rooms are for collaboration between agents or work the operator interacts with separately.',
    'To wait on a teammate, end your turn; Cadre delivers room messages when you are idle. Do not sleep or poll room_context for replies.',
    'Use the `dueno` MCP server for room communication; its tool descriptions cover rooms, DMs, paging and ownership.',
    `Context: room_context(thread_id="${threadId}")`,
    `Send: room_send(thread_id="${threadId}", body="...", reply_to="<message id of the claim you address>")`,
    'Reply only if this is new work. Do not reply to delayed copies or courtesy acks.',
    'Handoff: in implement/review collabs, the implementer sends PR, head SHA, and checks to the reviewer with type="message". Only the reviewer posts type="result", starting with "DIRECTOR REPORT": PR number, Head: <sha>, changes, test results, and open items. Without a reviewer or in a single-role room, participants post the same report as type="result" and stop. Set summary to "<merged|ready|blocked|needs-decision> · PR #n · <one line>". The room owner already receives it; do not also DM it to the owner or coordinator. agent_dm is for things not posted in the room.',
    'After opening a PR, the room owner may call watch_pr({repo, number, thread_id}) to be notified of reviews, conflicts, CI results, merge or close; fix failed checks, push and keep watching. Cadre never merges. The owner ends the room with room_end after the work lands; Cadre cleans a managed worktree at room end when all its commits are on the remote.',
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
