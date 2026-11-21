# Cadre never merges pull requests

The operator wants a human-in-the-loop merge, so the server itself never merges: `watch_pr` only notifies about reviews, conflicts, CI and merge or close, and a PR merge never ends a room. The operator merges, or a coordinator does through `scripts/land-pr.sh` (which refuses unless the head matches and every check passed) only after an operator answer from the Command Queue; the reviewer merges only in repos whose `.cadre/worktree.json` sets `merge: reviewer`.

## Considered Options

- Auto-merge on green (GitHub auto-merge or a `watch_pr` merge action on a clean review) was rejected to keep that human-in-the-loop merge.
