#!/usr/bin/env bash
# Launch a few windows inside the nested shell started by run-nested.sh.
set -euo pipefail

export WAYLAND_DISPLAY="${WG_WAYLAND_DISPLAY:-wg-test}"
unset DISPLAY

launch() {
    if command -v "$1" >/dev/null 2>&1; then
        echo "launching $*"
        setsid "$@" >/dev/null 2>&1 &
    else
        echo "skip (not installed): $1"
    fi
}

launch gnome-text-editor
launch gnome-calculator
launch nautilus --new-window
launch ptyxis

cat <<'NOTE'

To test an XWayland client, run one from the terminal *inside* the nested
shell — it inherits that session's own DISPLAY, which is not visible from
out here. For example:

    sudo apt install x11-apps xterm     # once, on the host
    xterm                               # inside the nested session

Then check `xprop` / the sidebar behaves identically for it.
NOTE

wait
