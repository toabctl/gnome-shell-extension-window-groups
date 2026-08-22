/* node --test model.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    padArray, moveItem, removeItem, indexOfName, chooseGroupSlot,
    contrastOn, luminance, chooseRehomeTarget, UNGROUPED,
} from './model.js';

/* ---- padArray --------------------------------------------------------- */

test('padArray grows to the requested length', () => {
    assert.deepEqual(padArray(['a'], 3, 'x'), ['a', 'x', 'x']);
    assert.deepEqual(padArray([], 2, ''), ['', '']);
});

test('padArray never shrinks, so stale state is not silently dropped', () => {
    assert.deepEqual(padArray(['a', 'b', 'c'], 1, 'x'), ['a', 'b', 'c']);
});

test('padArray copies rather than mutating its input', () => {
    const original = ['a'];
    padArray(original, 4, 'x');
    assert.deepEqual(original, ['a']);
});

test('padArray tolerates a non-array', () => {
    assert.deepEqual(padArray(undefined, 2, 'x'), ['x', 'x']);
    assert.deepEqual(padArray('nonsense', 2, 'x'), ['x', 'x']);
});

/* ---- moveItem --------------------------------------------------------- */

const BASE = ['A', 'B', 'C', 'D', 'E'];

test('moveItem has move semantics, matching reorder_workspace', () => {
    assert.deepEqual(moveItem(BASE, 0, 4), ['B', 'C', 'D', 'E', 'A']);
    assert.deepEqual(moveItem(BASE, 4, 0), ['E', 'A', 'B', 'C', 'D']);
    assert.deepEqual(moveItem(BASE, 1, 3), ['A', 'C', 'D', 'B', 'E']);
});

test('moveItem differs from a swap for every non-adjacent move', () => {
    const swap = (v, a, b) => {
        const o = v.slice();
        [o[a], o[b]] = [o[b], o[a]];
        return o;
    };
    for (const [from, to] of [[0, 4], [4, 0], [1, 3], [3, 1], [0, 2]]) {
        assert.notDeepEqual(moveItem(BASE, from, to), swap(BASE, from, to),
            `${from}->${to} must not coincide with a swap`);
    }
    // ...and agrees with it for adjacent ones, which is why the bug hid.
    for (const [from, to] of [[0, 1], [1, 0], [3, 4]])
        assert.deepEqual(moveItem(BASE, from, to), swap(BASE, from, to));
});

test('moveItem round-trips', () => {
    for (let from = 0; from < BASE.length; from++) {
        for (let to = 0; to < BASE.length; to++)
            assert.deepEqual(moveItem(moveItem(BASE, from, to), to, from), BASE);
    }
});

test('moveItem ignores out-of-range indices instead of corrupting', () => {
    for (const [from, to] of [[-1, 2], [2, -1], [9, 0], [0, 9], [2, 2]])
        assert.deepEqual(moveItem(BASE, from, to), BASE);
});

test('moveItem preserves length and contents', () => {
    for (let from = 0; from < BASE.length; from++) {
        for (let to = 0; to < BASE.length; to++) {
            const out = moveItem(BASE, from, to);
            assert.equal(out.length, BASE.length);
            assert.deepEqual([...out].sort(), [...BASE].sort());
        }
    }
});

/* ---- removeItem ------------------------------------------------------- */

test('removeItem drops exactly one entry', () => {
    assert.deepEqual(removeItem(BASE, 2), ['A', 'B', 'D', 'E']);
    assert.deepEqual(removeItem(BASE, 0), ['B', 'C', 'D', 'E']);
    assert.deepEqual(removeItem(BASE, -1), BASE);
    assert.deepEqual(removeItem(BASE, 99), BASE);
});

/* ---- indexOfName ------------------------------------------------------ */

test('indexOfName is case and whitespace insensitive', () => {
    const names = ['Main', ' Side ', 'deep stream'];
    assert.equal(indexOfName(names, 'main'), 0);
    assert.equal(indexOfName(names, 'SIDE'), 1);
    assert.equal(indexOfName(names, '  deep stream'), 2);
    assert.equal(indexOfName(names, 'missing'), -1);
});

test('indexOfName never matches an unnamed group', () => {
    // Otherwise every auto-created group would claim the first blank slot by
    // name and they would all collapse into one.
    assert.equal(indexOfName(['', '', 'x'], ''), -1);
    assert.equal(indexOfName(['', '', 'x'], '   '), -1);
    assert.equal(indexOfName(['', '', 'x'], null), -1);
});

/* ---- chooseGroupSlot -------------------------------------------------- */

const slot = (names, windowCounts, name, cap = 16) =>
    chooseGroupSlot({names, windowCounts, name, cap});

test('an existing group is reused by name', () => {
    assert.deepEqual(slot(['Main', 'Work'], [1, 2], 'work'),
        {action: 'existing', index: 1});
});

test('an unnamed empty group is recycled before appending', () => {
    assert.deepEqual(slot(['Main', '', ''], [3, 0, 0], 'New'),
        {action: 'reuse', index: 1});
});

test('a named empty group is not stolen', () => {
    assert.deepEqual(slot(['Main', 'Scratch'], [1, 0], 'New'),
        {action: 'append', index: -1});
});

test('an unnamed but occupied group is not stolen', () => {
    assert.deepEqual(slot(['Main', ''], [1, 2], 'New'),
        {action: 'append', index: -1});
});

test('appending stops at the cap', () => {
    const names = Array.from({length: 16}, (_, i) => `g${i}`);
    const counts = names.map(() => 1);
    assert.deepEqual(slot(names, counts, 'New', 16), {action: 'refuse', index: -1});
    assert.deepEqual(slot(names.slice(0, 15), counts.slice(0, 15), 'New', 16),
        {action: 'append', index: -1});
});

test('the cap never blocks reuse of an existing or empty group', () => {
    const names = Array.from({length: 20}, (_, i) => (i === 7 ? '' : `g${i}`));
    const counts = names.map((_, i) => (i === 7 ? 0 : 1));
    assert.deepEqual(slot(names, counts, 'New', 4), {action: 'reuse', index: 7});
    assert.deepEqual(slot(names, counts, 'g3', 4), {action: 'existing', index: 3});
});

test('a missing window count is treated as empty, not as a crash', () => {
    assert.deepEqual(slot(['Main', ''], [1], 'New'), {action: 'reuse', index: 1});
});

/* ---- chooseRehomeTarget ----------------------------------------------- */

const rehome = (names, removing) => chooseRehomeTarget({names, removing});

test('an existing Ungrouped group is reused', () => {
    assert.deepEqual(rehome(['Work', UNGROUPED, 'Chat'], 0),
        {action: 'existing', index: 1});
});

test('the fallback is matched case-insensitively', () => {
    assert.deepEqual(rehome(['Work', 'ungrouped'], 0),
        {action: 'existing', index: 1});
});

test('without one, it is created rather than dumping into a neighbour', () => {
    // Dropping the windows into whichever group happens to be adjacent is
    // what this replaced: it silently merged unrelated work.
    assert.deepEqual(rehome(['Work', 'Chat', 'Docs'], 1),
        {action: 'create', index: -1});
});

test('dissolving the fallback itself falls back to a neighbour', () => {
    assert.deepEqual(rehome([UNGROUPED, 'Work'], 0),
        {action: 'existing', index: 1});
    assert.deepEqual(rehome(['Work', UNGROUPED], 1),
        {action: 'existing', index: 0});
});

test('the last remaining group cannot be dissolved', () => {
    assert.deepEqual(rehome(['Work'], 0), {action: 'refuse', index: -1});
    assert.deepEqual(rehome([UNGROUPED], 0), {action: 'refuse', index: -1});
    assert.deepEqual(rehome([], 0), {action: 'refuse', index: -1});
});

test('the target is never the group being removed', () => {
    const names = ['a', 'b', UNGROUPED, 'd'];
    for (let i = 0; i < names.length; i++) {
        const {action, index} = rehome(names, i);
        if (action === 'existing')
            assert.notEqual(index, i, `group ${i} was rehomed into itself`);
    }
});

/* ---- contrast --------------------------------------------------------- */

const PALETTE = {
    grey: '#5f6368', blue: '#4285f4', red: '#ea4335', yellow: '#fbbc04',
    green: '#34a853', pink: '#ff8bcb', purple: '#a142f4', cyan: '#24c1e0',
    orange: '#fa903e',
};

test('ink is dark exactly when the fill is light', () => {
    for (const [name, hex] of Object.entries(PALETTE)) {
        const dark = contrastOn(hex) === 'rgba(0,0,0,0.85)';
        assert.equal(dark, luminance(hex) > 0.45,
            `${name} (${hex}) picked the wrong ink for its luminance`);
    }
});

test('the extremes are unambiguous', () => {
    assert.equal(contrastOn('#ffffff'), 'rgba(0,0,0,0.85)');
    assert.equal(contrastOn('#000000'), '#ffffff');
});

test('yellow reads dark and blue reads light, as in Chrome', () => {
    assert.equal(contrastOn(PALETTE.yellow), 'rgba(0,0,0,0.85)');
    assert.equal(contrastOn(PALETTE.blue), '#ffffff');
    assert.equal(contrastOn(PALETTE.purple), '#ffffff');
});

test('luminance is monotonic along a grey ramp', () => {
    let previous = -1;
    for (const v of ['00', '20', '40', '80', 'c0', 'ff']) {
        const l = luminance(`#${v}${v}${v}`);
        assert.ok(l > previous, `grey ${v} was not brighter than the last`);
        previous = l;
    }
});
