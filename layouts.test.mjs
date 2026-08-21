/* Unit tests for layouts.js. Run with:  node --test layouts.test.mjs
 *
 * These exist because geometry bugs are invisible in a screenshot until they
 * are large, and this session already had two "verified" results that came
 * from a lying harness. Everything here runs in milliseconds with no VM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    LAYOUTS, DEFAULT_STATE, computeLayout, resizeToState, gridShape,
} from './layouts.js';

const AREA = {x: 0, y: 27, width: 1920, height: 1053};
const TILING = LAYOUTS.filter(k => k !== 'free');

function overlaps(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width &&
           a.y < b.y + b.height && b.y < a.y + a.height;
}

function assertInvariants(rects, area, state, label) {
    const inner = {
        x: area.x + state.outerGap,
        y: area.y + state.outerGap,
        width: area.width - 2 * state.outerGap,
        height: area.height - 2 * state.outerGap,
    };
    for (const [i, r] of rects.entries()) {
        for (const v of [r.x, r.y, r.width, r.height]) {
            assert.ok(Number.isInteger(v), `${label}: rect ${i} not integral: ${v}`);
        }
        assert.ok(r.width >= 1 && r.height >= 1,
            `${label}: rect ${i} degenerate ${r.width}x${r.height}`);
        assert.ok(r.x >= inner.x && r.y >= inner.y,
            `${label}: rect ${i} starts before the inner area`);
        assert.ok(r.x + r.width <= inner.x + inner.width + 1,
            `${label}: rect ${i} overflows right edge`);
        assert.ok(r.y + r.height <= inner.y + inner.height + 1,
            `${label}: rect ${i} overflows bottom edge`);
    }
}

test('free means do not touch', () => {
    assert.equal(computeLayout('free', 3, AREA), null);
});

test('unknown layout is an error, not a silent no-op', () => {
    assert.throws(() => computeLayout('sideways', 2, AREA), /unknown layout/);
});

test('every tiling layout returns one rect per window', () => {
    for (const kind of TILING) {
        for (let n = 1; n <= 9; n++) {
            const rects = computeLayout(kind, n, AREA);
            assert.equal(rects.length, n, `${kind} with ${n}`);
        }
    }
});

test('zero windows yields no rects', () => {
    for (const kind of TILING)
        assert.deepEqual(computeLayout(kind, 0, AREA), []);
});

test('rects are integral, non-degenerate and inside the area', () => {
    for (const kind of TILING) {
        for (let n = 1; n <= 9; n++) {
            assertInvariants(computeLayout(kind, n, AREA), AREA,
                DEFAULT_STATE, `${kind}/${n}`);
        }
    }
});

test('tiles never overlap, except tabbed where they all coincide', () => {
    for (const kind of TILING) {
        for (let n = 2; n <= 9; n++) {
            const rects = computeLayout(kind, n, AREA);
            for (let i = 0; i < rects.length; i++) {
                for (let j = i + 1; j < rects.length; j++) {
                    const hit = overlaps(rects[i], rects[j]);
                    if (kind === 'tabbed')
                        assert.ok(hit, 'tabbed tiles should coincide');
                    else
                        assert.ok(!hit, `${kind}/${n}: ${i} overlaps ${j}`);
                }
            }
        }
    }
});

test('columns tile the width exactly, with no seams', () => {
    for (let n = 1; n <= 12; n++) {
        const rects = computeLayout('columns', n, AREA);
        const usable = AREA.width - 2 * DEFAULT_STATE.outerGap;
        const spanned = rects.at(-1).x + rects.at(-1).width - rects[0].x;
        assert.equal(spanned, usable, `columns/${n} does not span the width`);
        for (let i = 1; i < n; i++) {
            const gap = rects[i].x - (rects[i - 1].x + rects[i - 1].width);
            assert.equal(gap, DEFAULT_STATE.gap,
                `columns/${n}: seam between ${i - 1} and ${i} is ${gap}`);
        }
    }
});

test('rows tile the height exactly, with no seams', () => {
    for (let n = 1; n <= 12; n++) {
        const rects = computeLayout('rows', n, AREA);
        const usable = AREA.height - 2 * DEFAULT_STATE.outerGap;
        const spanned = rects.at(-1).y + rects.at(-1).height - rects[0].y;
        assert.equal(spanned, usable, `rows/${n} does not span the height`);
        for (let i = 1; i < n; i++) {
            const gap = rects[i].y - (rects[i - 1].y + rects[i - 1].height);
            assert.equal(gap, DEFAULT_STATE.gap, `rows/${n}: seam at ${i}`);
        }
    }
});

test('tabbed gives every window the whole inner area', () => {
    const rects = computeLayout('tabbed', 4, AREA);
    for (const r of rects) {
        assert.deepEqual(r, {
            x: AREA.x + DEFAULT_STATE.outerGap,
            y: AREA.y + DEFAULT_STATE.outerGap,
            width: AREA.width - 2 * DEFAULT_STATE.outerGap,
            height: AREA.height - 2 * DEFAULT_STATE.outerGap,
        });
    }
});

test('grid shape distributes items as evenly as possible', () => {
    assert.deepEqual(gridShape(1), [1]);
    assert.deepEqual(gridShape(2), [2]);
    assert.deepEqual(gridShape(4), [2, 2]);
    assert.deepEqual(gridShape(5), [3, 2]);
    assert.deepEqual(gridShape(7), [3, 2, 2]);
    for (let n = 1; n <= 30; n++) {
        const shape = gridShape(n);
        assert.equal(shape.reduce((a, b) => a + b, 0), n, `grid ${n} loses items`);
        assert.ok(Math.max(...shape) - Math.min(...shape) <= 1,
            `grid ${n} is lopsided: ${shape}`);
    }
});

test('master-stack gives the master the configured share', () => {
    const rects = computeLayout('master-stack', 3, AREA, {masterRatio: 0.7});
    const usable = AREA.width - 2 * DEFAULT_STATE.outerGap - DEFAULT_STATE.gap;
    assert.ok(Math.abs(rects[0].width / usable - 0.7) < 0.01,
        `master got ${rects[0].width / usable}`);
    // the stack shares one column
    assert.equal(rects[1].x, rects[2].x);
    assert.equal(rects[1].width, rects[2].width);
});

test('master-stack with one window uses the whole area', () => {
    const [only] = computeLayout('master-stack', 1, AREA);
    assert.equal(only.width, AREA.width - 2 * DEFAULT_STATE.outerGap);
});

test('ratios are honoured', () => {
    const rects = computeLayout('columns', 3, AREA, {ratios: [3, 1, 1]});
    const usable = AREA.width - 2 * DEFAULT_STATE.outerGap - 2 * DEFAULT_STATE.gap;
    assert.ok(Math.abs(rects[0].width / usable - 0.6) < 0.01);
    assert.ok(Math.abs(rects[1].width - rects[2].width) <= 1);
});

test('bad ratios fall back to equal instead of producing NaN', () => {
    for (const bad of [[0, 0, 0], [NaN, 1, 1], [-5, 1, 1], [1, 1], 'nonsense']) {
        const rects = computeLayout('columns', 3, AREA, {ratios: bad});
        assertInvariants(rects, AREA, DEFAULT_STATE, `ratios=${bad}`);
    }
});

test('absurdly small areas still produce usable rects', () => {
    const tiny = {x: 0, y: 0, width: 20, height: 12};
    for (const kind of TILING) {
        for (let n = 1; n <= 6; n++) {
            const rects = computeLayout(kind, n, tiny);
            assert.equal(rects.length, n);
            for (const r of rects) {
                assert.ok(r.width >= 1 && r.height >= 1,
                    `${kind}/${n} degenerate in a tiny area`);
                assert.ok(Number.isInteger(r.x) && Number.isInteger(r.width));
            }
        }
    }
});

test('layout is deterministic', () => {
    for (const kind of TILING) {
        assert.deepEqual(
            computeLayout(kind, 5, AREA),
            computeLayout(kind, 5, AREA), kind);
    }
});

test('resize round-trips: the dragged edge is what you get back', () => {
    const state = {...DEFAULT_STATE};
    const before = computeLayout('columns', 3, AREA, state);
    const wanted = {...before[0], width: before[0].width + 200};
    const after = resizeToState('columns', 3, 0, wanted, AREA, state);
    const rects = computeLayout('columns', 3, AREA, after);
    assert.ok(Math.abs(rects[0].width - wanted.width) <= 2,
        `wanted ${wanted.width}, got ${rects[0].width}`);
    // the third column must not have moved
    assert.equal(rects[2].x + rects[2].width, before[2].x + before[2].width);
});

test('resize clamps rather than collapsing a neighbour', () => {
    // Assert on the state, not the rendered rects: normalise() repairs a
    // non-positive ratio, so checking only the output width silently passes
    // even with the clamp removed.
    for (const width of [10000, -500, 0, 1]) {
        const dragged = {x: 0, y: 0, width, height: 100};
        const after = resizeToState('columns', 2, 0, dragged, AREA, DEFAULT_STATE);
        const total = after.ratios.reduce((a, b) => a + b, 0);
        for (const [i, r] of after.ratios.entries()) {
            assert.ok(r > 0, `width ${width}: ratio ${i} is ${r}`);
            assert.ok(r / total >= 0.04,
                `width ${width}: ratio ${i} collapsed to ${(r / total).toFixed(3)}`);
        }
        const rects = computeLayout('columns', 2, AREA, after);
        assert.ok(rects[1].width > 10, `neighbour collapsed to ${rects[1].width}`);
    }
});

test('resizing master-stack adjusts the master ratio both ways', () => {
    const grown = resizeToState('master-stack', 3, 0,
        {width: 1400, height: 100, x: 0, y: 0}, AREA, DEFAULT_STATE);
    assert.ok(grown.masterRatio > DEFAULT_STATE.masterRatio);
    const shrunk = resizeToState('master-stack', 3, 0,
        {width: 400, height: 100, x: 0, y: 0}, AREA, DEFAULT_STATE);
    assert.ok(shrunk.masterRatio < DEFAULT_STATE.masterRatio);
    for (const s of [grown, shrunk])
        assert.ok(s.masterRatio >= 0.1 && s.masterRatio <= 0.9);
});

test('fuzz: invariants hold across random shapes', () => {
    // Deterministic PRNG so a failure is reproducible.
    let seed = 20260821;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    for (let iter = 0; iter < 3000; iter++) {
        const kind = TILING[Math.floor(rand() * TILING.length)];
        const n = 1 + Math.floor(rand() * 12);
        const area = {
            x: Math.floor(rand() * 400),
            y: Math.floor(rand() * 400),
            width: 60 + Math.floor(rand() * 3000),
            height: 40 + Math.floor(rand() * 2000),
        };
        const state = {
            gap: Math.floor(rand() * 24),
            outerGap: Math.floor(rand() * 24),
            masterRatio: 0.1 + rand() * 0.8,
            ratios: rand() < 0.5
                ? Array.from({length: n}, () => rand() * 5) : null,
        };
        const rects = computeLayout(kind, n, area, state);
        assert.equal(rects.length, n);
        for (const r of rects) {
            assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y) &&
                      Number.isInteger(r.width) && Number.isInteger(r.height),
                `${kind}/${n} iter ${iter}: non-integral rect`);
            assert.ok(r.width >= 1 && r.height >= 1,
                `${kind}/${n} iter ${iter}: degenerate ${JSON.stringify(r)}`);
        }
        if (kind !== 'tabbed') {
            for (let i = 0; i < rects.length; i++) {
                for (let j = i + 1; j < rects.length; j++) {
                    assert.ok(!overlaps(rects[i], rects[j]),
                        `${kind}/${n} iter ${iter}: ${i} overlaps ${j}`);
                }
            }
        }
    }
});
