// SPDX-FileCopyrightText: 2026 Thomas Bechtold
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

/* search.js
 *
 * Ranking for the window search popup. No GNOME imports, so it can be unit
 * tested with plain node. Ordering rules are exactly the sort of thing that
 * looks fine in a screenshot with three windows and is wrong with thirty.
 */

/** No match. */
export const NO_MATCH = -1;

/** Field weights: a hit in the title beats one in the application name,
 *  which beats one in the group name. Lower is better. */
const FIELD_PENALTY = {title: 0, app: 10, group: 20};

/**
 * @param {string} query what the user typed
 * @param {{title?: string, app?: string, group?: string}} entry
 * @returns {number} score, lower is better; NO_MATCH if the entry is out
 */
export function scoreWindow(query, entry) {
    const q = query.trim().toLowerCase();
    if (!q)
        return 0;

    let best = NO_MATCH;
    for (const [field, penalty] of Object.entries(FIELD_PENALTY)) {
        const hay = (entry[field] ?? '').toLowerCase();
        const at = hay.indexOf(q);
        if (at === -1)
            continue;
        // Earlier hits rank higher, but a position term must never let a
        // weak field overtake a strong one. at/(at+100) is monotonic in `at`
        // and provably in [0, 1), so it can never cross a penalty step of 10
        // however long the title is. A separate prefix bonus was redundant:
        // at === 0 already yields the minimum.
        const score = penalty + at / (at + 100);
        if (best === NO_MATCH || score < best)
            best = score;
    }
    return best;
}

/**
 * Filter and order entries for display.
 *
 * @param {string} query
 * @param {Array<object>} entries
 * @returns {Array<object>} matching entries, best first, input order preserved
 *   among equal scores
 */
export function rankWindows(query, entries) {
    return entries
        .map((entry, index) => ({entry, index, score: scoreWindow(query, entry)}))
        .filter(x => x.score !== NO_MATCH)
        .sort((a, b) => a.score - b.score || a.index - b.index)
        .map(x => x.entry);
}
