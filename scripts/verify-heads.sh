#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 )); then
  echo "Usage: bash scripts/verify-heads.sh <sha>..." >&2
  exit 2
fi

repo=$(git rev-parse --show-toplevel)
dev_clone=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
scratch=$(mktemp -d "${TMPDIR:-/tmp}/cadre-verify-heads.XXXXXX")
worktree="$scratch/worktree"
cleanup() {
  git -C "$repo" worktree remove --force "${worktree:?}" || true
  rm -rf "${scratch:?}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

git -C "$repo" fetch -q origin main
git -C "$repo" worktree add --detach "$worktree" origin/main
cd "$worktree"
for head in "$@"; do
  git -c user.name='Cadre verification' -c user.email='verify@localhost' merge --no-edit -- "$head"
done
ln -s "$dev_clone/node_modules" node_modules

mkdir -p "$HOME/.cadre"
exec 9>"$HOME/.cadre/heavy-test.lock"
flock 9
npm run check
status=0
npm test >"$scratch/tests.log" 2>&1 || status=$?
if (( status != 0 )); then
  cat "$scratch/tests.log"
else
  grep -E '^# (pass|fail|skipped) ' "$scratch/tests.log" || true
fi
exit "$status"
