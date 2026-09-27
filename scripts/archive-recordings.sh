#!/usr/bin/env bash
# Move old, transcribed audio out of the live inbox. Transcripts remain in place.

set -euo pipefail

INBOX="${FLEET_AUDIO_INBOX:-${CADRE_COMMAND_CENTER_AUDIO_INBOX_DIR:-${DM_COMMAND_CENTER_AUDIO_INBOX_DIR:-$HOME/.dueno-fleet/audio-inbox}}}"
ARCHIVE_MOUNT="${FLEET_RECORDING_ARCHIVE_MOUNT:?set FLEET_RECORDING_ARCHIVE_MOUNT to the archive drive mount point}"
ARCHIVE_ROOT="${FLEET_RECORDING_ARCHIVE_DIR:-$ARCHIVE_MOUNT/Dueno Recordings Archive}"
MIN_AGE_DAYS="${FLEET_RECORDING_ARCHIVE_MIN_AGE_DAYS:-30}"
DRY_RUN="${FLEET_RECORDING_ARCHIVE_DRY_RUN:-0}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/dueno-fleet/recording-archive"

[[ "$MIN_AGE_DAYS" =~ ^[0-9]+$ ]] || { echo "archive-recordings: age must be whole days" >&2; exit 1; }
[[ -d "$INBOX" ]] || { echo "archive-recordings: inbox missing: $INBOX" >&2; exit 1; }
mountpoint -q "$ARCHIVE_MOUNT" || { echo "archive-recordings: shared drive not mounted: $ARCHIVE_MOUNT" >&2; exit 1; }
command -v rsync >/dev/null || { echo "archive-recordings: rsync required" >&2; exit 1; }

mkdir -p "$STATE_DIR" "$ARCHIVE_ROOT"
exec 9>"$STATE_DIR/archive.lock"
flock -n 9 || exit 0

archived=0
skipped=0
while IFS= read -r -d '' audio; do
  stem="${audio%.*}"
  transcript=""
  for extension in txt md vtt srt; do
    if [[ -f "$stem.$extension" ]]; then
      transcript="$stem.$extension"
      break
    fi
  done
  if [[ -z "$transcript" ]]; then
    echo "archive-recordings: keep without transcript: $audio"
    skipped=$((skipped + 1))
    continue
  fi

  mtime="$(stat -c %Y "$audio")"
  bucket="$(date -d "@$mtime" +%Y/%m)"
  destination_dir="$ARCHIVE_ROOT/$bucket"
  destination="$destination_dir/$(basename "$audio")"

  if [[ -e "$destination" ]] && ! cmp -s "$audio" "$destination"; then
    extension="${audio##*.}"
    base="$(basename "${audio%.*}")"
    digest="$(sha256sum "$audio" | awk '{ print substr($1, 1, 12) }')"
    destination="$destination_dir/${base}-${digest}.${extension}"
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "archive-recordings: would archive: $audio -> $destination"
    archived=$((archived + 1))
    continue
  fi

  mkdir -p "$destination_dir"
  if [[ -e "$destination" ]] && cmp -s "$audio" "$destination"; then
    unlink "$audio"
  else
    rsync -t --protect-args --remove-source-files "$audio" "$destination"
  fi
  echo "archive-recordings: archived: $audio -> $destination; kept $transcript"
  archived=$((archived + 1))
done < <(find "$INBOX" -maxdepth 1 -type f \
  \( -iname '*.m4a' -o -iname '*.mp3' -o -iname '*.wav' \) \
  -mmin "+$((MIN_AGE_DAYS * 1440))" -print0)

echo "archive-recordings: done archived=$archived skipped=$skipped min_age_days=$MIN_AGE_DAYS dry_run=$DRY_RUN"
