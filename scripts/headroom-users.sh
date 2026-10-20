#!/usr/bin/env bash
# Prints how many of this user's processes have the Headroom proxy URL in their environment.
# Exits non-zero when /proc can't be read (e.g. non-Linux) so callers keep the proxy running.
set -euo pipefail

proc="${HEADROOM_PROC_DIR:-/proc}"
compgen -G "$proc/[0-9]*/environ" >/dev/null || exit 1
count=0
for environ in "$proc"/[0-9]*/environ; do
    [[ -O "$environ" && "$environ" != "$proc/$$/environ" ]] || continue
    if grep -qaF '=http://127.0.0.1:8787' "$environ" 2>/dev/null; then count=$((count + 1)); fi
done
echo "$count"
