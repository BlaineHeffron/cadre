#!/usr/bin/env bash
# Install an automatic, per-user GrapheneOS USB sync timer.
# Usage: GRAPHENE_BACKUP_DIR=/path/on/shared/drive bash scripts/install-graphene-phone-sync.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dueno-fleet"
ENV_FILE="$CONFIG_DIR/graphene-phone-sync.env"
BACKUP_DIR="${GRAPHENE_BACKUP_DIR:-$HOME/Shared/GrapheneOS}"
AUDIO_INBOX="${GRAPHENE_AUDIO_INBOX_DIR:-${CADRE_COMMAND_CENTER_AUDIO_INBOX_DIR:-${DM_COMMAND_CENTER_AUDIO_INBOX_DIR:-$HOME/.dueno-fleet/audio-inbox}}}"
PHONE_STORAGE_DIR="${GRAPHENE_PHONE_STORAGE_DIR:-/sdcard}"
PHONE_RECORDINGS_DIR="${GRAPHENE_PHONE_RECORDINGS_DIR:-/sdcard/Recordings}"
PHONE_SOUNDTREE_DIR="${GRAPHENE_PHONE_SOUNDTREE_DIR:-/sdcard/Android/data/app.soundtree/files/recordings}"

command -v adb >/dev/null || { echo "adb required (install Android platform-tools)" >&2; exit 1; }
command -v rsync >/dev/null || { echo "rsync required" >&2; exit 1; }

mkdir -p "$SYSTEMD_USER_DIR" "$CONFIG_DIR" "$BACKUP_DIR" "$AUDIO_INBOX"
chmod +x "$REPO_DIR/scripts/graphene-phone-sync.sh"

printf 'GRAPHENE_BACKUP_DIR=%q\n' "$BACKUP_DIR" >"$ENV_FILE"
printf 'GRAPHENE_AUDIO_INBOX_DIR=%q\n' "$AUDIO_INBOX" >>"$ENV_FILE"
printf 'GRAPHENE_PHONE_STORAGE_DIR=%q\n' "$PHONE_STORAGE_DIR" >>"$ENV_FILE"
printf 'GRAPHENE_PHONE_RECORDINGS_DIR=%q\n' "$PHONE_RECORDINGS_DIR" >>"$ENV_FILE"
printf 'GRAPHENE_PHONE_SOUNDTREE_DIR=%q\n' "$PHONE_SOUNDTREE_DIR" >>"$ENV_FILE"
if [[ -n "${GRAPHENE_DEVICE_SERIAL:-}" ]]; then
  printf 'GRAPHENE_DEVICE_SERIAL=%q\n' "$GRAPHENE_DEVICE_SERIAL" >>"$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

SERVICE="$SYSTEMD_USER_DIR/dueno-graphene-sync.service"
TIMER="$SYSTEMD_USER_DIR/dueno-graphene-sync.timer"

printf '%s\n' \
  '[Unit]' \
  'Description=Back up connected GrapheneOS phone and import recordings' \
  '' \
  '[Service]' \
  'Type=oneshot' \
  'KillMode=process' \
  "EnvironmentFile=$ENV_FILE" \
  "ExecStart=$REPO_DIR/scripts/graphene-phone-sync.sh" \
  >"$SERVICE"

printf '%s\n' \
  '[Unit]' \
  'Description=Detect GrapheneOS USB connections' \
  '' \
  '[Timer]' \
  'OnBootSec=15s' \
  'OnUnitActiveSec=20s' \
  'AccuracySec=2s' \
  '' \
  '[Install]' \
  'WantedBy=timers.target' \
  >"$TIMER"

systemctl --user daemon-reload
systemctl --user enable --now dueno-graphene-sync.timer

echo "Installed GrapheneOS sync timer"
echo "Backup: $BACKUP_DIR"
echo "Recordings inbox: $AUDIO_INBOX"
echo "Phone: enable Developer options > USB debugging, connect, unlock, and authorize this computer"
echo "Test: GRAPHENE_FORCE_SYNC=1 systemctl --user start dueno-graphene-sync.service"
