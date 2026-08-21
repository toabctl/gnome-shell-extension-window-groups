# Window Groups

A GNOME Shell extension that replaces the dock with a **left sidebar of open
windows, organised into named groups**. Each group has its own arrangement.

Status: working prototype, verified on GNOME Shell 50.1 (Ubuntu, Wayland).

## Model

Groups are backed 1:1 by **static workspaces**. That is the whole design
decision: Mutter already knows how to show and hide windows, survive a
session restart, and treat XWayland clients exactly like Wayland ones. This
extension only draws a view and calls into the workspace API.

| Concept | Implementation |
| --- | --- |
| group | workspace (`append_new_workspace`, `remove_workspace`) |
| group name | `org.gnome.desktop.wm.preferences workspace-names` |
| move group up/down | `Meta.WorkspaceManager.reorder_workspace()` |
| move window into group | `Meta.Window.change_workspace_by_index()` |
| sidebar shrinks the work area | `Main.layoutManager.addChrome(…, {affectsStruts: true})` |
| drag a window row onto a group | `ui/dnd.js` — `makeDraggable` + `acceptDrop` |

## Arrangements

Only two, deliberately:

- **free** — geometry is left alone.
- **tabbed** — every window in the group gets identical geometry (the work
  area) and the focused one is raised. Same illusion browsers use; nothing is
  hidden, so nothing can get out of sync.

Real tiling is a much larger problem and is best delegated to an existing
tiling extension (Forge has per-container `HSPLIT`/`VSPLIT`/`STACKED`/`TABBED`
already) rather than reimplemented here.

## Tags

Right-click a window row to give that window a tag, or clear it. One tag per
window, typed by hand — there is no rule engine and nothing is inferred from
the application.

With `auto-group` on (the default), tagging a window moves it into the group
named after the tag, creating that group if it does not exist. It reuses an
unnamed empty group before appending a new one and stops at 16 groups. Turn
it off to make tags a pure label:

    gsettings set org.gnome.shell.extensions.window-groups auto-group false

**Tags do not survive logout.** Mutter exposes no persistent per-window
identity — `get_id()` and `get_stable_sequence()` are session-scoped — so a
tag attached to one particular window cannot be reattached after a restart.
Tags render with a dashed outline to make that visible rather than silent.

## Auto-hide

    gsettings set org.gnome.shell.extensions.window-groups auto-hide true

The sidebar slides off screen and reveals when you push the pointer into the
left edge. Reveal uses a `Meta.Barrier` driven by `Layout.PressureBarrier` —
the same mechanism as the hot corner — so brushing past the edge on the way
to a window does not fling it open. Tune the shove needed with
`reveal-pressure` (pixels, default 100). It hides again shortly after the
pointer leaves.

With auto-hide on the sidebar no longer reserves screen space; windows use
the full width. Struts are fixed when the actor is registered, so toggling
this setting re-creates the sidebar rather than just moving it.

## Usage

- Click a window row → focus that window (switching group if needed).
- Click a group name → switch to that group.
- **Right-click** a group name → rename inline.
- Drag a window row onto another group → move the window there.
- Drag a group header onto another group to reorder groups.
- `+ New group` at the bottom.

The extension sets `org.gnome.mutter dynamic-workspaces` to `false` while
enabled (groups need stable identity) and restores it on disable.

## Testing without risking your session

Do not enable this in your live session while iterating. Two harnesses:

```sh
./run-nested.sh        # GNOME Shell in a window on your desktop (devkit mode)
./screenshot.sh out.png  # headless on a virtual monitor, writes a screenshot
```

Both build a sandbox with its own `XDG_CONFIG_HOME`, so dconf writes —
including `dynamic-workspaces` and `workspace-names` — land in a throwaway
database and cannot reach your real session. `dbus-run-session` gives each
its own session bus.

`./spawn-test-apps.sh` opens a few windows in the nested session.

### Full-session testing in an LXD VM

`./run-lxd.sh` drives an `images:ubuntu/26.04/desktop` VM — same GNOME 50.x as
a 26.04 host, so extension API parity holds. A VM has its own kernel, so
unlike the nested harness there is no shared runtime dir, dconf or X socket to
reason about at all.

    sudo lxd init --auto --storage-backend=dir   # once
    ./run-lxd.sh up          # launch, push the extension, enable it
    ./run-lxd.sh console     # interactive desktop (needs virt-viewer)
    ./run-lxd.sh sync        # re-push and reload after an edit
    ./run-lxd.sh shot f.png  # screenshot from inside the guest
    ./run-lxd.sh log         # tail the guest journal

Three bugs showed up here that the nested harness could not surface: the
Ubuntu dock overdrawing the sidebar, labels inheriting a dark theme
foreground under the default light theme, and external `arrangements` writes
not triggering a rebuild.

If `lxd init` created `lxdbr0` on a host that also runs Docker, guest egress
fails. The tell is a guest that holds a DHCP lease and pings its gateway but
reaches nothing beyond it.

No LXD setting fixes this. LXD's firewall driver here is nftables, so it
writes to `table inet lxd`, while Docker sets the FORWARD policy to DROP in
the iptables-nft `filter` table. Netfilter evaluates every table and a DROP
anywhere wins, so LXD cannot override a policy in a table it does not own —
`ipv4.firewall` is already `true` and LXD is doing its part.

The declarative fix is Docker-side (`--ip-forward-no-drop`, Docker 28+):

    /etc/docker/daemon.json
    { "ip-forward-no-drop": true }

then `sudo systemctl restart docker`. Note this drops Docker's global
default-deny for *all* forwarded traffic, not just lxdbr0. LXD's documented
`iptables -I DOCKER-USER -i lxdbr0 -j ACCEPT` is narrower but imperative and
does not survive a reboot on its own.

Nothing in this harness needs guest networking, so either way it is
optional.

### Blast radius

What is isolated, and why it needed to be:

| Shared resource | Hazard | Isolation |
| --- | --- | --- |
| dconf | extension writes `dynamic-workspaces=false` and `workspace-names` | `XDG_CONFIG_HOME` -> sandbox DB |
| session bus | name grabs, service activation | `dbus-run-session` |
| `$XDG_RUNTIME_DIR/gnome-shell-disable-extensions` | `org.gnome.Shell@.service` has `OnFailure=org.gnome.Shell-disable-extensions.service`, whose `ConditionPathExists` is this file. A nested shell that dies leaves it armed, so the *next* crash of your real shell sets `disable-user-extensions true` | private `XDG_RUNTIME_DIR` |
| `$XDG_RUNTIME_DIR/gvfs` | live FUSE mount owned by `run-user-1000-gvfs.mount`; the sandbox gvfsd tries to mount over it | private `XDG_RUNTIME_DIR` |
| `$XDG_RUNTIME_DIR/keyring` | sandbox apps otherwise talk to your running `gnome-keyring-daemon` | private `XDG_RUNTIME_DIR` |
| `/tmp/.X11-unix`, `/tmp/.Xn-lock` | cannot be redirected | snapshot before, reap only displays we created, after their pid exits |

`--devkit` opens `/dev/dri/renderD128` as a render node "using no mode
setting" and never calls logind `TakeControl` — that is exactly what fails
with `EBUSY` if you try `--display-server`. It structurally cannot acquire
DRM master or take over your console.

The remaining risk is not the harness — it is enabling this extension in
your live session. On Wayland gnome-shell *is* the display server, so a shell
crash takes every application with it. GNOME catches exceptions thrown from
extension callbacks (a `TypeError` here only logged `JS ERROR` and the shell
kept running), but a bad Clutter allocation or a malformed strut can still
wedge the UI. Test in the harness.

Notes:

- GNOME 50 removed `gnome-shell --nested`; `--devkit` is the replacement.
- `screenshot-helper.py` exists because `org.gnome.Shell.Screenshot` only
  accepts callers owning `org.gnome.SettingsDaemon.MediaKeys` or
  `org.freedesktop.impl.portal.desktop.gnome`. In a sandbox session
  gsd-media-keys is not running, so the helper owns that name and calls from
  there.

## Not done yet

- Preferences UI (`prefs.js`); settings are dconf-only.
- Keybindings for move-to-group / switch-group.
- Multi-monitor: the sidebar is primary-monitor only. Note that Ubuntu ships
  `org.gnome.mutter workspaces-only-on-primary = true`, which puts
  secondary-monitor windows on *every* workspace, so they cannot belong to a
  group. Either flip that setting or accept the limitation.
- Reordering windows *within* a group.
- The Activities overview shows groups as workspaces — a second UI for the
  same thing, which this extension does not control.
