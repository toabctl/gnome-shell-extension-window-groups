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
#     ./run-lxd.sh log         tail the guest shell journal
#     ./run-lxd.sh down        stop the VM
#     ./run-lxd.sh destroy     delete the VM
set -euo pipefail

VM="${WG_VM:-wg-vm}"
UUID="window-groups@tom.devel"
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

cmd_console() {
    command -v remote-viewer >/dev/null \
        || die "remote-viewer missing. Install with:  sudo apt install virt-viewer"

    if [ -z "${WG_KEEP_VDAGENT:-}" ]; then
        # spice-vdagent is what re-resizes the guest on every client resize,
        # undoing the pin below. Stopping it costs host/guest clipboard
        # sharing, which this test VM does not need.
        lxc exec "$VM" -- systemctl stop spice-vdagentd.socket 2>/dev/null || true
        lxc exec "$VM" -- systemctl stop spice-vdagentd 2>/dev/null || true
        echo "stopped spice-vdagentd so the resolution stays put"
        echo "  (clipboard sharing is off; WG_KEEP_VDAGENT=1 to keep it)"
    fi
    cmd_res "${WG_SCALE:-2.0}" "${WG_MODE:-3840x2160}"

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
    log)     cmd_log ;;
    down)    lxc stop "$VM" ;;
    destroy) lxc delete --force "$VM" ;;
    *)       die "unknown command: $1" ;;
esac
