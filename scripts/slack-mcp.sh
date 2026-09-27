#!/usr/bin/env bash
# Runs the self-hosted Slack MCP server the fleet's `slack` catalog entry
# points at in local mode. Acts as the operator's existing Slack user — no
# workspace-admin app install — so it works in workspaces they belong to
# but do not own.
#
#   scripts/slack-mcp.sh serve      # run in the foreground
#   scripts/slack-mcp.sh install    # systemd user unit, enabled at boot
#   scripts/slack-mcp.sh status     # is it up?
#   scripts/slack-mcp.sh logs       # journal for the unit
#   scripts/slack-mcp.sh uninstall  # stop and remove the unit
#
# Auth is one of:
#   SLACK_MCP_XOXC_TOKEN + SLACK_MCP_XOXD_TOKEN   (browser session, any workspace)
#   SLACK_MCP_XOXP_TOKEN                          (user OAuth, workspace you can install on)
#   SLACK_MCP_XOXB_TOKEN                          (bot, invited channels only)
#
# Tokens live in the fleet .env. The agent never sees them.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${CADRE_FLEET_ENV_FILE:-${DUENO_FLEET_ENV_FILE:-$REPO_DIR/.env}}"
SERVICE="slack-mcp"
UNIT_PATH="$HOME/.config/systemd/user/$SERVICE.service"
PACKAGE="${SLACK_MCP_PACKAGE:-slack-mcp-server@latest}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

PORT="${SLACK_MCP_PORT:-13080}"
HOST="${SLACK_MCP_HOST:-127.0.0.1}"

npx_bin() {
  command -v npx 2>/dev/null || printf '%s\n' "$(command -v npx || true)"
}

has_user_token() {
  [[ -n "${SLACK_MCP_XOXP_TOKEN:-${CADRE_MCP_SLACK_XOXP_TOKEN:-${DM_MCP_SLACK_XOXP_TOKEN:-}}}" ]]
}

has_bot_token() {
  [[ -n "${SLACK_MCP_XOXB_TOKEN:-${CADRE_MCP_SLACK_XOXB_TOKEN:-${DM_MCP_SLACK_XOXB_TOKEN:-}}}" ]]
}

has_session_tokens() {
  local xoxc="${SLACK_MCP_XOXC_TOKEN:-${CADRE_MCP_SLACK_XOXC_TOKEN:-${DM_MCP_SLACK_XOXC_TOKEN:-}}}"
  local xoxd="${SLACK_MCP_XOXD_TOKEN:-${CADRE_MCP_SLACK_XOXD_TOKEN:-${DM_MCP_SLACK_XOXD_TOKEN:-}}}"
  [[ -n "$xoxc" && -n "$xoxd" ]]
}

require_tokens() {
  if has_user_token || has_bot_token || has_session_tokens; then
    return 0
  fi
  echo "Set SLACK_MCP_XOXC_TOKEN + SLACK_MCP_XOXD_TOKEN (browser session) or SLACK_MCP_XOXP_TOKEN in $ENV_FILE" >&2
  echo "See docs/mcp-servers.md (Slack setup)." >&2
  exit 1
}

require_npx() {
  if [[ ! -x "$(npx_bin)" ]]; then
    echo "npx not found. Install Node.js (fleet already requires >=22)." >&2
    exit 1
  fi
}

listening() {
  # Streamable HTTP GET stays open; a short initialize POST returns immediately.
  curl -sS -o /dev/null -m 2 -X POST "http://${HOST}:${PORT}/mcp" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"dueno-fleet","version":"0"}}}' \
    >/dev/null 2>&1
}

export_token_aliases() {
  # The server only reads SLACK_MCP_* names. Accept DM_MCP_SLACK_* too.
  if [[ -z "${SLACK_MCP_XOXP_TOKEN:-}" && -n "${CADRE_MCP_SLACK_XOXP_TOKEN:-${DM_MCP_SLACK_XOXP_TOKEN:-}}" ]]; then
    export SLACK_MCP_XOXP_TOKEN="${CADRE_MCP_SLACK_XOXP_TOKEN:-$DM_MCP_SLACK_XOXP_TOKEN}"
  fi
  if [[ -z "${SLACK_MCP_XOXB_TOKEN:-}" && -n "${CADRE_MCP_SLACK_XOXB_TOKEN:-${DM_MCP_SLACK_XOXB_TOKEN:-}}" ]]; then
    export SLACK_MCP_XOXB_TOKEN="${CADRE_MCP_SLACK_XOXB_TOKEN:-$DM_MCP_SLACK_XOXB_TOKEN}"
  fi
  if [[ -z "${SLACK_MCP_XOXC_TOKEN:-}" && -n "${CADRE_MCP_SLACK_XOXC_TOKEN:-${DM_MCP_SLACK_XOXC_TOKEN:-}}" ]]; then
    export SLACK_MCP_XOXC_TOKEN="${CADRE_MCP_SLACK_XOXC_TOKEN:-$DM_MCP_SLACK_XOXC_TOKEN}"
  fi
  if [[ -z "${SLACK_MCP_XOXD_TOKEN:-}" && -n "${CADRE_MCP_SLACK_XOXD_TOKEN:-${DM_MCP_SLACK_XOXD_TOKEN:-}}" ]]; then
    export SLACK_MCP_XOXD_TOKEN="${CADRE_MCP_SLACK_XOXD_TOKEN:-$DM_MCP_SLACK_XOXD_TOKEN}"
  fi
}

case "${1:-status}" in
  serve)
    require_tokens
    require_npx
    export_token_aliases
    export SLACK_MCP_HOST="$HOST"
    export SLACK_MCP_PORT="$PORT"
    exec "$(npx_bin)" -y "$PACKAGE" --transport http
    ;;

  install)
    require_tokens
    require_npx
    if [[ "$PORT" != "13080" ]]; then
      echo "note: port $PORT — set DM_MCP_SLACK_LOCAL_URL to match." >&2
    fi
    mkdir -p "$(dirname "$UNIT_PATH")"
    cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=Slack MCP (self-hosted, acts as the operator Slack user)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=$HOME
EnvironmentFile=-$ENV_FILE
Environment=HOME=$HOME
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=SLACK_MCP_HOST=$HOST
Environment=SLACK_MCP_PORT=$PORT
ExecStart=$REPO_DIR/scripts/slack-mcp.sh serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable --now "$SERVICE"
    echo "installed: $UNIT_PATH"
    systemctl --user --no-pager --lines=0 status "$SERVICE" || true
    ;;

  uninstall)
    systemctl --user disable --now "$SERVICE" 2>/dev/null || true
    rm -f "$UNIT_PATH"
    systemctl --user daemon-reload
    echo "removed: $UNIT_PATH"
    ;;

  status)
    systemctl --user --no-pager --lines=0 status "$SERVICE" 2>/dev/null || true
    if listening; then
      echo "up: http://${HOST}:${PORT}/mcp"
    else
      echo "down: http://${HOST}:${PORT}/mcp" >&2
      exit 1
    fi
    ;;

  logs)
    exec journalctl --user -u "$SERVICE" -n "${2:-100}" -f
    ;;

  *)
    echo "usage: $0 {serve|install|uninstall|status|logs}" >&2
    exit 2
    ;;
esac
