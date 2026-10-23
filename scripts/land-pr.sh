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
# `node_modules/` in .gitignore does not match the shared node_modules symlink, so exclude it.
if [[ -n $worktree && ( $(git -C "$worktree" rev-parse HEAD) != "$sha" ||
      -n $(git -C "$worktree" status --porcelain -- . ':!node_modules') ) ]]; then
  echo "Refusing to land PR $pr: worktree $worktree is not clean at $sha" >&2
  exit 1
fi
cd "$dev_clone"

state=$(gh pr view "$pr" --json headRefOid,headRefName,statusCheckRollup \
  --jq '"\(.headRefOid) \(.headRefName) \(.statusCheckRollup | length > 0 and all(.[]; (.conclusion // .state) == "SUCCESS"))"')
read -r head branch green <<<"$state"
if [[ $head != "$sha" || $green != true ]]; then
  echo "Refusing to land PR $pr: want head $sha with every check SUCCESS, got: $state" >&2
  exit 1
fi
gh pr merge "$pr" --merge --match-head-commit "$sha"
git fetch -q origin main
git merge-base --is-ancestor "$sha" origin/main

if [[ -n $worktree ]]; then
  if [[ -L $worktree/node_modules ]]; then rm "$worktree/node_modules"; fi
  git worktree remove --force "$worktree"
fi
if git show-ref -q --verify "refs/heads/$branch"; then git branch -q -D "$branch"; fi
remote_ref=$(git ls-remote --heads origin "refs/heads/$branch")
if [[ -n $remote_ref ]]; then git push -q origin --delete "$branch"; fi
gh pr view "$pr" --json mergeCommit --jq .mergeCommit.oid
git branch -r --no-merged origin/main >&2
}
main "$@"
