#!/usr/bin/env bash
# Runs the self-hosted Google Workspace MCP server the fleet's google-* catalog
# entries point at. Needs an ordinary Google Cloud OAuth client — no Workspace
# Developer Preview enrollment.
#
#   scripts/google-workspace-mcp.sh serve      # run in the foreground
#   scripts/google-workspace-mcp.sh install    # systemd user unit, enabled at boot
#   scripts/google-workspace-mcp.sh status     # is it up?
#   scripts/google-workspace-mcp.sh logs       # journal for the unit
#   scripts/google-workspace-mcp.sh uninstall  # stop and remove the unit
#
# GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET come from the fleet .env.
# The Google grant itself is cached under ~/.google_workspace_mcp/credentials/
# by the server, so consent happens once and later restarts are headless.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${CADRE_FLEET_ENV_FILE:-${DUENO_FLEET_ENV_FILE:-$REPO_DIR/.env}}"
SERVICE="google-workspace-mcp"
UNIT_PATH="$HOME/.config/systemd/user/$SERVICE.service"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

PORT="${WORKSPACE_MCP_PORT:-8000}"
# Every service the server knows about. Narrow with WORKSPACE_MCP_TOOLS if a
# smaller consent surface is wanted.
TIER="${WORKSPACE_MCP_TOOL_TIER:-extended}"
TOOLS="${WORKSPACE_MCP_TOOLS:-}"
READ_ONLY="${WORKSPACE_MCP_READ_ONLY:-0}"

server_args() {
  local args=(--transport streamable-http --tool-tier "$TIER")
  if [[ -n "$TOOLS" ]]; then
    # shellcheck disable=SC2206
    local tools=($TOOLS)
    args+=(--tools "${tools[@]}")
  fi
  [[ "$READ_ONLY" == "1" ]] && args+=(--read-only)
  printf '%s\n' "${args[@]}"
}

uvx_bin() {
  command -v uvx 2>/dev/null || printf '%s\n' "$HOME/.local/bin/uvx"
}

require_client() {
  if [[ -z "${GOOGLE_OAUTH_CLIENT_ID:-}" || -z "${GOOGLE_OAUTH_CLIENT_SECRET:-}" ]]; then
    echo "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set in $ENV_FILE" >&2
    exit 1
  fi
  if [[ ! -x "$(uvx_bin)" ]]; then
    echo "uvx not found. Install uv: https://docs.astral.sh/uv/getting-started/installation/" >&2
    exit 1
  fi
}

listening() {
  # A rejected GET still proves the listener is alive, so any HTTP answer counts.
  curl -sS -o /dev/null -m 2 "http://127.0.0.1:${PORT}/mcp" >/dev/null 2>&1
}

case "${1:-status}" in
  serve)
    require_client
    export WORKSPACE_MCP_PORT="$PORT"
    # Loopback only, so the OAuth callback may use plain HTTP.
    export OAUTHLIB_INSECURE_TRANSPORT="${OAUTHLIB_INSECURE_TRANSPORT:-1}"
    mapfile -t args < <(server_args)
    exec "$(uvx_bin)" workspace-mcp "${args[@]}"
    ;;

  install)
    require_client
    if [[ "$PORT" != "8000" ]]; then
      echo "note: port $PORT — set DM_MCP_GOOGLE_LOCAL_URL to match and re-register the redirect URI." >&2
    fi
    mapfile -t args < <(server_args)
    mkdir -p "$(dirname "$UNIT_PATH")"
    cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=Google Workspace MCP (self-hosted, serves the fleet google-* catalog entries)
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
Environment=WORKSPACE_MCP_PORT=$PORT
# Loopback only, so the OAuth callback may use plain HTTP.
Environment=OAUTHLIB_INSECURE_TRANSPORT=1
ExecStart=$(uvx_bin) workspace-mcp ${args[*]}
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
      echo "up: http://127.0.0.1:${PORT}/mcp"
    else
      echo "down: http://127.0.0.1:${PORT}/mcp" >&2
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
