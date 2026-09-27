#!/usr/bin/env bash
# Run the repo faster-whisper CLI through the local dueno-fleet venv.

set -euo pipefail

venv_python="${FLEET_TRANSCRIBE_PYTHON:-$HOME/.dueno-fleet/transcribe-venv/bin/python}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec "$venv_python" "$script_dir/faster-whisper-cli.py" "$@"
