#!/usr/bin/env bash
# Run this extension in a nested GNOME Shell, isolated from the running
# session. See lib-sandbox.sh for what is isolated and why.
set -euo pipefail

UUID="window-groups@tom.devel"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX="${WG_SANDBOX:-$SRC/.sandbox}"
DISPLAY_NAME="${WG_WAYLAND_DISPLAY:-wg-test}"

# shellcheck source=lib-sandbox.sh
source "$SRC/lib-sandbox.sh"

rm -rf "$SANDBOX"
wg_sandbox_env "$SANDBOX"
wg_snapshot_x
trap 'wg_reap_x' EXIT

ln -sfn "$SRC" "$SANDBOX/share/gnome-shell/extensions/$UUID"
glib-compile-schemas "$SRC/schemas"

# Pre-enable the extension in the sandbox's own dconf database.
dbus-run-session -- gsettings set org.gnome.shell enabled-extensions "['$UUID']"
dbus-run-session -- gsettings set org.gnome.shell disable-user-extensions false
dbus-run-session -- gsettings set org.gnome.desktop.interface color-scheme "'prefer-dark'"

echo "sandbox        : $SANDBOX"
echo "runtime dir    : $XDG_RUNTIME_DIR"
echo "host compositor: $WAYLAND_DISPLAY"
echo "nested socket  : $DISPLAY_NAME"
echo "test apps      : ./spawn-test-apps.sh"

# GNOME 50 removed --nested; --devkit is the replacement. It opens a render
# node with no mode setting and never calls logind TakeControl, so it cannot
# acquire DRM master or take over your console.
dbus-run-session -- \
    gnome-shell --devkit --wayland --wayland-display="$DISPLAY_NAME" || true
