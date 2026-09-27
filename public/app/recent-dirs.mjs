// Recent work directories from prior agent spawns, newest first.
// Mirrors dueno-monitor-rust `recent_work_dirs_from_sessions`: sort sessions by
// last-used timestamp descending, dedup non-empty workDir, cap the list.

function sessionTimestamp(session) {
  return Number(
    session?.updatedAt
    ?? session?.lastActivity
    ?? session?.updated
    ?? session?.created
    ?? 0,
  ) || 0;
}

export function recentWorkDirs(sessionLists = [], limit = 6) {
  const sessions = []
    .concat(...sessionLists.map((list) => (Array.isArray(list) ? list : [])))
    .slice()
    .sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a));

  const recents = [];
  for (const session of sessions) {
    const path = String(session?.workDir || '').trim();
    if (!path || recents.includes(path)) continue;
    recents.push(path);
    if (recents.length >= limit) break;
  }
  return recents;
}
