# Shared sandbox setup for the test harnesses. Sourced, not executed.
#
# Everything a nested GNOME Shell writes must land in a throwaway directory.
# Three things live in XDG_RUNTIME_DIR that will otherwise collide with your
# live session:
#
#   gnome-shell-disable-extensions  the crash guard. org.gnome.Shell@.service
#                                   has OnFailure=org.gnome.Shell-disable-
#                                   extensions.service, whose
#                                   ConditionPathExists points at this file.
#                                   A nested shell that dies leaves it behind,
#                                   arming "disable all extensions" for the
#                                   next crash of your real shell.
#   gvfs                            a live FUSE mount owned by the
#                                   run-user-1000-gvfs.mount user unit. The
#                                   sandbox's gvfsd tries to mount over it.
#   keyring                         the control socket of your running
#                                   gnome-keyring-daemon.
#
# Wayland accepts an absolute path in WAYLAND_DISPLAY, so we can move
# XDG_RUNTIME_DIR aside and still reach the host compositor.
#
# XWayland sockets (/tmp/.X11-unix, /tmp/.Xn-lock) are not under
# XDG_RUNTIME_DIR and cannot be redirected, so we snapshot and reap them.

HOST_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

wg_sandbox_env() {
    local sandbox="$1"

    mkdir -p "$sandbox/config" "$sandbox/cache" "$sandbox/state" \
             "$sandbox/runtime" "$sandbox/share/gnome-shell/extensions"
    chmod 700 "$sandbox/runtime"

    # Absolute path so the nested shell still finds the host compositor
    # after XDG_RUNTIME_DIR is redirected.
    if [ -n "${WAYLAND_DISPLAY:-}" ] && [ "${WAYLAND_DISPLAY#/}" = "$WAYLAND_DISPLAY" ]; then
        export WAYLAND_DISPLAY="$HOST_RUNTIME_DIR/$WAYLAND_DISPLAY"
    fi

    export XDG_RUNTIME_DIR="$sandbox/runtime"
    export XDG_DATA_HOME="$sandbox/share"
    export XDG_CONFIG_HOME="$sandbox/config"
    export XDG_CACHE_HOME="$sandbox/cache"
    export XDG_STATE_HOME="$sandbox/state"
}

# Record which X display numbers existed before we started.
wg_snapshot_x() {
    WG_X_BEFORE=""
    for lock in /tmp/.X*-lock; do
        [ -e "$lock" ] || continue
        local n="${lock#/tmp/.X}"
        WG_X_BEFORE="$WG_X_BEFORE ${n%-lock}"
    done
    WG_X_BEFORE="$WG_X_BEFORE "
    export WG_X_BEFORE
}

# Remove X sockets and locks that appeared while we ran. A display absent
# from the snapshot is definitively ours, so if its Xwayland is still
# shutting down we wait for it rather than leaking the socket. Never touches
# a display that existed before we started.
wg_reap_x() {
    local lock n pid waited
    for lock in /tmp/.X*-lock; do
        [ -e "$lock" ] || continue
        n="${lock#/tmp/.X}"
        n="${n%-lock}"
        case "${WG_X_BEFORE:- }" in
            *" $n "*) continue ;;
        esac
        pid="$(tr -dc '0-9' < "$lock" 2>/dev/null || true)"
        waited=0
        while [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 50 ]; do
            sleep 0.1
            waited=$((waited + 1))
        done
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "leaving X display :$n (pid $pid still alive after 5s)"
            continue
        fi
        echo "reaping stale X display :$n"
        rm -f "$lock" "/tmp/.X11-unix/X$n"
    done
}
