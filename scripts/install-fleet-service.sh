#!/usr/bin/env bash
# Install/refresh the dueno-fleet user service so it runs from a dedicated
# worktree pinned to origin/main. Updates are explicit via scripts/server.sh update.
#
# Idempotent. Run after changing ports/paths or to (re)point the service at the
# live deploy dir. Creates the worktree if missing.
#
# Env overrides (legacy DUENO_FLEET_* names still work):
#   CADRE_FLEET_LIVE_DIR  deploy dir (default: <dev dir>-live)
#   CADRE_FLEET_DEV_DIR   dev clone whose state is symlinked in (default: main worktree of this repo)
#   CADRE_FLEET_PORT      http port (default: 4310)
#   CADRE_FLEET_MCP_PORT  agent-bus MCP http port (default: 8765)
#   CADRE_OSRELEASE_PATH  kernel release file checked for WSL (default: /proc/sys/kernel/osrelease)

set -euo pipefail

# Dev clone that holds the live runtime state (symlinked into the deploy dir).
# The main worktree, so it resolves the same whether run from the dev or live dir.
# The && makes a git failure fatal instead of silently deriving ".".
DEV_DIR="${CADRE_FLEET_DEV_DIR:-${DUENO_FLEET_DEV_DIR:-$(common="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --path-format=absolute --git-common-dir)" && dirname "$common")}}"
LIVE_DIR="${CADRE_FLEET_LIVE_DIR:-${DUENO_FLEET_LIVE_DIR:-$DEV_DIR-live}}"
PORT="${CADRE_FLEET_PORT:-${DUENO_FLEET_PORT:-4310}}"
MCP_PORT="${CADRE_FLEET_MCP_PORT:-${DUENO_FLEET_MCP_PORT:-8765}}"
BRANCH="${CADRE_FLEET_BRANCH:-${DUENO_FLEET_BRANCH:-main}}"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NODE_BIN="$(bash "$DEV_DIR/scripts/resolve-node-bin.sh")"
NPM_BIN="$(dirname "$NODE_BIN")/npm"

[[ -x "$NPM_BIN" ]] || { echo "npm is required beside $NODE_BIN"; exit 1; }
"$NODE_BIN" "$DEV_DIR/scripts/check-node-runtime.mjs"
bash "$DEV_DIR/scripts/install-agent-slice.sh"

# ── Ensure the live worktree exists and tracks origin/<branch> ────────────────
if [[ ! -e "$LIVE_DIR" ]]; then
  echo "Creating live worktree at $LIVE_DIR (detached at origin/$BRANCH)"
  git -C "$DEV_DIR" fetch origin --quiet
  # Detached, so the dev clone can stay on $BRANCH; sync-main.sh pins it to origin/$BRANCH either way.
  git -C "$DEV_DIR" worktree add --detach "$LIVE_DIR" "origin/$BRANCH"
fi

mkdir -p "$HOME/.dueno-fleet" "$DEV_DIR/.dueno" "$DEV_DIR/.agent_bus" "$DEV_DIR/agent_launch_logs"
if [[ "$DEV_DIR" == "$LIVE_DIR" ]]; then
  mkdir -p "$LIVE_DIR/.dueno" "$LIVE_DIR/.agent_bus" "$LIVE_DIR/agent_launch_logs"
fi

# ── Initial sync (reset to origin/main, install deps, link state) ─────────────
# Both names: the live checkout's sync-main.sh may predate the CADRE_ rename.
CADRE_FLEET_LIVE_DIR="$LIVE_DIR" CADRE_FLEET_STATE_SRC="$DEV_DIR" CADRE_FLEET_BRANCH="$BRANCH" \
DUENO_FLEET_LIVE_DIR="$LIVE_DIR" DUENO_FLEET_STATE_SRC="$DEV_DIR" DUENO_FLEET_BRANCH="$BRANCH" \
  bash "$LIVE_DIR/scripts/sync-main.sh"

# WSL2's user systemd cannot drop the capabilities these need: the unit fails with status=218/CAPABILITIES.
KERNEL_HARDENING=$'ProtectKernelTunables=true\nProtectKernelModules=true\nProtectControlGroups=true'
if grep -qi microsoft "${CADRE_OSRELEASE_PATH:-/proc/sys/kernel/osrelease}" 2>/dev/null; then KERNEL_HARDENING=''; fi

mkdir -p "$SYSTEMD_USER_DIR"
UNIT="$SYSTEMD_USER_DIR/dueno-fleet.service"
BACKUP_SERVICE="$SYSTEMD_USER_DIR/dueno-fleet-backup.service"
BACKUP_TIMER="$SYSTEMD_USER_DIR/dueno-fleet-backup.timer"
echo "Writing $UNIT"
cat >"$UNIT" <<EOF
[Unit]
Description=Cadre (Node) - agent fleet control plane
After=network-online.target dueno-agents.slice
Wants=network-online.target dueno-agents.slice
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=$LIVE_DIR
EnvironmentFile=-$LIVE_DIR/.env
Environment=HOME=$HOME
Environment=PATH=$(dirname "$NODE_BIN"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOST=127.0.0.1
Environment=PORT=$PORT
Environment=AGENT_BUS_MCP_HTTP_PORT=$MCP_PORT
Environment=TLS_ENABLED=false
Environment=CADRE_FLEET_STATE_SRC=$DEV_DIR
Environment=DUENO_FLEET_STATE_SRC=$DEV_DIR
ExecStartPre=$NODE_BIN scripts/check-node-runtime.mjs
ExecStartPre=$NODE_BIN scripts/check-syntax.mjs
ExecStart=$NODE_BIN server.mjs
Restart=on-failure
RestartSec=3
KillMode=process
# Sync (npm ci) can take a while on a cold cache.
TimeoutStartSec=300
PrivateTmp=false
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$HOME/.dueno-fleet $LIVE_DIR/.dueno $LIVE_DIR/.agent_bus $LIVE_DIR/agent_launch_logs $DEV_DIR/.dueno $DEV_DIR/.agent_bus $DEV_DIR/agent_launch_logs
ReadOnlyPaths=/var/log/auth.log
$KERNEL_HARDENING
RestrictSUIDSGID=true
MemoryDenyWriteExecute=false
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dueno-fleet

[Install]
WantedBy=default.target
EOF

echo "Writing $BACKUP_SERVICE"
cat >"$BACKUP_SERVICE" <<EOF
[Unit]
Description=Backup Cadre state

[Service]
Type=oneshot
WorkingDirectory=$LIVE_DIR
EnvironmentFile=-$LIVE_DIR/.env
Environment=HOME=$HOME
Environment=PATH=$(dirname "$NODE_BIN"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$NPM_BIN run backup:state
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$HOME/.dueno-fleet $LIVE_DIR/.dueno $DEV_DIR/.dueno
$KERNEL_HARDENING
RestrictSUIDSGID=true
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dueno-fleet-backup
EOF

echo "Writing $BACKUP_TIMER"
cat >"$BACKUP_TIMER" <<EOF
[Unit]
Description=Run Cadre state backups daily

[Timer]
OnCalendar=daily
RandomizedDelaySec=1800
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable dueno-fleet.service >/dev/null 2>&1 || true
echo "Enabling dueno-fleet-backup.timer"
systemctl --user enable dueno-fleet-backup.timer
echo "Starting dueno-fleet-backup.timer"
systemctl --user start dueno-fleet-backup.timer

echo
echo "Installed dueno-fleet user service -> $LIVE_DIR (pinned to origin/$BRANCH)"
echo "Installed dueno-fleet-backup.timer; verify with: systemctl --user list-timers dueno-fleet-backup.timer"
echo "  scripts/server.sh update    # syncs to origin/$BRANCH and restarts"
echo "  scripts/server.sh restart   # restarts without syncing"
echo "  scripts/server.sh logs"
