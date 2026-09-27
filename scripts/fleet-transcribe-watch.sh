#!/usr/bin/env bash
# Periodically transcribe new audio in the dueno-fleet audio inbox.

set -euo pipefail

interval="${FLEET_TRANSCRIBE_INTERVAL_SEC:-30}"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "fleet transcribe watcher started interval=${interval}s"

while true; do
  if ! "$repo_dir/scripts/fleet-transcribe.sh"; then
    echo "fleet transcribe scan failed; retrying after interval" >&2
  fi
  sleep "$interval"
done
