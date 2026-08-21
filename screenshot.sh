#!/usr/bin/env bash
# Headless verification: start a sandboxed GNOME Shell on a virtual monitor,
# open a few windows, screenshot it, shut down. Nothing appears on the host
# screen, so this is safe to run while you are working.
#
# Usage: ./screenshot.sh [output.png]
#   WG_ARRANGEMENTS="['tabbed','free']"  preset per-group arrangements
set -euo pipefail

UUID="window-groups@tom.devel"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX="${WG_SANDBOX:-$SRC/.sandbox-headless}"
OUT="$(realpath -m "${1:-$SRC/shot.png}")"
RES="${WG_RESOLUTION:-1600x1000}"
NESTED_DISPLAY="wg-shot"

# shellcheck source=lib-sandbox.sh
source "$SRC/lib-sandbox.sh"

rm -rf "$SANDBOX"
wg_sandbox_env "$SANDBOX"
wg_snapshot_x
trap 'wg_reap_x' EXIT

# Headless needs no host compositor at all.
unset WAYLAND_DISPLAY DISPLAY

ln -sfn "$SRC" "$SANDBOX/share/gnome-shell/extensions/$UUID"
glib-compile-schemas "$SRC/schemas"

export UUID OUT RES NESTED_DISPLAY SANDBOX SRC
export WG_ARRANGEMENTS="${WG_ARRANGEMENTS:-}"

dbus-run-session -- bash -euo pipefail -c '
    gsettings set org.gnome.shell enabled-extensions "[\"$UUID\"]"
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.desktop.interface color-scheme "prefer-dark"
    if [ -n "${WG_ARRANGEMENTS:-}" ]; then
        GSETTINGS_SCHEMA_DIR="$SRC/schemas" gsettings \
            set org.gnome.shell.extensions.window-groups arrangements \
            "$WG_ARRANGEMENTS"
    fi

    gnome-shell --headless --virtual-monitor "$RES" \
        --wayland-display="$NESTED_DISPLAY" >"$SANDBOX/shell.log" 2>&1 &
    SHELL_PID=$!
    trap "kill $SHELL_PID 2>/dev/null; wait $SHELL_PID 2>/dev/null; true" EXIT

    for _ in $(seq 1 40); do
        gdbus introspect --session --dest org.gnome.Shell \
            --object-path /org/gnome/Shell >/dev/null 2>&1 && break
        sleep 1
    done

    export WAYLAND_DISPLAY="$NESTED_DISPLAY"
    for app in gnome-text-editor gnome-calculator; do
        command -v "$app" >/dev/null && setsid "$app" >/dev/null 2>&1 &
    done
    sleep 8

    "$SRC/screenshot-helper.py" "$OUT"
'

echo "wrote $OUT"
echo "shell log: $SANDBOX/shell.log"
