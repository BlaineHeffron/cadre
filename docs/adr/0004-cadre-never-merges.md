# Cadre never merges pull requests

Cadre runs many agents unattended, so the server itself never merges: `watch_pr` only notifies about reviews, conflicts, CI and merge or close, and a PR merge never ends a room. Merging is an explicit act by the operator or a coordinator (through `scripts/land-pr.sh`, which refuses unless the head matches and every check passed), or by the reviewer only in repos whose `.cadre/worktree.json` sets `merge: reviewer`.
