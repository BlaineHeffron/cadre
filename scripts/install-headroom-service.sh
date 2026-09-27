#!/usr/bin/env bash
set -euo pipefail

script_root="$(cd "$(dirname "$0")/.." && pwd)"
user_unit_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
headroom_binary="${HOME}/.local/bin/headroom"
if [[ ! -x "$headroom_binary" ]] || [[ "$("$headroom_binary" --version)" != 'headroom, version 0.37.0' ]]; then
    echo 'Headroom 0.37.0 is required: uv tool install --python 3.13 "headroom-ai[proxy]==0.37.0"' >&2
    exit 1
fi
mkdir -p "$user_unit_dir" "${HOME}/.local/share/dueno-headroom"
unit_file="$user_unit_dir/dueno-headroom.service"
changed=0
if [[ ! -f "$unit_file" ]] || ! cmp -s "$script_root/config/systemd/dueno-headroom.service" "$unit_file"; then
    install -m 0644 "$script_root/config/systemd/dueno-headroom.service" "$unit_file"
    changed=1
fi
systemctl --user daemon-reload
systemctl --user enable dueno-headroom.service
if [[ "$changed" == 1 ]]; then
    systemctl --user restart dueno-headroom.service
else
    systemctl --user start dueno-headroom.service
fi
for ((attempt = 0; attempt < 30; attempt++)); do
    if curl -fsS http://127.0.0.1:8787/readyz >/dev/null; then exit 0; fi
    sleep 1
done
echo 'Headroom did not become ready; inspect journalctl --user -u dueno-headroom.service' >&2
exit 1
