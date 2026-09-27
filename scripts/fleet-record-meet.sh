#!/usr/bin/env bash
# Record system/browser audio plus mic into the dueno-fleet audio inbox.
#
# Env overrides:
#   FLEET_AUDIO_INBOX       target directory, default ~/.dueno-fleet/audio-inbox
#   FLEET_RECORD_SINK       Pulse/PipeWire sink name, default pactl get-default-sink
#   FLEET_RECORD_SOURCE     Pulse/PipeWire source name, default pactl get-default-source
#   FLEET_RECORD_BASENAME   output stem, default meet-YYYYmmdd-HHMMSS
#   FLEET_RECORD_BITRATE    AAC bitrate, default 64k

set -euo pipefail

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required" >&2
  exit 1
fi

if ! command -v pactl >/dev/null 2>&1; then
  echo "pactl is required" >&2
  exit 1
fi

expand_path() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${1:2}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

inbox="$(expand_path "${FLEET_AUDIO_INBOX:-${CADRE_COMMAND_CENTER_AUDIO_INBOX_DIR:-${DM_COMMAND_CENTER_AUDIO_INBOX_DIR:-~/.dueno-fleet/audio-inbox}}}")"
sink="${FLEET_RECORD_SINK:-$(pactl get-default-sink)}"
source="${FLEET_RECORD_SOURCE:-$(pactl get-default-source)}"
monitor="${sink}.monitor"
basename="${FLEET_RECORD_BASENAME:-meet-$(date +%Y%m%d-%H%M%S)}"
bitrate="${FLEET_RECORD_BITRATE:-64k}"
outfile="${inbox}/${basename}.m4a"

mkdir -p "$inbox"

echo "Recording Meet audio"
echo "  system: $monitor"
echo "  mic:    $source"
echo "  out:    $outfile"
echo "Stop with Ctrl-C."

ffmpeg \
  -hide_banner \
  -f pulse -i "$monitor" \
  -f pulse -i "$source" \
  -filter_complex "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[a]" \
  -map "[a]" \
  -ac 1 -ar 16000 \
  -c:a aac -b:a "$bitrate" \
  "$outfile"
