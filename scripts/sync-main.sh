#!/usr/bin/env bash
# Sync the live deploy directory to origin/main, (re)install deps, and link
# runtime state in from the dev clone. Idempotent — safe to run on every start.
#
# Used by scripts/install-fleet-service.sh and scripts/server.sh update so the
# live worktree can be updated explicitly, outside the hardened systemd unit.
#
# Env overrides:
#   DUENO_FLEET_LIVE_DIR    deploy dir (default: this script's repo root)
#   DUENO_FLEET_STATE_SRC   dir to symlink runtime state from (default: main worktree of the live dir's repo)
#   DUENO_FLEET_BRANCH      ref to track (default: main)
#   DUENO_FLEET_NO_INSTALL  set to 1 to skip npm install

set -euo pipefail

LIVE_DIR="${CADRE_FLEET_LIVE_DIR:-${DUENO_FLEET_LIVE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}}"
STATE_SRC="${CADRE_FLEET_STATE_SRC:-${DUENO_FLEET_STATE_SRC:-$(dirname "$(git -C "$LIVE_DIR" rev-parse --path-format=absolute --git-common-dir)")}}"
BRANCH="${CADRE_FLEET_BRANCH:-${DUENO_FLEET_BRANCH:-main}}"

log() { echo "[sync-main] $*"; }

NODE_BIN="$(bash "$LIVE_DIR/scripts/resolve-node-bin.sh")"
NPM_BIN="$(dirname "$NODE_BIN")/npm"
"$NODE_BIN" "$LIVE_DIR/scripts/check-node-runtime.mjs"

# ── 1. Fast-forward the live worktree to origin/<branch> ──────────────────────
if [[ ! -d "$LIVE_DIR/.git" && ! -f "$LIVE_DIR/.git" ]]; then
  log "ERROR: $LIVE_DIR is not a git worktree/clone"
  exit 1
fi
log "fetching origin"
git -C "$LIVE_DIR" fetch origin --quiet
TARGET="$(git -C "$LIVE_DIR" rev-parse --short "origin/$BRANCH")"
CURRENT="$(git -C "$LIVE_DIR" rev-parse --short HEAD)"
if [[ "$TARGET" != "$CURRENT" ]]; then
  log "resetting $CURRENT -> origin/$BRANCH ($TARGET)"
  git -C "$LIVE_DIR" reset --hard "origin/$BRANCH" --quiet
else
  log "already at origin/$BRANCH ($TARGET)"
fi

# ── 2. Install deps only when the lockfile changed (keeps restarts fast) ──────
if [[ "${CADRE_FLEET_NO_INSTALL:-${DUENO_FLEET_NO_INSTALL:-0}}" != "1" ]]; then
  LOCK="$LIVE_DIR/package-lock.json"
  STAMP="$LIVE_DIR/node_modules/.sync-lock-hash"
  WANT="$( [ -f "$LOCK" ] && sha1sum "$LOCK" | cut -d' ' -f1 || echo nolock )"
  HAVE="$( [ -f "$STAMP" ] && cat "$STAMP" || echo none )"
  if [[ ! -d "$LIVE_DIR/node_modules" || "$WANT" != "$HAVE" ]]; then
    log "installing dependencies (npm ci)"
    if ! ( cd "$LIVE_DIR" && "$NPM_BIN" ci --no-audit --no-fund ); then
      log "npm ci failed; falling back to npm install"
      ( cd "$LIVE_DIR" && "$NPM_BIN" install --no-audit --no-fund )
    fi
    echo "$WANT" > "$STAMP"
  else
    log "dependencies up to date"
  fi
fi

# ── 3. Validate before systemd starts the server ─────────────────────────────
log "checking syntax"
"$NODE_BIN" "$LIVE_DIR/scripts/check-syntax.mjs"
# Claude sessions report lifecycle hooks through this plugin; an invalid one silently drops them.
log "validating claude fleet plugin"
claude plugin validate "$LIVE_DIR/scripts/agent-hooks/claude-fleet" >/dev/null

# ── 4. Symlink runtime state from the dev clone (no data loss) ────────────────
# Everything git-ignored at the repo root is runtime state (env, certs, agent
# bus, notes, the various .json state files). Link each into the live dir so the
# deploy shares the existing dashboard data instead of starting empty.
if [[ -d "$STATE_SRC" && "$STATE_SRC" != "$LIVE_DIR" ]]; then
  # .env is ignored too but listed here explicitly in case the ignore set changes.
  mapfile -t IGNORED < <(git -C "$STATE_SRC" ls-files --others --ignored --exclude-standard --directory 2>/dev/null \
    | grep -vE '^(node_modules/|\.git/)' \
    | sed 's:/$::' \
    | grep -vE '/' \
    | grep -vE '\.tmp(\.|$)')
  # Include bare .env / certs dir explicitly (top-level only).
  for extra in .env certs; do
    [[ -e "$STATE_SRC/$extra" ]] && IGNORED+=("$extra")
  done
  linked=0
  for entry in $(printf '%s\n' "${IGNORED[@]}" | sort -u); do
    src="$STATE_SRC/$entry"
    dst="$LIVE_DIR/$entry"
    [[ -e "$src" ]] || continue
    [[ "$entry" == "node_modules" ]] && continue
    # If a real (non-symlink) file/dir exists in live, leave it (tracked file).
    if [[ -L "$dst" ]]; then
      continue
    elif [[ -e "$dst" ]]; then
      # Tracked path also present in repo — don't clobber.
      continue
    fi
    ln -s "$src" "$dst"
    linked=$((linked + 1))
  done
  log "linked $linked state entr$([ "$linked" -eq 1 ] && echo y || echo ies) from $STATE_SRC"
fi

log "synced to $(git -C "$LIVE_DIR" rev-parse --short HEAD)"
