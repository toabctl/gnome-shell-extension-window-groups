#!/usr/bin/env bash
# Test the extension in a full Ubuntu 26.04 desktop VM under LXD.
#
# Unlike run-nested.sh this is a real kernel with a real GDM login, so it can
# exercise what the nested harness cannot: session start/restore, whether
# dynamic-workspaces and workspace-names survive logout/login, and what
# actually happens when gnome-shell dies. It also cannot touch the host
# session at all — different kernel, different everything.
#
# Prerequisite (needs root, run once):
#     sudo lxd init --auto --storage-backend=dir
#
# Usage:
#     ./run-lxd.sh up          create/start the VM and install the extension
#     ./run-lxd.sh sync        re-push the extension and restart the shell
#     ./run-lxd.sh console     open the interactive desktop (needs virt-viewer)
#     ./run-lxd.sh shot F.png  grab a screenshot from inside the guest
#     ./run-lxd.sh res 2.0     re-pin the guest resolution if it goes tiny
#     ./run-lxd.sh demo        put windows in every group, one per arrangement
#     ./run-lxd.sh state       dump what the extension believes, as JSON
#     ./run-lxd.sh log         tail the guest shell journal
#     ./run-lxd.sh down        stop the VM
#     ./run-lxd.sh destroy     delete the VM
set -euo pipefail

VM="${WG_VM:-wg-vm}"
UUID="window-groups@toabctl.de"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${WG_IMAGE:-images:ubuntu/26.04/desktop}"
EXT_DIR="/home/GUEST/.local/share/gnome-shell/extensions/$UUID"

die() { echo "error: $*" >&2; exit 1; }

require_lxd() {
    command -v lxc >/dev/null || die "lxc not found"
    if [ -z "$(lxc storage list --format csv 2>/dev/null)" ]; then
        die "LXD has no storage pool. Run once:  sudo lxd init --auto --storage-backend=dir"
    fi
}

guest_user() {
    lxc exec "$VM" -- getent passwd 1000 | cut -d: -f1
}

# Run a command as the desktop user, attached to their live session bus.
as_user() {
    local u; u="$(guest_user)"
    lxc exec "$VM" -- sudo -u "$u" \
        env DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/1000/bus" \
            XDG_RUNTIME_DIR="/run/user/1000" \
        "$@"
}

wait_for_agent() {
    echo -n "waiting for lxd-agent"
    for _ in $(seq 1 120); do
        if lxc exec "$VM" -- true 2>/dev/null; then echo " ok"; return 0; fi
        echo -n .; sleep 2
    done
    echo; die "lxd-agent never came up"
}

wait_for_session() {
    echo -n "waiting for a graphical session"
    for _ in $(seq 1 90); do
        # The bus socket alone is not enough: it lingers after a session dies,
        # which made this return ok while the guest sat at the gdm greeter.
        # Require a live shell owned by the desktop user as well.
        if lxc exec "$VM" -- test -S /run/user/1000/bus 2>/dev/null &&
           lxc exec "$VM" -- pgrep -u 1000 -f "gnome-shell --mode" >/dev/null 2>&1; then
            echo " ok"; return 0
        fi
        echo -n .; sleep 2
    done
    echo; die "no logged-in graphical session (guest may be at the gdm greeter)"
}

push_extension() {
    local u; u="$(guest_user)"
    local dest="/home/$u/.local/share/gnome-shell/extensions/$UUID"

    lxc exec "$VM" -- rm -rf "$dest"
    lxc exec "$VM" -- install -d -o "$u" -g "$u" "$dest"
    tar -C "$SRC" -cf - \
        --exclude=.git --exclude='.sandbox*' --exclude='*.png' . \
        | lxc exec "$VM" -- tar -C "$dest" -xf -
    lxc exec "$VM" -- chown -R "$u:$u" "$dest"
    lxc exec "$VM" -- glib-compile-schemas "$dest/schemas"
    echo "pushed extension to $dest"
}

enable_extension() {
    as_user gnome-extensions enable "$UUID" || true
    echo "guest GNOME: $(lxc exec "$VM" -- gnome-shell --version)"
    as_user gnome-extensions info "$UUID" | grep -iE "state|version" || true
}

cmd_up() {
    require_lxd
    if ! lxc info "$VM" >/dev/null 2>&1; then
        echo "launching $VM from $IMAGE (this pulls ~1.4 GiB)"
        lxc launch "$IMAGE" "$VM" --vm \
            -c limits.cpu=4 -c limits.memory=8GiB \
            -d root,size=30GiB
    else
        lxc start "$VM" 2>/dev/null || true
    fi
    wait_for_agent
    wait_for_session
    quiesce_session
    unlock_session
    push_extension
    enable_extension
    echo
    echo "Open the desktop with:  ./run-lxd.sh console"
}

cmd_sync() {
    require_lxd
    push_extension
    # Disabling and re-enabling is NOT enough: GJS caches the ES module, so
    # extension.js is only imported once per shell lifetime. Wayland has no
    # shell restart either, so the session itself has to go. Cheap in a VM.
    # `systemctl restart gdm` is not reliable here — autologin does not always
    # re-fire and the guest lands on the greeter. A reboot is ~30s and always
    # comes back to a clean session.
    echo "rebooting the guest (GJS module cache forces a full restart)"
    lxc restart "$VM"
    wait_for_agent
    wait_for_session
    quiesce_session
    # Autologin re-enables it, but make sure.
    as_user gnome-extensions enable "$UUID" || true
    sleep 3
    as_user gnome-extensions info "$UUID" | grep -i state || true
}

# Pin the guest's mode and scale. Without this the desktop is unreadable:
# the SPICE agent resizes the VM to whatever the client window is, which
# lands on a huge mode at scale 1.0 and shrinks every UI element.
cmd_res() {
    local scale="${1:-2.0}" mode="${2:-3840x2160}"
    as_user python3 \
        "/home/$(guest_user)/.local/share/gnome-shell/extensions/$UUID/guest-display.py" \
        "$scale" "$mode"
}

# Populate every group, so the console opens on something worth looking at:
# each arrangement side by side rather than every window piling into group 1.
#
# New windows land on the active workspace, and a group *is* a workspace, so
# the only way to place them is to switch first. There is no external API for
# that, hence the synthetic keypresses.
DEMO_GROUPS=(columns free notes)
DEMO_COLORS=(green yellow purple)
DEMO_APPS=(
    "nautilus gnome-disks baobab"      # columns: three tiles
    "gnome-text-editor yelp"           # free: left alone
    "gnome-calculator seahorse"        # free: left alone
)
DEMO_ARRANGEMENTS=(columns free free)

# Ask the extension what it believes, rather than inferring it. Mutter only
# maintains the EWMH _NET_CURRENT_DESKTOP property once X11 clients exist, so
# reading it from the XWayland root is unreliable on a fresh session.
wg_dbus() {
    local method="$1"; shift
    as_user gdbus call --session \
        --dest org.gnome.Shell \
        --object-path /de/toabctl/WindowGroups \
        --method "de.toabctl.WindowGroups.$method" "$@" 2>/dev/null
}

# On the lock screen GNOME runs in unlock-dialog mode, where user extensions
# are INACTIVE — so everything here silently stops working until it is
# unlocked. Idle locking is disabled at setup, but a VM resumed from an old
# state can still come back locked.
unlock_session() {
    as_user gdbus call --session --dest org.gnome.ScreenSaver \
        --object-path /org/gnome/ScreenSaver \
        --method org.gnome.ScreenSaver.SetActive false >/dev/null 2>&1 || true
}

session_locked() {
    as_user gdbus call --session --dest org.gnome.ScreenSaver \
        --object-path /org/gnome/ScreenSaver \
        --method org.gnome.ScreenSaver.GetActive 2>/dev/null | grep -q true
}

enable_debug_iface() {
    local u; u="$(guest_user)"
    if session_locked; then
        echo "  guest was locked; unlocking (extensions do not run on the"
        echo "  lock screen)"
        unlock_session
        sleep 2
    fi
    as_user env GSETTINGS_SCHEMA_DIR="/home/$u/.local/share/gnome-shell/extensions/$UUID/schemas" \
        gsettings set org.gnome.shell.extensions.window-groups debug-interface true
    for _ in $(seq 1 20); do
        wg_dbus GetState >/dev/null 2>&1 && return 0
        sleep 0.5
    done
    echo "extension state: $(as_user gnome-extensions info "$UUID" | grep -i state)" >&2
    die "the debug interface never appeared. If the state above is INACTIVE the\
 guest is probably locked or at the greeter, where user extensions do not run."
}

# A test VM should never blank, lock or suspend: all three make the extension
# INACTIVE and every check here fail in a way that looks like a code bug.
quiesce_session() {
    as_user gsettings set org.gnome.desktop.screensaver lock-enabled false
    as_user gsettings set org.gnome.desktop.screensaver idle-activation-enabled false
    as_user gsettings set org.gnome.desktop.session idle-delay 0
    as_user gsettings set org.gnome.settings-daemon.plugins.power \
        sleep-inactive-ac-type nothing
    as_user gsettings set org.gnome.settings-daemon.plugins.power \
        sleep-inactive-battery-type nothing
}

cmd_state() {
    require_lxd
    enable_debug_iface
    wg_dbus GetState | sed -e "s/^('//" -e "s/',)$//" -e 's/\\"/"/g' |
        python3 -m json.tool
}

active_group() {
    wg_dbus GetState | grep -o '"activeGroup":[0-9]*' | grep -o '[0-9]*$'
}

# Switch to a group and confirm we got there. New windows land on the active
# workspace, so launching before the switch completes puts them in the wrong
# group — which is exactly what happened when this only slept and hoped.
switch_to_group() {
    local index="$1"
    wg_dbus ActivateGroup "$index" >/dev/null
    for _ in $(seq 1 20); do
        [ "$(active_group)" = "$index" ] && return 0
        sleep 0.3
    done
    echo "    warning: could not reach group $index"
    return 1
}

cmd_demo() {
    require_lxd
    local u; u="$(guest_user)"
    local schema="/home/$u/.local/share/gnome-shell/extensions/$UUID/schemas"

    as_user gnome-extensions disable ubuntu-dock@ubuntu.com 2>/dev/null || true
    # A second tiler moving the same windows produces symptoms that look like
    # random flicker.
    as_user gnome-extensions disable tiling-assistant@ubuntu.com 2>/dev/null || true

    as_user gsettings set org.gnome.desktop.wm.preferences num-workspaces 3
    as_user gsettings set org.gnome.desktop.wm.preferences workspace-names \
        "['${DEMO_GROUPS[0]}', '${DEMO_GROUPS[1]}', '${DEMO_GROUPS[2]}']"
    as_user env GSETTINGS_SCHEMA_DIR="$schema" gsettings set \
        org.gnome.shell.extensions.window-groups colors \
        "['${DEMO_COLORS[0]}', '${DEMO_COLORS[1]}', '${DEMO_COLORS[2]}']"
    as_user env GSETTINGS_SCHEMA_DIR="$schema" gsettings set \
        org.gnome.shell.extensions.window-groups arrangements \
        "['${DEMO_ARRANGEMENTS[0]}', '${DEMO_ARRANGEMENTS[1]}', '${DEMO_ARRANGEMENTS[2]}']"

    enable_debug_iface

    for i in 0 1 2; do
        echo "  ${DEMO_GROUPS[$i]}: ${DEMO_APPS[$i]}"
        switch_to_group "$i"
        for app in ${DEMO_APPS[$i]}; do
            lxc exec "$VM" -- sudo -u "$u" \
                env XDG_RUNTIME_DIR=/run/user/1000 \
                    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
                    WAYLAND_DISPLAY=wayland-0 \
                setsid "$app" >/dev/null 2>&1 &
            sleep 4
        done
        # Let the last window finish mapping before the next switch, or it
        # follows us to the next group.
        sleep 2
    done

    switch_to_group 0
    echo "demo ready"
}

# True when none of the demo applications are running, so opening the console
# twice does not launch a second copy of everything.
demo_needed() {
    local app
    for app in ${DEMO_APPS[0]} ${DEMO_APPS[1]} ${DEMO_APPS[2]}; do
        # -x matches against comm, which the kernel truncates to 15
        # characters, so it can never match gnome-text-editor and friends.
        lxc exec "$VM" -- pgrep -u 1000 -f "(^|/)$app( |\$)" >/dev/null 2>&1 && return 1
    done
    return 0
}

cmd_console() {
    command -v remote-viewer >/dev/null \
        || die "remote-viewer missing. Install with:  sudo apt install virt-viewer"

    quiesce_session
    unlock_session

    # Killing spice-vdagent keeps the resolution pinned, but it also runs the
    # guest side of pointer and clipboard integration — losing it is far worse
    # than a display that resizes. Off by default; opt in with WG_PIN_DISPLAY=1
    # and use View > Automatically resize in remote-viewer instead.
    if [ -n "${WG_PIN_DISPLAY:-}" ]; then
        lxc exec "$VM" -- systemctl stop spice-vdagentd.socket 2>/dev/null || true
        lxc exec "$VM" -- systemctl stop spice-vdagentd 2>/dev/null || true
        lxc exec "$VM" -- pkill -f "spice-vdagent$" 2>/dev/null || true
        echo "stopped spice-vdagent: resolution pinned, pointer and clipboard"
        echo "  integration degraded"
    else
        echo "tip: if the desktop is tiny, turn off View > Automatically resize"
        echo "     in remote-viewer, then run ./run-lxd.sh res 2.0"
    fi
    cmd_res "${WG_SCALE:-2.0}" "${WG_MODE:-3840x2160}"

    if [ -z "${WG_NO_DEMO:-}" ] && demo_needed; then
        echo "seeding a window in every group:"
        cmd_demo
    fi

    echo "opening console — close the window to return here"
    lxc console "$VM" --type=vga
}

cmd_shot() {
    local out="${1:-$SRC/vm-shot.png}"
    local u; u="$(guest_user)"
    # The Screenshot D-Bus method only accepts callers owning
    # org.gnome.SettingsDaemon.MediaKeys or the GNOME portal impl. In a real
    # session gsd-media-keys holds that name, so park it for a moment.
    # systemctl cannot be used: the gsd units set RefuseManualStart/Stop, so
    # `systemctl --user stop` is rejected. Signal the process instead; the
    # session restarts it on demand and nothing outside this VM is affected.
    # Delete first: without this a failed capture silently pulls the previous
    # run's file, which looks like a successful screenshot of stale state.
    lxc exec "$VM" -- rm -f /tmp/wg-vm-shot.png
    lxc exec "$VM" -- pkill -f gsd-media-keys 2>/dev/null || true
    sleep 1
    as_user python3 "/home/$u/.local/share/gnome-shell/extensions/$UUID/screenshot-helper.py" \
        /tmp/wg-vm-shot.png || true
    lxc exec "$VM" -- test -s /tmp/wg-vm-shot.png \
        || die "screenshot failed in the guest (no file produced)"
    lxc file pull "$VM/tmp/wg-vm-shot.png" "$out"
    echo "wrote $out"
}

cmd_log() {
    as_user journalctl --user -b -f -o cat 2>/dev/null \
        || lxc exec "$VM" -- journalctl -b -f -o cat
}

case "${1:-up}" in
    up)      cmd_up ;;
    sync)    cmd_sync ;;
    console) cmd_console ;;
    shot)    shift; cmd_shot "${1:-}" ;;
    res)     shift; cmd_res "${1:-2.0}" "${2:-3840x2160}" ;;
    demo)    cmd_demo ;;
    state)   cmd_state ;;
    log)     cmd_log ;;
    down)    lxc stop "$VM" ;;
    destroy) lxc delete --force "$VM" ;;
    *)       die "unknown command: $1" ;;
esac
