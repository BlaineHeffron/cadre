#!/usr/bin/env bash
# Back up GrapheneOS shared storage and copy phone recordings into Cadre's audio inbox.
# Runs once per physical connection. A disconnected poll clears the connection marker.
# Recordings import does not depend on the full backup destination being writable.

set -euo pipefail

ADB_BIN="${GRAPHENE_ADB_BIN:-$(command -v adb || true)}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/dueno-fleet/graphene-sync"
BACKUP_ROOT="${GRAPHENE_BACKUP_DIR:-$HOME/Shared/GrapheneOS}"
AUDIO_INBOX="${GRAPHENE_AUDIO_INBOX_DIR:-${CADRE_COMMAND_CENTER_AUDIO_INBOX_DIR:-${DM_COMMAND_CENTER_AUDIO_INBOX_DIR:-$HOME/.dueno-fleet/audio-inbox}}}"
PHONE_STORAGE_DIR="${GRAPHENE_PHONE_STORAGE_DIR:-/sdcard}"
PHONE_RECORDINGS_DIR="${GRAPHENE_PHONE_RECORDINGS_DIR:-/sdcard/Recordings}"
PHONE_SOUNDTREE_DIR="${GRAPHENE_PHONE_SOUNDTREE_DIR:-/sdcard/Android/data/app.soundtree/files/recordings}"
REQUESTED_SERIAL="${GRAPHENE_DEVICE_SERIAL:-}"
FORCE_SYNC="${GRAPHENE_FORCE_SYNC:-0}"

mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/sync.lock"
flock -n 9 || exit 0

if [[ -z "$ADB_BIN" ]]; then
  echo "graphene-sync: adb not found" >&2
  exit 1
fi

mapfile -t DEVICES < <("$ADB_BIN" devices | awk 'NR > 1 && $2 == "device" { print $1 }')
if [[ -n "$REQUESTED_SERIAL" ]]; then
  SERIAL=""
  for candidate in "${DEVICES[@]}"; do
    [[ "$candidate" == "$REQUESTED_SERIAL" ]] && SERIAL="$candidate"
  done
else
  SERIAL="${DEVICES[0]:-}"
fi

if [[ -z "$SERIAL" ]]; then
  rm -f "$STATE_DIR"/connected-*
  exit 0
fi

SAFE_SERIAL="$(printf '%s' "$SERIAL" | tr -c 'A-Za-z0-9_.-' '_')"
CONNECTED_MARKER="$STATE_DIR/connected-$SAFE_SERIAL"
if [[ -e "$CONNECTED_MARKER" && "$FORCE_SYNC" != "1" ]]; then
  exit 0
fi

DEVICE_ROOT="$BACKUP_ROOT/$SAFE_SERIAL"
SHARED_BACKUP="$DEVICE_ROOT/shared-storage"
PULL_ROOT="$STATE_DIR/recordings-pull/$SAFE_SERIAL"
mkdir -p "$AUDIO_INBOX" "$PULL_ROOT"

pull_remote_dir() {
  local remote_dir="$1"
  local dest="$2"
  rm -rf "$dest"
  mkdir -p "$dest"
  local err=""
  local status=0
  set +e
  err="$("$ADB_BIN" -s "$SERIAL" pull -a "$remote_dir/." "$dest/" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    return 0
  fi
  if [[ "$err" == *"does not exist"* || "$err" == *"No such file"* ]]; then
    echo "graphene-sync: recording directory absent: $remote_dir"
    return 0
  fi
  printf '%s\n' "$err" >&2
  return 1
}

import_audio_from() {
  local src="$1"
  local count=0
  [[ -d "$src" ]] || return 0
  while IFS= read -r -d '' audio; do
    # The transcription watcher consumes only inbox-root files. Recorder names contain
    # timestamps, so flattening SoundTree's year/month directories remains collision-safe.
    rsync -t "$audio" "$AUDIO_INBOX/$(basename "$audio")"
    count=$((count + 1))
  done < <(find "$src" -type f \
    \( -iname '*.m4a' -o -iname '*.mp3' -o -iname '*.wav' \) -print0)
  echo "graphene-sync: imported $count recordings from $src"
}

echo "graphene-sync: importing recordings from $SERIAL"
RECORDINGS_PULL="$PULL_ROOT/recordings"
SOUNDTREE_PULL="$PULL_ROOT/soundtree"
pull_remote_dir "$PHONE_RECORDINGS_DIR" "$RECORDINGS_PULL"
import_audio_from "$RECORDINGS_PULL"
if ! pull_remote_dir "$PHONE_SOUNDTREE_DIR" "$SOUNDTREE_PULL"; then
  echo "graphene-sync: SoundTree pull failed; continuing with shared recordings" >&2
else
  import_audio_from "$SOUNDTREE_PULL"
fi

if mkdir -p "$SHARED_BACKUP" 2>/dev/null && [[ -w "$SHARED_BACKUP" ]]; then
  echo "graphene-sync: backing up $SERIAL shared storage to $SHARED_BACKUP"
  if ! "$ADB_BIN" -s "$SERIAL" pull -a "$PHONE_STORAGE_DIR/." "$SHARED_BACKUP/"; then
    echo "graphene-sync: shared storage backup failed" >&2
  fi
else
  echo "graphene-sync: backup destination not writable: $BACKUP_ROOT" >&2
fi

date --iso-8601=seconds >"$STATE_DIR/last-successful-sync.txt"
if [[ -w "$DEVICE_ROOT" ]] 2>/dev/null; then
  date --iso-8601=seconds >"$DEVICE_ROOT/last-successful-sync.txt" || true
fi
touch "$CONNECTED_MARKER"
echo "graphene-sync: complete"
