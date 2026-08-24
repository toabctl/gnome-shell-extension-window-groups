// SPDX-FileCopyrightText: 2026 Thomas Bechtold
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

/* arranger.js
 *
 * Applies a group's layout to real windows. Deliberately imports nothing from
 * GNOME: everything it needs about the shell arrives through `env`, so the
 * whole thing runs under `node --test` against fakes. The bugs that lived
 * here — laying out against the wrong monitor, running from rebuild() on
 * every keystroke, moving windows that cannot be moved — are all logic, and
 * logic should not need a virtual machine to check.
 */

import {computeLayout, resizeToState} from './layouts.js';

/** Layouts with no adjustable axis: a drag-resize cannot be absorbed. */
const RIGID_LAYOUTS = new Set(['free']);

export class Arranger {
    /**
     * @param {object} opts
     * @param {object} opts.model group state: count, arrangement(i),
     *   layoutState(i), setLayoutState(i, s), windows(i)
     * @param {object} opts.env shell bindings: getWorkAreaForMonitor(i),
     *   getFocusWindow(), isManaged(win), defer(fn) -> handle, cancel(handle),
     *   maximizeFlags — opaque, handed straight back to Meta.Window; the real
     *   unmaximize()/maximize() require it and this module must not import Meta
     */
    constructor({model, env}) {
        this._model = model;
        this._env = env;
        this._pending = new Set();
        this._handle = null;
        // Frame geometry as it was before we first tiled a window, so
        // switching a group back to 'free' is not a one-way door.
        this._preTile = new Map();
    }

    destroy() {
        if (this._handle !== null) {
            this._env.cancel(this._handle);
            this._handle = null;
        }
        this._pending.clear();
        this._preTile.clear();
    }

    /** Queue a group for layout. Coalesced to one pass: a burst of
     *  window-added and workarea-changed signals must not each move every
     *  window in the group. */
    schedule(index) {
        if (!Number.isInteger(index) || index < 0 || index >= this._model.count)
            return;
        this._pending.add(index);
        if (this._handle !== null)
            return;
        this._handle = this._env.defer(() => {
            this._handle = null;
            const groups = [...this._pending];
            this._pending.clear();
            for (const i of groups)
                this.apply(i);
        });
    }

    scheduleAll() {
        for (let i = 0; i < this._model.count; i++)
            this.schedule(i);
    }

    forget(win) {
        this._preTile.delete(win);
    }

    /** Windows a layout may place. Everything excluded here would either
     *  fight us or be actively wrong to move. */
    tileable(win) {
        // A maximized window reports allows_resize() false -- Mutter is
        // answering about the window as it stands, and it is not resizable
        // until it is restored. We unmaximize before placing anything, so ask
        // about the window we will actually be moving. Testing it as-is meant
        // every maximized window quietly declined to tile, which is most of
        // the windows most people have.
        const maximized =
            win.maximized_horizontally || win.maximized_vertically;
        return this._env.isManaged(win) &&
            !win.minimized &&
            !win.is_fullscreen() &&
            !win.is_on_all_workspaces() &&
            (maximized || win.allows_resize()) &&
            win.allows_move();
    }

    /** A group's tileable windows, split by monitor. A group is a workspace
     *  and a workspace spans every monitor, so each screen is laid out
     *  independently against its own work area. */
    byMonitor(index) {
        const map = new Map();
        for (const win of this._model.windows(index)) {
            if (!this.tileable(win))
                continue;
            const monitor = win.get_monitor();
            if (monitor < 0)
                continue;
            if (!map.has(monitor))
                map.set(monitor, []);
            map.get(monitor).push(win);
        }
        return map;
    }

    apply(index) {
        const kind = this._model.arrangement(index);
        if (kind === 'free') {
            this.restoreGroup(index);
            return;
        }

        const state = this._model.layoutState(index);
        for (const [monitor, windows] of this.byMonitor(index)) {
            const area = this._env.getWorkAreaForMonitor(monitor);
            if (!area)
                continue;
            const rects = computeLayout(kind, windows.length, area, state);
            if (!rects)
                continue;
            windows.forEach((win, i) => this._place(win, rects[i]));
        }
    }

    _place(win, rect) {
        if (!this._preTile.has(win)) {
            this._preTile.set(win, {
                rect: win.get_frame_rect(),
                maximized: win.maximized_horizontally || win.maximized_vertically,
            });
        }

        // A maximized window ignores move_resize_frame, so it has to leave
        // that state first or the layout silently does nothing.
        if (win.maximized_horizontally || win.maximized_vertically)
            win.unmaximize(this._env.maximizeFlags);

        const now = win.get_frame_rect();
        if (now.x === rect.x && now.y === rect.y &&
            now.width === rect.width && now.height === rect.height)
            return;

        // move_resize_frame is advisory: a client may clamp to its own
        // minimum size. The result is never read back to correct it,
        // precisely so a stubborn window cannot drive an endless loop.
        win.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
    }

    restoreGroup(index) {
        for (const win of this._model.windows(index)) {
            const stash = this._preTile.get(win);
            if (!stash)
                continue;
            this._preTile.delete(win);
            if (stash.maximized) {
                win.maximize(this._env.maximizeFlags);
                continue;
            }
            const {x, y, width, height} = stash.rect;
            win.move_resize_frame(false, x, y, width, height);
        }
    }

    /** True if this window currently has stashed pre-tile geometry. */
    hasStash(win) {
        return this._preTile.has(win);
    }

    /** Turn a finished drag-resize into layout state, so resizing a tiled
     *  window edits the layout rather than being snapped away. */
    absorbResize(win) {
        const index = win.get_workspace()?.index();
        if (!Number.isInteger(index) || index < 0)
            return false;
        const kind = this._model.arrangement(index);
        if (RIGID_LAYOUTS.has(kind))
            return false;

        const peers = this.byMonitor(index).get(win.get_monitor());
        if (!peers || peers.length < 2)
            return false;
        const slot = peers.indexOf(win);
        if (slot === -1)
            return false;

        const area = this._env.getWorkAreaForMonitor(win.get_monitor());
        if (!area)
            return false;

        this._model.setLayoutState(index, resizeToState(
            kind, peers.length, slot, win.get_frame_rect(),
            area, this._model.layoutState(index)));
        this.schedule(index);
        return true;
    }
}
