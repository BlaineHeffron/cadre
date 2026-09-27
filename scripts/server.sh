#!/bin/bash
# Manage the dueno-fleet systemd user service.
# Usage: scripts/server.sh [start|stop|restart|update|status|logs]
#
# dueno-fleet runs as a user service (systemctl --user) named dueno-fleet.
# It serves on 127.0.0.1:4310; expose it remotely through a private network
# proxy such as Tailscale Serve.
#
# The service runs from a dedicated worktree pinned to origin/main. Both
# `restart` and the legacy `update` alias sync that worktree, install deps,
# validate syntax, and restart.

set -euo pipefail

SERVICE="dueno-fleet"
ACTION="${1:-status}"
HEALTH_URL="http://127.0.0.1:4310/api/health/ready"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

live_dir() {
    if [[ -n "${CADRE_FLEET_LIVE_DIR:-${DUENO_FLEET_LIVE_DIR:-}}" ]]; then
        printf '%s\n' "${CADRE_FLEET_LIVE_DIR:-$DUENO_FLEET_LIVE_DIR}"
        return
    fi

    local workdir
    workdir="$(systemctl --user show "$SERVICE" -p WorkingDirectory --value 2>/dev/null || true)"
    if [[ -n "$workdir" && "$workdir" != "/" ]]; then
        printf '%s\n' "$workdir"
        return
    fi

    printf '%s\n' "$SCRIPT_ROOT"
}

live_sha() {
    local dir
    dir="$(live_dir)"
    git -C "$dir" rev-parse --short HEAD 2>/dev/null || echo unknown
}

show_health() {
    sleep 3
    echo -n "ready: "
    curl -s "$HEALTH_URL" 2>/dev/null | sed -E 's/.*"ready":(true|false).*/\1/' || echo "(no response)"
}

sync_live() {
    local live
    live="$(live_dir)"
    CADRE_FLEET_LIVE_DIR="$live" bash "$live/scripts/sync-main.sh"
}

install_agent_slice() {
    local live
    live="$(live_dir)"
    bash "$live/scripts/install-agent-slice.sh"
}

case "$ACTION" in
    start)
        install_agent_slice
        bash "$(live_dir)/scripts/install-headroom-service.sh" || echo 'Headroom unavailable; Settings can disable compression.' >&2
        systemctl --user start "$SERVICE"
        echo "Started $SERVICE"
        show_health
        ;;
    stop)
        systemctl --user stop "$SERVICE"
        echo "Stopped $SERVICE"
        ;;
    restart)
        sync_live
        install_agent_slice
        bash "$(live_dir)/scripts/install-headroom-service.sh" || echo 'Headroom unavailable; Settings can disable compression.' >&2
        systemctl --user restart "$SERVICE"
        echo "Restarted $SERVICE (live $(live_dir): $(live_sha))"
        show_health
        ;;
    update)
        sync_live
        install_agent_slice
        bash "$(live_dir)/scripts/install-headroom-service.sh" || echo 'Headroom unavailable; Settings can disable compression.' >&2
        systemctl --user restart "$SERVICE"
        echo "Updated $SERVICE (live $(live_dir): $(live_sha))"
        show_health
        ;;
    status)
        systemctl --user status "$SERVICE" --no-pager -l
        ;;
    logs)
        journalctl --user -u "$SERVICE" --no-pager -n "${2:-50}" -f
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|update|status|logs [N]}"
        exit 1
        ;;
esac
