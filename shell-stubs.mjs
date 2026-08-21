/* shell-stubs.mjs
 *
 * Minimal fakes for the slice of Mutter that arranger.js touches. Enough to
 * run real layout logic against controlled windows, monitors and work areas
 * in milliseconds, with no compositor.
 *
 * Every fake records what was done to it, so tests assert on behaviour
 * ("this window was moved to that rect", "this one was never touched")
 * rather than on pixels.
 */

let nextSequence = 1;

export class FakeWindow {
    constructor({
        title = 'window', app = 'App', monitor = 0, workspace = 0,
        frame = {x: 0, y: 0, width: 400, height: 300},
        resizable = true, movable = true, minimized = false,
        fullscreen = false, onAllWorkspaces = false, maximized = false,
        managed = true,
    } = {}) {
        this.title = title;
        this.app = app;
        this.monitor = monitor;
        this.workspaceIndex = workspace;
        this.frame = {...frame};
        this.resizable = resizable;
        this.movable = movable;
        this.minimized = minimized;
        this.fullscreen = fullscreen;
        this.onAllWorkspaces = onAllWorkspaces;
        this.maximized_horizontally = maximized;
        this.maximized_vertically = maximized;
        this.managed = managed;
        this.sequence = nextSequence++;

        // Recorded for assertions.
        this.moves = [];
        this.unmaximizeCount = 0;
        this.maximizeCount = 0;
        this.raiseCount = 0;
        /** Set a width/height floor to emulate a client that refuses to
         *  shrink, which is how real applications break a tiling layout. */
        this.minWidth = 0;
        this.minHeight = 0;
    }

    get_title() {
        return this.title;
    }

    get_monitor() {
        return this.monitor;
    }

    get_frame_rect() {
        return {...this.frame};
    }

    get_stable_sequence() {
        return this.sequence;
    }

    get_workspace() {
        return {index: () => this.workspaceIndex};
    }

    allows_resize() {
        return this.resizable;
    }

    allows_move() {
        return this.movable;
    }

    is_fullscreen() {
        return this.fullscreen;
    }

    is_on_all_workspaces() {
        return this.onAllWorkspaces;
    }

    unmaximize(flags) {
        this.unmaximizeFlags = flags;
        this.unmaximizeCount++;
        this.maximized_horizontally = false;
        this.maximized_vertically = false;
    }

    maximize(flags) {
        this.maximizeFlags = flags;
        this.maximizeCount++;
        this.maximized_horizontally = true;
        this.maximized_vertically = true;
    }

    raise() {
        this.raiseCount++;
    }

    move_resize_frame(_userOp, x, y, width, height) {
        this.moves.push({x, y, width, height});
        this.frame = {
            x, y,
            width: Math.max(width, this.minWidth),
            height: Math.max(height, this.minHeight),
        };
    }

    /** The rect this window was last asked for, ignoring any clamping. */
    get lastRequest() {
        return this.moves.at(-1) ?? null;
    }
}

/** Group state with the same surface arranger.js expects from the real one. */
export class FakeModel {
    constructor({groups = [], workAreas = {0: {x: 0, y: 0, width: 1920, height: 1080}}} = {}) {
        // groups: [{arrangement, state, windows: [FakeWindow]}]
        this.groups = groups.map(g => ({
            arrangement: g.arrangement ?? 'free',
            state: g.state ?? {},
            windows: g.windows ?? [],
        }));
        this.workAreas = workAreas;
        this.stateWrites = [];
    }

    get count() {
        return this.groups.length;
    }

    arrangement(i) {
        return this.groups[i]?.arrangement ?? 'free';
    }

    layoutState(i) {
        return {gap: 8, outerGap: 8, ...(this.groups[i]?.state ?? {})};
    }

    setLayoutState(i, state) {
        this.groups[i].state = state;
        this.stateWrites.push({index: i, state});
    }

    windows(i) {
        return (this.groups[i]?.windows ?? [])
            .slice()
            .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
    }
}

/**
 * Shell bindings with a manually pumped scheduler, so tests control exactly
 * when deferred work runs and can prove that bursts coalesce.
 */
export class FakeEnv {
    constructor({workAreas, focusWindow = null, maximizeFlags = 'BOTH'} = {}) {
        this.maximizeFlags = maximizeFlags;
        this.workAreas = workAreas ?? {0: {x: 0, y: 0, width: 1920, height: 1080}};
        this.focusWindow = focusWindow;
        this.queue = [];
        this.deferCount = 0;
        this.cancelCount = 0;
    }

    getWorkAreaForMonitor(index) {
        return this.workAreas[index] ?? null;
    }

    getFocusWindow() {
        return this.focusWindow;
    }

    isManaged(win) {
        return win.managed !== false;
    }

    defer(fn) {
        this.deferCount++;
        const handle = {fn};
        this.queue.push(handle);
        return handle;
    }

    cancel(handle) {
        this.cancelCount++;
        this.queue = this.queue.filter(h => h !== handle);
    }

    /** Run everything currently queued. Returns how many callbacks ran. */
    flush() {
        let ran = 0;
        while (this.queue.length) {
            const {fn} = this.queue.shift();
            fn();
            ran++;
        }
        return ran;
    }
}
