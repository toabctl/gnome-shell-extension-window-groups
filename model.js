/* model.js
 *
 * The arithmetic behind groups: parallel-array bookkeeping, name lookup,
 * slot selection and colour contrast. No GNOME imports — this is the layer
 * that used to be welded to Gio.Settings, which is why the swap-versus-splice
 * reorder bug could only be found by staring at a screenshot.
 */

/** Grow `values` to `count` entries, padding with `fill`. Never shrinks: a
 *  longer array means state exists for groups that are gone, and dropping it
 *  here would silently discard a group's colour during an unrelated write. */
export function padArray(values, count, fill) {
    const out = Array.isArray(values) ? values.slice() : [];
    while (out.length < count)
        out.push(fill);
    return out;
}

/** Move one entry, shifting the rest.
 *
 *  This must be a splice, not a swap. Mutter's reorder_workspace() lifts the
 *  workspace out and reinserts it; a swap only coincides with that for
 *  adjacent positions, so any longer drag desynchronises every parallel array
 *  from the workspaces they describe.
 */
export function moveItem(values, from, to) {
    const out = values.slice();
    if (from === to || from < 0 || to < 0 ||
        from >= out.length || to >= out.length)
        return out;
    const [item] = out.splice(from, 1);
    out.splice(to, 0, item);
    return out;
}

export function removeItem(values, index) {
    const out = values.slice();
    if (index < 0 || index >= out.length)
        return out;
    out.splice(index, 1);
    return out;
}

/** Case-insensitive, whitespace-tolerant lookup. -1 if absent. */
export function indexOfName(names, name) {
    const wanted = String(name ?? '').trim().toLowerCase();
    if (!wanted)
        return -1;
    return names.findIndex(n => String(n ?? '').trim().toLowerCase() === wanted);
}

/**
 * Decide where a group called `name` should live.
 *
 * @param {object} opts
 * @param {string[]} opts.names stored names, '' meaning never named
 * @param {number[]} opts.windowCounts windows per group, same length
 * @param {string} opts.name the group being asked for
 * @param {number} opts.cap most groups we will ever create
 * @returns {{action: 'existing'|'reuse'|'append'|'refuse', index: number}}
 *   `index` is -1 for 'append' (caller appends) and 'refuse'.
 */
export function chooseGroupSlot({names, windowCounts, name, cap}) {
    const existing = indexOfName(names, name);
    if (existing !== -1)
        return {action: 'existing', index: existing};

    // Reuse an unnamed, empty group before appending. Static workspaces GNOME
    // creates up front would otherwise linger as empty clutter above every
    // group that named itself.
    for (let i = 0; i < names.length; i++) {
        const unnamed = String(names[i] ?? '').trim() === '';
        if (unnamed && (windowCounts[i] ?? 0) === 0)
            return {action: 'reuse', index: i};
    }

    if (names.length >= cap)
        return {action: 'refuse', index: -1};
    return {action: 'append', index: -1};
}

/** The group windows fall back into when their own group is dissolved. */
export const UNGROUPED = 'Ungrouped';

/**
 * Where the windows of a group should go when that group is removed.
 *
 * A window is always on some workspace and a group *is* a workspace, so
 * "no group" has to be a real group. It is created on demand rather than
 * reserved up front, so someone who never dissolves a group never sees it.
 *
 * @param {object} opts
 * @param {string[]} opts.names stored names, '' meaning never named
 * @param {number} opts.removing index of the group being dissolved
 * @returns {{action: 'existing'|'create'|'refuse', index: number}}
 *   'refuse' when there is nowhere sensible to put them.
 */
export function chooseRehomeTarget({names, removing}) {
    if (names.length <= 1)
        return {action: 'refuse', index: -1};

    const ungrouped = indexOfName(names, UNGROUPED);

    // Dissolving the fallback itself would send its windows to itself.
    if (ungrouped === removing) {
        const neighbour = removing === 0 ? 1 : removing - 1;
        return {action: 'existing', index: neighbour};
    }

    if (ungrouped !== -1)
        return {action: 'existing', index: ungrouped};
    return {action: 'create', index: -1};
}

/**
 * Black or white ink for a filled swatch, by sRGB relative luminance.
 * Chrome's yellow group needs dark text where its blue needs light.
 *
 * @param {string} hex `#rrggbb`
 */
export function contrastOn(hex) {
    const channel = pair => {
        const c = parseInt(pair, 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance =
        0.2126 * channel(hex.slice(1, 3)) +
        0.7152 * channel(hex.slice(3, 5)) +
        0.0722 * channel(hex.slice(5, 7));
    return luminance > 0.45 ? 'rgba(0,0,0,0.85)' : '#ffffff';
}

/** Relative luminance, exposed so tests can assert the threshold rather than
 *  hard-coding which palette entries happen to fall either side of it. */
export function luminance(hex) {
    const channel = pair => {
        const c = parseInt(pair, 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(hex.slice(1, 3)) +
        0.7152 * channel(hex.slice(3, 5)) +
        0.0722 * channel(hex.slice(5, 7));
}
