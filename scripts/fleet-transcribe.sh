#!/usr/bin/env bash
# Transcribe local audio blobs in the dueno-fleet audio inbox to sibling .txt files.
#
# Env overrides:
#   FLEET_AUDIO_INBOX          target directory, default ~/.dueno-fleet/audio-inbox
#   FLEET_TRANSCRIBE_ENGINE    whisper-cpp (default) | faster-whisper
#   FLEET_WHISPER_BIN          engine binary, default whisper-cli or faster-whisper
#   FLEET_WHISPER_MODEL        model path/name, default base.en
#   FLEET_TRANSCRIBE_LANG      language hint, default en
#   FLEET_TRANSCRIBE_GLOB      shell globs, default "*.m4a *.mp3 *.wav"
#   FLEET_TRANSCRIBE_MIN_AGE_SEC skip audio modified more recently than this, default 0
#   FLEET_WHISPER_DEVICE       faster-whisper device, default cpu
#   FLEET_WHISPER_COMPUTE_TYPE faster-whisper compute type, default int8
#
# Exits 3 when the engine is unavailable (binary, interpreter, or python package missing).

set -euo pipefail

check_only=0
if [[ "${1:-}" == "--check" ]]; then
  check_only=1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

expand_path() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${1:2}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

has_transcript() {
  local stem="$1"
  [[ -e "${stem}.txt" || -e "${stem}.md" || -e "${stem}.vtt" || -e "${stem}.srt" ]]
}

transcribe_whisper_cpp() {
  local audio="$1"
  local tmpbase="$2"
  "$bin" -m "$model" -l "$lang" -f "$audio" -otxt -of "$tmpbase" >/dev/null || return
  [[ -s "${tmpbase}.txt" ]]
}

transcribe_faster_whisper() {
  local audio="$1"
  local tmpbase="$2"
  local tmpdir tmpoutdir produced
  tmpdir="$(dirname "$tmpbase")"
  tmpoutdir="$(mktemp -d "${tmpdir}/.faster-whisper.XXXXXX")"
  "$bin" "$audio" --model "$model" --language "$lang" --output_dir "$tmpoutdir" --output_format txt \
    --device "$device" --compute_type "$compute_type" >/dev/null || {
    local status=$?
    rm -rf "$tmpoutdir"
    return "$status"
  }
  produced="${tmpoutdir}/$(basename "${audio%.*}").txt"
  [[ -s "$produced" ]] && mv "$produced" "${tmpbase}.txt"
  rm -rf "$tmpoutdir"
  [[ -s "${tmpbase}.txt" ]]
}

# Resolve the SAME inbox fleet ingest scans: prefer FLEET_AUDIO_INBOX, fall back to fleet's
# DM_COMMAND_CENTER_AUDIO_INBOX_DIR, then the shared default. Keeps record/transcribe/ingest aligned.
inbox="$(expand_path "${FLEET_AUDIO_INBOX:-${CADRE_COMMAND_CENTER_AUDIO_INBOX_DIR:-${DM_COMMAND_CENTER_AUDIO_INBOX_DIR:-~/.dueno-fleet/audio-inbox}}}")"
engine="${FLEET_TRANSCRIBE_ENGINE:-whisper-cpp}"
model="${FLEET_WHISPER_MODEL:-base.en}"
lang="${FLEET_TRANSCRIBE_LANG:-en}"
glob_text="${FLEET_TRANSCRIBE_GLOB:-*.m4a *.mp3 *.wav}"
min_age_sec="${FLEET_TRANSCRIBE_MIN_AGE_SEC:-0}"
device="${FLEET_WHISPER_DEVICE:-cpu}"
compute_type="${FLEET_WHISPER_COMPUTE_TYPE:-int8}"

case "$engine" in
  whisper-cpp) bin="${FLEET_WHISPER_BIN:-whisper-cli}" ;;
  faster-whisper) bin="${FLEET_WHISPER_BIN:-$script_dir/faster-whisper-cli.sh}" ;;
  *) echo "Unsupported FLEET_TRANSCRIBE_ENGINE: $engine" >&2; exit 1 ;;
esac

if (( check_only == 0 )) && ! command -v "$bin" >/dev/null 2>&1; then
  echo "$bin is required" >&2
  exit 3
fi

if [[ ! -d "$inbox" ]]; then
  echo "Audio inbox missing: $inbox" >&2
  exit 1
fi

shopt -s nullglob
read -r -a globs <<< "$glob_text"
processed=0
skipped=0
failed=0
unavailable=0

for pattern in "${globs[@]}"; do
  for audio in "$inbox"/$pattern; do
    [[ -f "$audio" ]] || continue
    stem="${audio%.*}"
    out="${stem}.txt"
    if (( min_age_sec > 0 )); then
      mtime="$(stat -c %Y "$audio")"
      now="$(date +%s)"
      age=$((now - mtime))
      if (( age < min_age_sec )); then
        echo "skip fresh audio: $audio age=${age}s min_age=${min_age_sec}s"
        skipped=$((skipped + 1))
        continue
      fi
    fi
    if has_transcript "$stem"; then
      echo "skip existing transcript: $audio"
      skipped=$((skipped + 1))
      continue
    fi
    if (( check_only == 1 )); then
      echo "would transcribe: $audio -> $out"
      processed=$((processed + 1))
      continue
    fi
    tmpbase="${out}.tmp.$$"
    rm -f "${tmpbase}.txt"
    if (
      case "$engine" in
        whisper-cpp) transcribe_whisper_cpp "$audio" "$tmpbase" ;;
        faster-whisper) transcribe_faster_whisper "$audio" "$tmpbase" ;;
      esac
    ); then
      mv "${tmpbase}.txt" "$out"
      echo "transcribed: $audio -> $out"
      processed=$((processed + 1))
    else
      # 3 = faster-whisper package missing; 126/127 = engine interpreter missing.
      [[ "$?" =~ ^(3|126|127)$ ]] && unavailable=1
      rm -f "${tmpbase}.txt"
      echo "transcription failed: $audio" >&2
      failed=$((failed + 1))
      continue
    fi
  done
done

echo "done processed=$processed skipped=$skipped failed=$failed"
if (( unavailable > 0 )); then
  exit 3
fi
if (( failed > 0 )); then
  exit 1
fi
