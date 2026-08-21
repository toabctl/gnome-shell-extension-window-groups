/* layouts.js
 *
 * Pure geometry. No GNOME imports, deliberately — everything here is
 * (count, area, state) -> rects, so it can be unit tested with plain node in
 * milliseconds instead of by screenshotting a virtual machine.
 *
 * A rect is {x, y, width, height} in integer pixels.
 * An area is the same, and is whatever the caller considers usable — for the
 * shell that is one monitor's work area, already excluding panels.
 */

export const LAYOUTS = [
    'free',
    'tabbed',
    'columns',
    'rows',
    'grid',
    'master-stack',
];

export const DEFAULT_STATE = {
    gap: 8,          // between tiles
    outerGap: 8,     // between tiles and the edge of the area
    ratios: null,    // relative weights per slot; null means equal
    masterRatio: 0.6,
};

/** Smallest tile we will ever emit. Below this, windows are unusable and
 *  clients clamp to their own minimum anyway, which would desynchronise the
 *  layout from what is on screen. */
const MIN_TILE = 1;

function inset(area, by) {
    return {
        x: area.x + by,
        y: area.y + by,
        width: Math.max(MIN_TILE, area.width - 2 * by),
        height: Math.max(MIN_TILE, area.height - 2 * by),
    };
}

function normalise(weights, n) {
    if (!Array.isArray(weights) || weights.length !== n)
        return Array(n).fill(1);
    const clean = weights.map(w =>
        Number.isFinite(w) && w > 0 ? w : 1);
    return clean;
}

/**
 * Divide `length` starting at `start` into `weights.length` slices separated
 * by `gap`.
 *
 * Boundaries are accumulated as exact fractions and rounded once each, so
 * slice i+1 starts exactly where slice i ended. Rounding each slice's *width*
 * independently instead would leak a pixel per slice and leave visible seams.
 *
 * @returns {Array<{offset: number, size: number}>}
 */
function split(start, length, weights, gap) {
    const n = weights.length;
    if (n === 0)
        return [];
    if (n === 1)
        return [{offset: start, size: Math.max(MIN_TILE, length)}];

    const usable = length - gap * (n - 1);
    if (usable < n * MIN_TILE) {
        // Not enough room to honour the gaps. Give every slice the floor and
        // let them touch; a cramped layout beats a negative one.
        const size = Math.max(MIN_TILE, Math.floor(length / n));
        return Array.from({length: n}, (_, i) => ({
            offset: start + i * size,
            size,
        }));
    }

    const total = weights.reduce((a, b) => a + b, 0);
    const out = [];
    let acc = 0;
    let prevEdge = 0;
    for (let i = 0; i < n; i++) {
        acc += weights[i] / total;
        const edge = i === n - 1 ? usable : Math.round(usable * acc);
        out.push({
            offset: start + prevEdge + i * gap,
            size: Math.max(MIN_TILE, edge - prevEdge),
        });
        prevEdge = edge;
    }
    return out;
}

/** How many items go in each row of a grid of `n` items. */
export function gridShape(n) {
    if (n <= 0)
        return [];
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const perRow = Array(rows).fill(Math.floor(n / rows));
    let remainder = n % rows;
    for (let i = 0; remainder > 0; i++, remainder--)
        perRow[i]++;
    return perRow;
}

function columns(n, area, state) {
    const w = normalise(state.ratios, n);
    return split(area.x, area.width, w, state.gap).map(s => ({
        x: s.offset, y: area.y, width: s.size, height: area.height,
    }));
}

function rows(n, area, state) {
    const w = normalise(state.ratios, n);
    return split(area.y, area.height, w, state.gap).map(s => ({
        x: area.x, y: s.offset, width: area.width, height: s.size,
    }));
}

function grid(n, area, state) {
    const perRow = gridShape(n);
    const bands = split(area.y, area.height, Array(perRow.length).fill(1), state.gap);
    const out = [];
    perRow.forEach((count, r) => {
        const band = bands[r];
        for (const s of split(area.x, area.width, Array(count).fill(1), state.gap)) {
            out.push({
                x: s.offset, y: band.offset,
                width: s.size, height: band.size,
            });
        }
    });
    return out;
}

function masterStack(n, area, state) {
    if (n === 1)
        return [{...area}];

    const ratio = Math.min(0.9, Math.max(0.1, state.masterRatio));
    const [left, right] =
        split(area.x, area.width, [ratio, 1 - ratio], state.gap);

    const stackWeights = normalise(
        state.ratios ? state.ratios.slice(1) : null, n - 1);
    const stack = split(area.y, area.height, stackWeights, state.gap);

    return [
        {x: left.offset, y: area.y, width: left.size, height: area.height},
        ...stack.map(s => ({
            x: right.offset, y: s.offset, width: right.size, height: s.size,
        })),
    ];
}

const IMPLEMENTATIONS = {
    tabbed: (n, area) => Array.from({length: n}, () => ({...area})),
    columns,
    rows,
    grid,
    'master-stack': masterStack,
};

/**
 * @param {string} kind one of LAYOUTS
 * @param {number} count how many windows to place
 * @param {{x: number, y: number, width: number, height: number}} area
 * @param {object} [state] see DEFAULT_STATE
 * @returns {Array<object>|null} one rect per window, or null for 'free',
 *   meaning "do not touch these windows at all"
 */
export function computeLayout(kind, count, area, state = {}) {
    if (kind === 'free')
        return null;
    const impl = IMPLEMENTATIONS[kind];
    if (!impl)
        throw new Error(`unknown layout: ${kind}`);
    if (count <= 0)
        return [];

    const merged = {...DEFAULT_STATE, ...state};
    return impl(count, inset(area, merged.outerGap), merged);
}

/**
 * Turn a user's drag-resize into new layout state, so resizing a tiled window
 * edits the layout instead of being snapped away.
 *
 * @param {string} kind
 * @param {number} count
 * @param {number} index which window was resized
 * @param {object} rect the frame the user dragged it to
 * @param {object} area the same area passed to computeLayout
 * @param {object} [state]
 * @returns {object} the state to store; unchanged if the layout has no
 *   adjustable axis for that window
 */
export function resizeToState(kind, count, index, rect, area, state = {}) {
    const merged = {...DEFAULT_STATE, ...state};
    const inner = inset(area, merged.outerGap);

    if (kind === 'master-stack' && count > 1) {
        const usable = inner.width - merged.gap;
        if (usable <= 0)
            return merged;
        const ratio = index === 0
            ? rect.width / usable
            : 1 - rect.width / usable;
        return {...merged, masterRatio: Math.min(0.9, Math.max(0.1, ratio))};
    }

    if (kind === 'columns' || kind === 'rows') {
        const along = kind === 'columns' ? 'width' : 'height';
        const current = normalise(merged.ratios, count);
        if (count < 2)
            return merged;

        const totalWeight = current.reduce((a, b) => a + b, 0);
        const usable = inner[along] - merged.gap * (count - 1);
        if (usable <= 0)
            return merged;

        // Grow or shrink the resized slot, and take the difference out of its
        // neighbour so the rest of the layout does not shift.
        const wanted = Math.max(MIN_TILE, rect[along]) / usable * totalWeight;
        const neighbour = index === count - 1 ? index - 1 : index + 1;
        const pair = current[index] + current[neighbour];
        const clamped = Math.min(pair - 0.05 * totalWeight,
            Math.max(0.05 * totalWeight, wanted));

        const ratios = current.slice();
        ratios[index] = clamped;
        ratios[neighbour] = pair - clamped;
        return {...merged, ratios};
    }

    return merged;
}
