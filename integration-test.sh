#!/usr/bin/env bash
# Tier 3: assertions against a running GNOME Shell in the test VM.
#
# Everything here asks the extension what it believes, through its debug D-Bus
# interface, rather than inspecting pixels. Two conclusions in this project
# were confidently wrong because a screenshot was consulted instead: a stale
# image read as proof a change had not applied, and a pixel scan that counted
# a dark window as part of the sidebar.
#
# Usage: ./integration-test.sh          (VM must already be up)
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VM="${WG_VM:-wg-vm}"
UUID="window-groups@toabctl.de"
SCHEMA="/home/ubuntu/.local/share/gnome-shell/extensions/$UUID/schemas"

PASS=0
FAIL=0

guest() {
    lxc exec "$VM" -- sudo -u ubuntu \
        env XDG_RUNTIME_DIR=/run/user/1000 \
            DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
            GSETTINGS_SCHEMA_DIR="$SCHEMA" "$@"
}

# Every setting this suite writes is snapshotted on first touch and put back
# on exit. A test run that leaves the desktop configured differently from how
# it found it is indistinguishable, later, from a bug — which is exactly what
# happened when an earlier version left auto-hide switched off.
declare -A SAVED
SNAPSHOT_ORDER=()

save_once() {
    # Separate statements on purpose: in a single `local a=$1 b="$a"`, bash
    # declares every name before evaluating the later initialisers, so under
    # `set -u` the reference to $a fails with "unbound variable". bash -n does
    # not catch it — it is a runtime error.
    local schema="$1"
    local key="$2"
    local id="$schema $key"
    [ -n "${SAVED[$id]+set}" ] && return
    SAVED[$id]="$(guest gsettings get "$schema" "$key")"
    SNAPSHOT_ORDER+=("$id")
}

restore_all() {
    local id schema key
    for id in "${SNAPSHOT_ORDER[@]}"; do
        schema="${id%% *}"; key="${id#* }"
        guest gsettings set "$schema" "$key" "${SAVED[$id]}" >/dev/null 2>&1
    done
    [ ${#SNAPSHOT_ORDER[@]} -gt 0 ] &&
        echo "restored ${#SNAPSHOT_ORDER[@]} settings"
    # Whatever happened, leave the extension running.
    guest gnome-extensions enable "$UUID" >/dev/null 2>&1
}
trap restore_all EXIT

# Where the shell's log stood when we started, so the exception scan at the
# end reads only this run.
JOURNAL_START="$(lxc exec "$VM" -- date +%s 2>/dev/null || echo 0)"

setting() {
    save_once org.gnome.shell.extensions.window-groups "$1"
    guest gsettings set org.gnome.shell.extensions.window-groups "$@"
}

gnome_setting() {
    save_once "$1" "$2"
    guest gsettings set "$@"
}

state() {
    guest gdbus call --session --dest org.gnome.Shell \
        --object-path /de/toabctl/WindowGroups \
        --method de.toabctl.WindowGroups.GetState 2>/dev/null |
        sed -e "s/^('//" -e "s/',)$//" -e 's/\\"/"/g'
}

# field <jq-ish path> — a python expression over the parsed state
field() { state | python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

check() {
    local label="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        printf '  ok    %s\n' "$label"
        PASS=$((PASS + 1))
    else
        printf '  FAIL  %s\n        expected %s, got %s\n' "$label" "$expected" "$actual"
        FAIL=$((FAIL + 1))
    fi
}

# Wait for a field to reach a value, so a test never races an animation.
await() {
    local expr="$1" want="$2" tries="${3:-25}"
    for _ in $(seq 1 "$tries"); do
        [ "$(field "$expr")" = "$want" ] && return 0
        sleep 0.4
    done
    return 1
}

pointer() { lxc exec "$VM" -- python3 /root/guest-input.py "$@" >/dev/null 2>&1; }
pointer_hold() {
    lxc exec "$VM" -- bash -c \
        "setsid python3 /root/guest-input.py $* >/dev/null 2>&1 &"
}

echo "preparing"
"$SRC/run-lxd.sh" res 2.0 3840x2160 >/dev/null 2>&1
guest gnome-extensions disable ubuntu-dock@ubuntu.com >/dev/null 2>&1
guest gnome-extensions disable tiling-assistant@ubuntu.com >/dev/null 2>&1
setting debug-interface true >/dev/null 2>&1
sleep 2

if [ -z "$(state)" ]; then
    echo "the debug interface is not answering."
    echo "extension state: $(guest gnome-extensions info "$UUID" | grep -i state)"
    echo "If that says INACTIVE the guest is probably locked; user extensions"
    echo "do not run on the lock screen."
    exit 1
fi

echo
echo "extension lifecycle"
guest gnome-extensions disable "$UUID" >/dev/null 2>&1
sleep 2
check "disabling unexports the debug interface" "" "$(state)"
guest gnome-extensions enable "$UUID" >/dev/null 2>&1
sleep 3
check "re-enabling brings it back" "True" "$([ -n "$(state)" ] && echo True)"

# Ten cycles: a leaked timeout, signal or chrome actor usually shows up as an
# error long before ten, and a shell that survives them is a good sign the
# teardown is complete.
for _ in $(seq 1 10); do
    guest gnome-extensions disable "$UUID" >/dev/null 2>&1
    guest gnome-extensions enable "$UUID" >/dev/null 2>&1
done
sleep 3
errors=$(lxc exec "$VM" -- sudo -u ubuntu journalctl --user -b --no-pager 2>/dev/null |
    grep -c "window-groups.*ERROR")
check "ten enable/disable cycles produce no errors" "0" "$errors"
check "still alive afterwards" "True" "$([ -n "$(state)" ] && echo True)"

echo
echo "groups"
setting compact false >/dev/null 2>&1
gnome_setting org.gnome.desktop.wm.preferences num-workspaces 3 >/dev/null 2>&1
gnome_setting org.gnome.desktop.wm.preferences workspace-names \
    "['one','two','three']" >/dev/null 2>&1
sleep 2
check "three groups" "3" "$(field "len(d['groups'])")"
check "named from workspace-names" "one" "$(field "d['groups'][0]['name']")"
setting colors "['red','green','blue']" >/dev/null 2>&1
# Assert what was drawn, not what the model holds. Both come back from the
# same setting, so the model-side check passed happily for a sidebar that had
# stopped repainting altogether — an exception during rebuild() left the old
# actors on screen and every later rebuild threw in the same place.
await "d['rendered'][1]['color']" green >/dev/null
check "colours reach the screen" "green" "$(field "d['rendered'][1]['color']")"
check "names reach the screen" "one" "$(field "d['rendered'][0]['name']")"
check "the view agrees with the model" "True" \
    "$(field "[g['color'] for g in d['groups']] == [r['color'] for r in d['rendered']]")"

echo
echo "dissolving a group rehomes rather than closes"
before=$(field "sum(len(g['windows']) for g in d['groups'])")
guest gdbus call --session --dest org.gnome.Shell \
    --object-path /de/toabctl/WindowGroups \
    --method de.toabctl.WindowGroups.RemoveGroup 1 >/dev/null 2>&1
sleep 2
check "no windows were closed" "$before" \
    "$(field "sum(len(g['windows']) for g in d['groups'])")"

echo
echo "auto-hide"
setting auto-hide true >/dev/null 2>&1
pointer move 1400,700
sleep 1
if await "d['sidebar']['revealed']" False; then
    check "hidden when the pointer is elsewhere" "False" \
        "$(field "d['sidebar']['revealed']")"
    check "and actually off screen" "False" "$(field "d['sidebar']['onScreen']")"
else
    check "hidden when the pointer is elsewhere" "False" "timeout"
fi

pointer_hold "move 0,400 sleep 0.1 rel 120,0 sleep 18"
if await "d['sidebar']['revealed']" True; then
    check "revealed by an edge dwell" "True" "$(field "d['sidebar']['revealed']")"
    check "translation back to zero" "0" "$(field "d['sidebar']['translationX']")"
else
    check "revealed by an edge dwell" "True" "timeout"
fi

pointer_hold "move 1400,700 sleep 8"
if await "d['sidebar']['revealed']" False; then
    check "hides again when the pointer leaves" "False" \
        "$(field "d['sidebar']['revealed']")"
else
    check "hides again when the pointer leaves" "False" "timeout"
fi

# The regression that kept this broken: a pointer resting at the very edge
# reveals the sidebar but never enters it, so nothing ever put it away.
pointer_hold "move 0,600 sleep 14"
sleep 3
if await "d['sidebar']['revealed']" False 12; then
    check "a pointer parked at the edge does not pin it open" "False" \
        "$(field "d['sidebar']['revealed']")"
else
    check "a pointer parked at the edge does not pin it open" "False" "still open"
fi

echo
echo "keyboard"
gnome_setting org.gnome.desktop.wm.preferences num-workspaces 3 >/dev/null 2>&1
pointer key super+ctrl+up; pointer key super+ctrl+up   # settle at the top
before_active=$(field "d['activeGroup']")
check "starts at the first group" "0" "$before_active"
pointer key super+ctrl+down
sleep 1
check "switch-group-down moves down one" "1" "$(field "d['activeGroup']")"
pointer key super+ctrl+up
sleep 1
check "switch-group-up moves back" "0" "$(field "d['activeGroup']")"
# Clamped, not wrapped: repeated presses at the end must not jump to the far
# side of the list.
pointer key super+ctrl+up
sleep 1
check "does not wrap past the first group" "0" "$(field "d['activeGroup']")"

echo
echo "compact"
pointer move 1400,700
setting auto-hide false >/dev/null 2>&1
setting compact true >/dev/null 2>&1
sleep 2
check "narrow when compact" "True" \
    "$(field "d['sidebar']['width'] <= 60")"
setting compact false >/dev/null 2>&1
sleep 2
check "wide when expanded" "True" "$(field "d['sidebar']['width'] > 200")"

echo
echo "settings this extension does not own"
# workspace-names holds the group names the user made through our UI, so it is
# theirs to keep — restoring a pre-enable snapshot would delete their work on
# every toggle. dynamic-workspaces is the opposite: nobody asked for it.
gnome_setting org.gnome.desktop.wm.preferences workspace-names \
    "['keepme']" >/dev/null 2>&1
guest gnome-extensions disable "$UUID" >/dev/null 2>&1
sleep 2
check "group names are left alone" "['keepme']" \
    "$(guest gsettings get org.gnome.desktop.wm.preferences workspace-names)"
check "dynamic-workspaces restored" "true" \
    "$(guest gsettings get org.gnome.mutter dynamic-workspaces)"
guest gnome-extensions enable "$UUID" >/dev/null 2>&1
sleep 3

echo
echo "no exceptions from the shell"
# A GJS exception does not stop the shell, it just abandons whatever callback
# threw. The frozen-sidebar bug was exactly that: silent apart from one line
# here, while every assertion above still passed.
noise=$(lxc exec "$VM" -- journalctl --since "@$JOURNAL_START" --no-pager -o cat 2>/dev/null |
    grep -E "already disposed|JS ERROR" |
    grep -v "COMMAND=" | head -5)
check "clean shell log" "" "$noise"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
