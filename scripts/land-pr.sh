#!/usr/bin/env bash
set -euo pipefail

main() {
if (( $# < 2 || $# > 3 )); then
  echo "Usage: bash scripts/land-pr.sh <pr> <sha> [worktree-path]" >&2
  exit 2
fi

pr=$1
sha=$2
worktree=${3:+$(realpath "$3")}
dev_clone=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
cd "$dev_clone"

state=$(gh pr view "$pr" --json headRefOid,statusCheckRollup \
  --jq '"\(.headRefOid) \(.statusCheckRollup | length > 0 and all(.[]; (.conclusion // .state) == "SUCCESS"))"')
if [[ $state != "$sha true" ]]; then
  echo "Refusing to land PR $pr: want head $sha with every check SUCCESS, got: $state" >&2
  exit 1
fi
# gh cannot delete a local branch that a worktree has checked out, so remove the worktree first.
if [[ -n $worktree ]]; then
  if [[ -L $worktree/node_modules ]]; then rm "$worktree/node_modules"; fi
  git worktree remove --force "$worktree"
fi
gh pr merge "$pr" --merge --delete-branch --match-head-commit "$sha"
git fetch -q origin main
git merge-base --is-ancestor "$sha" origin/main
git branch -r --no-merged origin/main
}
main "$@"
