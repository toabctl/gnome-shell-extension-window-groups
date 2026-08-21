#!/usr/bin/env bash
# Run this extension in a nested GNOME Shell, fully isolated from the
# running session.
#
# Isolation that matters here: the extension writes to
# org.gnome.mutter dynamic-workspaces and
# org.gnome.desktop.wm.preferences workspace-names. Pointing XDG_CONFIG_HOME
# at a sandbox gives dconf its own user database, so those writes cannot
# reach your real session. dbus-run-session gives it its own session bus.
set -euo pipefail

UUID="window-groups@tom.devel"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX="${WG_SANDBOX:-$SRC/.sandbox}"
DISPLAY_NAME="${WG_WAYLAND_DISPLAY:-wg-test}"
RES="${WG_RESOLUTION:-1600x1000}"

rm -rf "$SANDBOX"
mkdir -p "$SANDBOX/config" "$SANDBOX/cache" "$SANDBOX/runtime" \
         "$SANDBOX/share/gnome-shell/extensions"
chmod 700 "$SANDBOX/runtime"

ln -sfn "$SRC" "$SANDBOX/share/gnome-shell/extensions/$UUID"
glib-compile-schemas "$SRC/schemas"

export XDG_DATA_HOME="$SANDBOX/share"
export XDG_CONFIG_HOME="$SANDBOX/config"
export XDG_CACHE_HOME="$SANDBOX/cache"
export XDG_STATE_HOME="$SANDBOX/state"

# Pre-enable the extension in the sandbox's dconf database.
dbus-run-session -- gsettings set org.gnome.shell enabled-extensions "['$UUID']"
dbus-run-session -- gsettings set org.gnome.shell disable-user-extensions false
dbus-run-session -- gsettings set org.gnome.desktop.interface color-scheme "'prefer-dark'"

echo "Nested shell: WAYLAND_DISPLAY=$DISPLAY_NAME  sandbox=$SANDBOX"
echo "Launch test apps with:  ./spawn-test-apps.sh"

# GNOME 50 dropped --nested; --devkit is the replacement and is what puts
# the shell in a window on the host. Keep the host WAYLAND_DISPLAY so it has
# somewhere to draw; --wayland-display names the *nested* socket.
exec dbus-run-session -- \
    gnome-shell --devkit --wayland --wayland-display="$DISPLAY_NAME"
