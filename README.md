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

## Usage

- Click a window row → focus that window (switching group if needed).
- Click a group name → switch to that group.
- **Right-click** a group name → rename inline.
- Drag a window row onto another group → move the window there.
- Header buttons: collapse, cycle arrangement, move group up, move group
  down, remove group.
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
