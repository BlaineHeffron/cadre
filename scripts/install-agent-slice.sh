#!/usr/bin/env bash
# Install the aggregate cgroup used by transient per-session agent scopes.

set -euo pipefail

SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
SLICE_UNIT="$SYSTEMD_USER_DIR/dueno-agents.slice"
TASKS_MAX="${CADRE_AGENTS_SLICE_TASKS_MAX:-${DUENO_AGENTS_SLICE_TASKS_MAX:-8192}}"
MEMORY_HIGH="${CADRE_AGENTS_SLICE_MEMORY_HIGH:-${DUENO_AGENTS_SLICE_MEMORY_HIGH:-32G}}"
MEMORY_MAX="${CADRE_AGENTS_SLICE_MEMORY_MAX:-${DUENO_AGENTS_SLICE_MEMORY_MAX:-40G}}"

[[ "$TASKS_MAX" =~ ^[0-9]+$ ]] || { echo "Invalid DUENO_AGENTS_SLICE_TASKS_MAX" >&2; exit 1; }
[[ "$MEMORY_HIGH" =~ ^[0-9]+[KMGTPE]?$ ]] || { echo "Invalid DUENO_AGENTS_SLICE_MEMORY_HIGH" >&2; exit 1; }
[[ "$MEMORY_MAX" =~ ^[0-9]+[KMGTPE]?$ ]] || { echo "Invalid DUENO_AGENTS_SLICE_MEMORY_MAX" >&2; exit 1; }

mkdir -p "$SYSTEMD_USER_DIR"
temporary_unit="$(mktemp "$SYSTEMD_USER_DIR/.dueno-agents.slice.XXXXXX")"
trap 'rm -f "$temporary_unit"' EXIT
cat >"$temporary_unit" <<EOF
[Unit]
Description=Cadre managed agent workloads

[Slice]
TasksMax=$TASKS_MAX
MemoryHigh=$MEMORY_HIGH
MemoryMax=$MEMORY_MAX
EOF

if [[ ! -f "$SLICE_UNIT" ]] || ! cmp -s "$temporary_unit" "$SLICE_UNIT"; then
  chmod 0644 "$temporary_unit"
  mv "$temporary_unit" "$SLICE_UNIT"
fi
systemctl --user daemon-reload
systemctl --user start dueno-agents.slice

