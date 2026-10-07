# Captured pane corpus

Real tmux pane tails used to characterize session-state detection before any
regex or stability changes.

```sh
tmux capture-pane -t <session> -p -e -S -200
```

Live tails are trimmed to the composer/status region plus a little content
above it. Spinner, composer, separator, and footer lines are byte-verbatim.
Only content above that chrome was shortened, then scanned for secrets.

| `source` | Meaning |
| --- | --- |
| `live-tmux` | Trimmed tail of a live pane (ANSI intact) |
| `live-derived` | Live chrome with one injected **content** line |
| `reconstructed` | Rare state that was not on host. Characterization only — never `knownDefect` |

`exited` is reconstructed-only. Do not grow that
allowlist; shrink it when a live capture exists.

Same-session idle+active pairs:

- `claude-f609b0f7` — `· Osmosing…` mid-tool, then idle (`✻ Worked for 4m 23s`)
- `claude-e3b3717a` — `✶ Moseying…` thinking, then idle after a usage-limit stop
- `pi-5427de06` — `⠋ Working...`, then idle

Delivery-latency captures (2026-10-05): `claude-26fb796d-idle-viewport`
and `claude-26fb796d-idle-scrollback` are consecutive reads of the same idle
24-row pane, with viewport-only and `-S -200` capture depths. The latter is
trimmed to 41 rows to retain the depth difference without excess history.
`codex-e5ea5b75-background-terminal` preserves a live interruptible terminal
wait with a command and tip between its status marker and composer.

`manifest.json` records **current** detector output and the **intended**
classification. `knownDefect: true` means those disagree on purpose. Later
commits should flip `current*` to match `intended*` — do not "fix" a defect by
editing the pane.
