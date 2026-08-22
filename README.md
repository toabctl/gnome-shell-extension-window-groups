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

## Look

Modelled on Chrome's vertical tab groups: the group header is a filled pill in
the group colour with the name left-aligned, and every window in the group
carries a short line of that colour down its left edge. Text on the pill is
black or white depending on the fill's sRGB relative luminance, so yellow gets
dark ink where blue and purple get light. The active group's pill is ringed.

Palette: grey, blue, red, yellow, green, pink, purple, cyan, orange — grey is
the default, as in Chrome.

## Compact mode

The button at the top-left of the sidebar shrinks it to icons only and back,
as Chrome's vertical tabs do. Collapsed, a group becomes a small coloured pill
with a chevron, its windows become plain application icons, and the per-row
stripe disappears — the pill alone marks where a group starts, which is what
Chrome does. Titles and group names move into hover tooltips.

    gsettings set org.gnome.shell.extensions.window-groups compact true
    gsettings set org.gnome.shell.extensions.window-groups compact-width 52

The strut follows the actor's allocation (layout.js reconnects on
`notify::allocation`), so the work area shrinks and grows with the sidebar
without re-registering the chrome.

## Window search

`Super+Shift+A`, or the magnifier next to the collapse toggle, opens a search
popup: type to filter every open window by title, application or group. Each
result shows the window's group as a coloured dot, exactly as Chrome's tab
search does. Up/Down to move, Enter to activate, Escape to dismiss, and an ×
on each row to close that window.

The shortcut is not Chrome's `Ctrl+Shift+A`: a global grab would take that
combination away from every application. Change it with the `search-windows`
key.

Ranking lives in `search.js` — no GNOME imports, so `node --test
search.test.mjs` covers it. A hit in the title beats one in the application
name, which beats one in the group name; within a field, earlier hits rank
higher. The position term is `at / (at + 100)`, which is monotonic and
provably in [0, 1), so it can never cross a field penalty step however long a
title gets.

## Hover to expand

While compact, moving the pointer onto the sidebar expands it over the
windows and it collapses again when the pointer leaves
(`expand-on-hover`, on by default).

**It only does anything while the sidebar is collapsed.** Hovering an already
expanded sidebar is a no-op by design, which is easy to mistake for the
feature being broken. Check with:

    gsettings get org.gnome.shell.extensions.window-groups compact

The expansion deliberately does *not* change the work area. Reserved space and
visible width are separate actors: an invisible strut actor holds the compact
width, while the visible sidebar is registered with `affectsStruts: false`. If
the strut grew too, every window on screen would resize each time the pointer
brushed the edge.

## Closing a group

The × dissolves the group. Nothing is closed: its windows move out of any
group, into an `Ungrouped` group created on demand.

They used to land in whichever group happened to be adjacent, which silently
merged unrelated work. The last remaining group cannot be dissolved, and
dissolving `Ungrouped` itself falls back to a neighbour. The decision lives in
`chooseRehomeTarget()` in model.js and is unit tested.

## Auto-hide

    gsettings set org.gnome.shell.extensions.window-groups auto-hide true

The sidebar slides off screen and reveals when you push the pointer into the
left edge. Reveal uses a `Meta.Barrier` driven by `Layout.PressureBarrier` —
the same mechanism as the hot corner — so brushing past the edge on the way
to a window does not fling it open.

Reveal has two triggers, because one is not enough. A pressure barrier
accumulates *blocked relative motion*, so an absolute pointing device — a
tablet, a touchscreen, or anything behind SPICE or VNC — can never build any
pressure and the barrier silently never fires. Alongside it there is a 2px
reactive strip at the screen edge that reveals after a 250 ms dwell, which
works for both kinds of pointer. The dwell is what stops a brush past the
edge from triggering it.

The barrier direction is `NEGATIVE_X`. It has to block motion that would carry
the pointer *left past* the screen edge, because that is what accumulates
pressure. `POSITIVE_X` blocks motion out of the edge, which the pointer can
never make from x = 0, so the barrier never fires at all — GNOME's own hot
corner uses `NEGATIVE_X` for the same reason. Tune the shove needed with
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

## Testing

    make check      # lint + schema + 81 unit tests + 26 mutants, ~7s, no VM

Two tiers run without a compositor:

**Pure units.** `layouts.js` (geometry), `search.js` (ranking), `model.js`
(parallel-array bookkeeping, name lookup, slot selection, colour contrast).
None import GNOME.

**Fake shell.** `arranger.js` takes every shell binding through an injected
`env`, so `shell-stubs.mjs` can hand it fake windows, monitors and work areas
and a scheduler the test pumps by hand. That covers the failures which
previously needed a VM and a screenshot to notice: laying a group out against
the wrong monitor, moving windows that must not be moved, running a layout
pass on every keystroke, and leaking the pre-tile stash.

### The mutation gate

`node mutants.mjs` breaks the implementation 26 ways and requires each break
to fail at least one test. This is not decoration. Two suites in this project
were green with the behaviour they named deliberately deleted — the layout
resize clamp (`normalise()` repaired the bad value it produced) and the search
position cap (the assertion never reached the regime it protected). A third
gap turned up while writing the gate: `forget()`, which releases the pre-tile
stash when a window closes, had no test at all, so it could have been dropped
and leaked every window ever tiled.

Extracting `Arranger` also surfaced a live bug the fakes were too permissive
to catch: it called `win.unmaximize()` with no arguments, which the real
`Meta.Window` rejects. The flags now travel through `env` and both a test and
a mutant pin it.

### What is not covered here

Anything needing a compositor: struts, real `move_resize_frame` results,
enable/disable leaks, and every pointer interaction. Those are tiers 3 and 4 —
`run-nested.sh` and `run-lxd.sh` — and are still driven by hand.
`gnome-shell --headless` accepts `--virtual-monitor` more than once, so
per-monitor behaviour is testable in the fast nested harness rather than
needing a VM.

## Layout engine

`layouts.js` holds the geometry and imports nothing from GNOME. Everything is
`(kind, count, area, state) -> rects`, so it is testable with plain node:

    node --test layouts.test.mjs

Layouts: `free` (returns null — do not touch the windows), `tabbed`,
`columns`, `rows`, `grid`, `master-stack`. `resizeToState()` turns a user's
drag-resize into new layout state, so resizing a tiled window edits the
layout instead of being snapped back.

Boundaries are accumulated as exact fractions and rounded once each, so slice
*i+1* starts exactly where slice *i* ended. Rounding each width independently
leaks a pixel per slice and leaves visible seams — there is a test for it.

The suite is mutation-checked: deliberately reintroducing the seam bug,
dropping the outer gap, or breaking the grid shape all make it fail. That
matters because a green suite proves nothing on its own — the first version of
the resize-clamp test passed even with the clamp deleted, because
`normalise()` quietly repaired the resulting negative ratio.


### Known limits of the shell side

- **Clients that refuse to shrink.** `move_resize_frame` is advisory; a window
  clamps to its own minimum and then overlaps its neighbour. Visible with five
  columns on a 1920-wide work area, where Calculator and Yelp both bottom out
  around 358px. There is no corrective pass, because on Wayland the resize is
  asynchronous — reading the frame back immediately returns the old geometry,
  so a fix has to observe `size-changed`, record the observed minimum per
  window and feed it back as a constraint. Bounded, but not free.
- **Ratios reset when the window count changes.** They are stored per slot, so
  opening a window in a group you had resized falls back to equal shares.
- **Restore does not clamp to the work area.** Switching a group back to
  `free` puts windows exactly where they were, which can be partly under the
  sidebar if they were placed before it existed.
- **Order is creation order.** Reordering rows within a group to drive the
  layout order needs a per-window order list, which cannot survive logout for
  the same reason tags cannot.
- A competing tiler will fight this. `tiling-assistant@ubuntu.com` ships
  enabled on Ubuntu and must be disabled.


## Driving the guest

`guest-input.py` creates uinput devices in the VM, so keybindings, typing,
pointer motion and clicks can be exercised from outside the session. GNOME
Shell has no scriptable input path and X11 tools only reach XWayland clients,
so this is the only way to test the interactive parts.

    lxc exec wg-vm -- python3 /root/guest-input.py key super+shift+a type disk key return
    lxc exec wg-vm -- python3 /root/guest-input.py move 26,500 click left

Three things it has to get right, each of which silently produced "nothing
happens" while being debugged:

- **Two devices, not one.** libinput classifies a device declaring both a full
  keyboard and relative axes as a keyboard, and never gives it a pointer.
- **Step size.** Moving 25px in 60 steps rounds to zero per step, so that axis
  never moves.
- **Keep it alive.** Destroying the uinput device drops pointer focus, so the
  screenshot has to happen while the process is still running.

`spice-vdagentd` must be stopped first: its absolute tablet keeps asserting a
position and overrides relative motion.

### If everything suddenly stops working

Check whether the guest locked. On the lock screen GNOME runs in
`unlock-dialog` session mode and user extensions are **INACTIVE** — the
sidebar disappears, the debug interface unexports, and every check fails in a
way that looks like a code bug. `gnome-extensions info` reports
`Enabled: Yes` and `State: INACTIVE` together, which is the giveaway.

`run-lxd.sh` disables idle blanking, locking and suspend at setup and unlocks
before `demo` and `console`, but a VM resumed from an older state can still
come back locked.
