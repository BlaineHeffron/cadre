#!/usr/bin/env bash

# Print a Node binary satisfying Cadre's runtime contract.
# Prefer the project-pinned NVM installation over the caller's PATH.

set -euo pipefail

REQUIRED_NODE_VERSION="22.19.0"
NVM_ROOT="${NVM_DIR:-${HOME}/.nvm}"
CANDIDATES=(
  "$NVM_ROOT/versions/node/v$REQUIRED_NODE_VERSION/bin/node"
  "$(command -v node 2>/dev/null || true)"
)

version_at_least() {
  local actual="$1"
  local required="$2"
  local lowest
  lowest="$(printf '%s\n%s\n' "$required" "$actual" | sort -V | head -n 1)"
  [[ "$lowest" == "$required" ]]
}

for candidate in "${CANDIDATES[@]}"; do
  [[ -n "$candidate" && -x "$candidate" ]] || continue
  version="$("$candidate" --version 2>/dev/null | sed 's/^v//')"
  if version_at_least "$version" "$REQUIRED_NODE_VERSION"; then
    printf '%s\n' "$candidate"
    exit 0
  fi
done

echo "Node.js >=$REQUIRED_NODE_VERSION is required; install it or activate it on PATH" >&2
exit 1
