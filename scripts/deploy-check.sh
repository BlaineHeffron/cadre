#!/usr/bin/env bash
# Restart production, then verify health and a clean journal since the restart.
# Usage: bash scripts/deploy-check.sh
# CADRE_RESTART_CMD overrides the restart; curl and journalctl resolve from PATH.
set -euo pipefail

dir=$(cd "$(dirname "$0")" && pwd)
service=$(sed -n 's/^SERVICE="\(.*\)"$/\1/p' "$dir/server.sh")
[[ -n $service ]] || { echo "deploy-check: no SERVICE in server.sh" >&2; exit 1; }
since=$(date '+%Y-%m-%d %H:%M:%S')
out=$(${CADRE_RESTART_CMD:-bash "$dir/server.sh" restart}) || { echo "$out" >&2; exit 1; }
echo "$out" >&2
sha=$(sed -n 's/.*(live .*: \([^)]*\))$/\1/p' <<<"$out")

for _ in 1 2 3 4 5 6 7 8 9 10; do
  health=$(curl -s -o /dev/null -w '%{http_code}' "http://${HOST:-127.0.0.1}:${PORT:-4310}/api/health" || true)
  [[ $health == 200 ]] && break
  sleep 1
done
journal=$(journalctl --user -u "$service" --since "$since" --no-pager -q -o cat)
lines=$(grep -c . <<<"$journal" || true)
errors=$(grep -cE '"level":(50|60)' <<<"$journal" || true)

echo "deploy-check: live ${sha:-unknown} health $health errors $errors ($lines journal lines from $service)"
if [[ $health != 200 || $errors != 0 || $lines == 0 ]]; then
  [[ $lines == 0 ]] && echo "deploy-check: journal for $service returned no lines since $since; the check is broken" >&2
  [[ $errors == 0 ]] || grep -E '"level":(50|60)' <<<"$journal" | tail -n 5 >&2
  exit 1
fi
