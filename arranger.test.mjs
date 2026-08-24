/* node --test arranger.test.mjs
 *
 * Runs the real Arranger against fake windows. Covers the failures that
 * previously needed a VM and a screenshot to notice: laying out against the
 * wrong monitor, moving windows that must not be moved, and running a layout
 * pass far more often than a layout actually changed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {Arranger} from './arranger.js';
import {FakeWindow, FakeModel, FakeEnv} from './shell-stubs.mjs';

const AREA = {x: 0, y: 27, width: 1920, height: 1053};
const AREA2 = {x: 1920, y: 0, width: 1280, height: 1024};

function setup({groups, workAreas = {0: AREA}, focusWindow = null} = {}) {
    const model = new FakeModel({groups});
    const env = new FakeEnv({workAreas, focusWindow});
    return {model, env, arranger: new Arranger({model, env})};
}

const win = opts => new FakeWindow(opts);

/* ---- what may be tiled ------------------------------------------------ */

test('free never touches a window', () => {
    const w = win();
    const {arranger} = setup({groups: [{arrangement: 'free', windows: [w]}]});
    arranger.apply(0);
    assert.equal(w.moves.length, 0);
});

test('windows that must not be moved are excluded', () => {
    const cases = {
        minimized: win({minimized: true}),
        fullscreen: win({fullscreen: true}),
        'on all workspaces': win({onAllWorkspaces: true}),
        'not resizable': win({resizable: false}),
        'not movable': win({movable: false}),
        unmanaged: win({managed: false}),
    };
    for (const [label, w] of Object.entries(cases)) {
        const {arranger} = setup({groups: [{arrangement: 'columns', windows: [w]}]});
        arranger.apply(0);
        assert.equal(w.moves.length, 0, `${label} should not have been moved`);
    }
});

test('an excluded window does not take up a layout slot', () => {
    // Otherwise the tiled windows get laid out for n+1 and leave a hole.
    const ok1 = win();
    const skip = win({resizable: false});
    const ok2 = win();
    const {arranger} = setup({
        groups: [{arrangement: 'columns', windows: [ok1, skip, ok2]}],
    });
    arranger.apply(0);
    assert.equal(ok1.lastRequest.width, ok2.lastRequest.width);
    const spanned = ok2.lastRequest.x + ok2.lastRequest.width - ok1.lastRequest.x;
    assert.equal(spanned, AREA.width - 16, 'the two survivors should fill the area');
});

/* ---- per monitor ------------------------------------------------------ */

test('each monitor is laid out against its own work area', () => {
    const a1 = win({monitor: 0});
    const a2 = win({monitor: 0});
    const b1 = win({monitor: 1});
    const {arranger} = setup({
        groups: [{arrangement: 'columns', windows: [a1, a2, b1]}],
        workAreas: {0: AREA, 1: AREA2},
    });
    arranger.apply(0);

    for (const w of [a1, a2]) {
        assert.ok(w.lastRequest.x >= AREA.x && w.lastRequest.x < AREA.x + AREA.width,
            'monitor 0 window escaped monitor 0');
    }
    assert.ok(b1.lastRequest.x >= AREA2.x, 'monitor 1 window was placed on monitor 0');
    // The lone window on the second monitor gets its whole work area.
    assert.equal(b1.lastRequest.width, AREA2.width - 16);
});

test('a monitor with no work area is skipped, not crashed on', () => {
    const w = win({monitor: 3});
    const {arranger} = setup({groups: [{arrangement: 'columns', windows: [w]}]});
    assert.doesNotThrow(() => arranger.apply(0));
    assert.equal(w.moves.length, 0);
});

test('a window on no monitor is ignored', () => {
    const w = win({monitor: -1});
    const {arranger} = setup({groups: [{arrangement: 'columns', windows: [w]}]});
    arranger.apply(0);
    assert.equal(w.moves.length, 0);
});

/* ---- maximized and idempotence ---------------------------------------- */

test('a maximized window is unmaximized before being placed', () => {
    // It would otherwise ignore move_resize_frame entirely.
    const w = win({maximized: true});
    const {arranger} = setup({groups: [{arrangement: 'columns', windows: [w]}]});
    arranger.apply(0);
    assert.equal(w.unmaximizeCount, 1);
    // The flags are opaque here but must actually reach Meta.Window, which
    // rejects a call without them.
    assert.equal(w.unmaximizeFlags, 'BOTH');
    assert.equal(w.moves.length, 1);
});

test('a window already in place is not moved again', () => {
    const w = win();
    const {arranger} = setup({groups: [{arrangement: 'columns', windows: [w]}]});
    arranger.apply(0);
    assert.equal(w.moves.length, 1);
    arranger.apply(0);
    assert.equal(w.moves.length, 1, 'a second identical pass should be a no-op');
});

test('a client that refuses to shrink does not cause a correction loop', () => {
    const stubborn = win();
    stubborn.minWidth = 900;
    const other = win();
    const {arranger} = setup({
        groups: [{arrangement: 'columns', windows: [stubborn, other]}],
    });
    for (let i = 0; i < 5; i++)
        arranger.apply(0);
    assert.ok(stubborn.moves.length <= 5);
    // Every request is the same rect; we never chase the clamped result.
    const widths = new Set(stubborn.moves.map(m => m.width));
    assert.equal(widths.size, 1, 'the requested width should never change');
});

test('switching back to free restores the pre-tile geometry', () => {
    const w = win({frame: {x: 100, y: 200, width: 640, height: 480}});
    const {model, arranger} = setup({
        groups: [{arrangement: 'columns', windows: [w]}],
    });
    arranger.apply(0);
    assert.notDeepEqual(w.get_frame_rect(), {x: 100, y: 200, width: 640, height: 480});

    model.groups[0].arrangement = 'free';
    arranger.apply(0);
    assert.deepEqual(w.get_frame_rect(), {x: 100, y: 200, width: 640, height: 480});
});

test('a window that was maximized is re-maximized, not restored to a rect', () => {
    const w = win({maximized: true});
    const {model, arranger} = setup({
        groups: [{arrangement: 'columns', windows: [w]}],
    });
    arranger.apply(0);
    model.groups[0].arrangement = 'free';
    arranger.apply(0);
    assert.equal(w.maximizeCount, 1);
    assert.equal(w.maximizeFlags, 'BOTH');
});

test('restoring twice does nothing the second time', () => {
    const w = win();
    const {model, arranger} = setup({groups: [{arrangement: 'columns', windows: [w]}]});
    arranger.apply(0);
    model.groups[0].arrangement = 'free';
    arranger.apply(0);
    const after = w.moves.length;
    arranger.apply(0);
    assert.equal(w.moves.length, after);
    assert.equal(arranger.hasStash(w), false);
});

test('forget drops a window from the stash, so closed windows are not held', () => {
    // The stash keys on live window objects. Without this the map grows for
    // the life of the session, pinning every window that was ever tiled.
    const w = win();
    const {arranger} = setup({groups: [{arrangement: 'columns', windows: [w]}]});
    arranger.apply(0);
    assert.equal(arranger.hasStash(w), true);
    arranger.forget(w);
    assert.equal(arranger.hasStash(w), false);
});

test('forget is safe for a window that was never tiled', () => {
    const {arranger} = setup({groups: [{arrangement: 'free', windows: []}]});
    assert.doesNotThrow(() => arranger.forget(win()));
});

test('destroy releases the stash', () => {
    const w = win();
    const {arranger} = setup({groups: [{arrangement: 'columns', windows: [w]}]});
    arranger.apply(0);
    arranger.destroy();
    assert.equal(arranger.hasStash(w), false);
});

/* ---- scheduling ------------------------------------------------------- */

test('a burst of schedules coalesces into one pass', () => {
    const w = win();
    const {env, arranger} = setup({groups: [{arrangement: 'columns', windows: [w]}]});
    for (let i = 0; i < 20; i++)
        arranger.schedule(0);
    assert.equal(env.deferCount, 1, 'should have deferred exactly once');
    assert.equal(env.flush(), 1);
    assert.equal(w.moves.length, 1);
});

test('scheduling several groups runs each once', () => {
    const a = win();
    const b = win({workspace: 1});
    const {env, arranger} = setup({
        groups: [
            {arrangement: 'columns', windows: [a]},
            {arrangement: 'columns', windows: [b]},
        ],
    });
    arranger.scheduleAll();
    arranger.scheduleAll();
    env.flush();
    assert.equal(a.moves.length, 1);
    assert.equal(b.moves.length, 1);
});

test('out-of-range group indices are ignored', () => {
    const {env, arranger} = setup({groups: [{arrangement: 'columns', windows: []}]});
    for (const bad of [-1, 5, 1.5, NaN, undefined, null])
        arranger.schedule(bad);
    assert.equal(env.deferCount, 0);
});

test('destroy cancels pending work', () => {
    const w = win();
    const {env, arranger} = setup({groups: [{arrangement: 'columns', windows: [w]}]});
    arranger.schedule(0);
    arranger.destroy();
    assert.equal(env.cancelCount, 1);
    assert.equal(env.flush(), 0);
    assert.equal(w.moves.length, 0);
});

/* ---- absorbing a drag-resize ------------------------------------------ */

test('resizing a tiled column rewrites the ratios', () => {
    const a = win();
    const b = win();
    const {model, arranger} = setup({
        groups: [{arrangement: 'columns', windows: [a, b]}],
    });
    arranger.apply(0);
    a.frame = {...a.frame, width: a.frame.width + 300};

    assert.equal(arranger.absorbResize(a), true);
    assert.equal(model.stateWrites.length, 1);
    assert.ok(Array.isArray(model.stateWrites[0].state.ratios));
    assert.ok(model.stateWrites[0].state.ratios[0] >
        model.stateWrites[0].state.ratios[1]);
});

test('layouts with no adjustable axis refuse the resize', () => {
    for (const kind of ['free']) {
        const a = win();
        const b = win();
        const {model, arranger} = setup({groups: [{arrangement: kind, windows: [a, b]}]});
        assert.equal(arranger.absorbResize(a), false, kind);
        assert.equal(model.stateWrites.length, 0, kind);
    }
});

test('a lone window on a monitor has nothing to trade against', () => {
    const only = win();
    const {arranger} = setup({groups: [{arrangement: 'columns', windows: [only]}]});
    assert.equal(arranger.absorbResize(only), false);
});

test('absorbing a resize schedules exactly one relayout', () => {
    const a = win();
    const b = win();
    const {env, arranger} = setup({groups: [{arrangement: 'columns', windows: [a, b]}]});
    arranger.apply(0);
    a.frame = {...a.frame, width: a.frame.width + 200};
    arranger.absorbResize(a);
    assert.equal(env.deferCount, 1);
});
