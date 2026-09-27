#!/usr/bin/env bash
# Install daily archival of old, transcribed Cadre recordings.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dueno-fleet"
ENV_FILE="$CONFIG_DIR/recording-archive.env"
INBOX="${FLEET_AUDIO_INBOX:-${CADRE_COMMAND_CENTER_AUDIO_INBOX_DIR:-${DM_COMMAND_CENTER_AUDIO_INBOX_DIR:-$HOME/.dueno-fleet/audio-inbox}}}"
ARCHIVE_MOUNT="${FLEET_RECORDING_ARCHIVE_MOUNT:?set FLEET_RECORDING_ARCHIVE_MOUNT to the archive drive mount point}"
ARCHIVE_DIR="${FLEET_RECORDING_ARCHIVE_DIR:-$ARCHIVE_MOUNT/Dueno Recordings Archive}"
MIN_AGE_DAYS="${FLEET_RECORDING_ARCHIVE_MIN_AGE_DAYS:-30}"

mountpoint -q "$ARCHIVE_MOUNT" || { echo "Shared drive not mounted: $ARCHIVE_MOUNT" >&2; exit 1; }
mkdir -p "$SYSTEMD_USER_DIR" "$CONFIG_DIR" "$ARCHIVE_DIR"
chmod +x "$REPO_DIR/scripts/archive-recordings.sh"

printf 'FLEET_AUDIO_INBOX=%q\n' "$INBOX" >"$ENV_FILE"
printf 'FLEET_RECORDING_ARCHIVE_MOUNT=%q\n' "$ARCHIVE_MOUNT" >>"$ENV_FILE"
printf 'FLEET_RECORDING_ARCHIVE_DIR=%q\n' "$ARCHIVE_DIR" >>"$ENV_FILE"
printf 'FLEET_RECORDING_ARCHIVE_MIN_AGE_DAYS=%q\n' "$MIN_AGE_DAYS" >>"$ENV_FILE"
chmod 600 "$ENV_FILE"

SERVICE="$SYSTEMD_USER_DIR/dueno-recording-archive.service"
TIMER="$SYSTEMD_USER_DIR/dueno-recording-archive.timer"
printf '%s\n' \
  '[Unit]' \
  'Description=Archive old transcribed Cadre recordings' \
  '' \
  '[Service]' \
  'Type=oneshot' \
  "EnvironmentFile=$ENV_FILE" \
  "ExecStart=$REPO_DIR/scripts/archive-recordings.sh" \
  >"$SERVICE"

printf '%s\n' \
  '[Unit]' \
  'Description=Archive old Cadre recordings daily' \
  '' \
  '[Timer]' \
  'OnCalendar=daily' \
  'RandomizedDelaySec=30m' \
  'Persistent=true' \
  '' \
  '[Install]' \
  'WantedBy=timers.target' \
  >"$TIMER"

systemctl --user daemon-reload
systemctl --user enable --now dueno-recording-archive.timer
echo "Installed recording archive timer: $ARCHIVE_DIR; age=$MIN_AGE_DAYS days"
