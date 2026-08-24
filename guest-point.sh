#!/usr/bin/env bash
# Put the guest pointer on an exact logical coordinate.
#
# Open-loop relative motion cannot do this: libinput accelerates it, so the
# device-units-to-pixels ratio grows with distance (measured 1.92 at 100 units,
# 1.99 at 400). Three attempts at clicking a 24px button missed because of it.
#
# So: move, ask the extension where the pointer actually ended up, correct,
# repeat. Converges in two or three passes and is exact regardless of
# acceleration profile or monitor scale.
#
# Usage: ./guest-point.sh <x> <y> [--click|--right-click]
set -uo pipefail

VM="${WG_VM:-wg-vm}"
TARGET_X="$1"
TARGET_Y="$2"
ACTION="${3:-}"
TOLERANCE=4

guest() {
    lxc exec "$VM" -- sudo -u ubuntu \
        env XDG_RUNTIME_DIR=/run/user/1000 \
            DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus "$@"
}

pointer() {
    guest gdbus call --session --dest org.gnome.Shell \
        --object-path /de/toabctl/WindowGroups \
        --method de.toabctl.WindowGroups.GetState 2>/dev/null |
        sed -e "s/^('//" -e "s/',)$//" -e 's/\\"/"/g' |
        python3 -c "import json,sys; p=json.load(sys.stdin)['pointer']; print(p['x'], p['y'])"
}

input() { lxc exec "$VM" -- python3 /root/guest-input.py "$@" >/dev/null 2>&1; }

# Start from a known corner so the first estimate is not wild.
converged=0
input move 0,0
for attempt in 1 2 3 4 5 6 7 8; do
    read -r px py <<<"$(pointer)"
    [ -z "${px:-}" ] && { echo "cannot read the pointer; is debug-interface on?" >&2; exit 1; }
    dx=$((TARGET_X - px))
    dy=$((TARGET_Y - py))
    if [ "${dx#-}" -le "$TOLERANCE" ] && [ "${dy#-}" -le "$TOLERANCE" ]; then
        echo "pointer at ${px},${py} after $((attempt - 1)) correction(s)"
        converged=1
        break
    fi
    # Full delta, not half. Acceleration *under*-shoots small relative moves,
    # so halving the correction stalls short of the target; iterating on the
    # full remainder converges geometrically instead.
    input rel "$dx,$dy"
done

[ "$converged" -eq 1 ] || {
    read -r px py <<<"$(pointer)"
    echo "warning: stopped at ${px},${py}, wanted ${TARGET_X},${TARGET_Y}" >&2
}

case "$ACTION" in
    --click) input click left ;;
    --right-click) input click right ;;
esac
