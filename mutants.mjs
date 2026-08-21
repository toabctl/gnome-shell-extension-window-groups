/* mutants.mjs — the mutation gate.
 *
 * A green suite proves nothing on its own. Twice in this project a test
 * passed with the behaviour it named deliberately removed: the layout
 * resize-clamp test (normalise() repaired the bad value it produced) and the
 * search position cap (the assertion never reached the regime it protected).
 *
 * Each entry below breaks the implementation in a way a real change might.
 * Every one must make at least one test fail. If a mutant survives, the tests
 * are not testing what they claim.
 *
 * Run: node mutants.mjs
 */
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';

const MUTANTS = [
    // ---- layouts.js
    ['layouts.js', 'layouts.test.mjs',
        'const edge = i === n - 1 ? usable : Math.round(usable * acc);',
        'const edge = prevEdge + Math.round(usable * weights[i] / total);',
        'round each slice independently (leaves seams)'],
    ['layouts.js', 'layouts.test.mjs',
        'return impl(count, inset(area, merged.outerGap), merged);',
        'return impl(count, area, merged);',
        'forget the outer gap'],
    ['layouts.js', 'layouts.test.mjs',
        'const cols = Math.ceil(Math.sqrt(n));',
        'const cols = Math.floor(Math.sqrt(n)) || 1;',
        'off-by-one in the grid shape'],
    ['layouts.js', 'layouts.test.mjs',
        `const clamped = Math.min(pair - 0.05 * totalWeight,
            Math.max(0.05 * totalWeight, wanted));`,
        'const clamped = wanted;',
        'drop the resize clamp'],
    ['layouts.js', 'layouts.test.mjs',
        'if (kind === \'free\')\n        return null;',
        'if (kind === \'free\')\n        return [];',
        'free returns [] instead of null'],

    // ---- search.js
    ['search.js', 'search.test.mjs',
        'penalty + at / (at + 100)', 'penalty + at * 0.01',
        'unbounded position term'],
    ['search.js', 'search.test.mjs',
        'penalty + at / (at + 100)', 'penalty',
        'ignore match position'],
    ['search.js', 'search.test.mjs',
        '{title: 0, app: 10, group: 20}', '{title: 0, app: 0, group: 0}',
        'flatten the field weights'],
    ['search.js', 'search.test.mjs',
        'const q = query.trim().toLowerCase();', 'const q = query.trim();',
        'case sensitive matching'],
    ['search.js', 'search.test.mjs',
        'a.score - b.score || a.index - b.index', 'b.score - a.score',
        'reverse the ordering'],

    // ---- model.js
    ['model.js', 'model.test.mjs',
        'const [item] = out.splice(from, 1);\n    out.splice(to, 0, item);',
        '[out[from], out[to]] = [out[to], out[from]];',
        'reorder by swapping instead of splicing'],
    ['model.js', 'model.test.mjs',
        'while (out.length < count)', 'while (out.length !== count)',
        'padArray also truncates'],
    ['model.js', 'model.test.mjs',
        'if (!wanted)\n        return -1;', 'if (false)\n        return -1;',
        'let the empty name match an unnamed group'],
    ['model.js', 'model.test.mjs',
        'if (unnamed && (windowCounts[i] ?? 0) === 0)', 'if (unnamed)',
        'recycle an unnamed group even when it holds windows'],
    ['model.js', 'model.test.mjs',
        'return luminance > 0.45', 'return luminance > 0.05',
        'wrong contrast threshold'],

    // ---- arranger.js
    ['arranger.js', 'arranger.test.mjs',
        'const area = this._env.getWorkAreaForMonitor(monitor);',
        'const area = this._env.getWorkAreaForMonitor(0);',
        'lay every monitor out against monitor 0'],
    ['arranger.js', 'arranger.test.mjs',
        '!win.is_on_all_workspaces() &&\n            win.allows_resize() &&',
        '!win.is_on_all_workspaces() &&',
        'tile windows that refuse to resize'],
    ['arranger.js', 'arranger.test.mjs',
        '            win.allows_move();', '            true;',
        'tile windows that cannot be moved'],
    ['arranger.js', 'arranger.test.mjs',
        'if (win.maximized_horizontally || win.maximized_vertically)\n            win.unmaximize(this._env.maximizeFlags);',
        '',
        'place a maximized window without unmaximizing'],
    ['arranger.js', 'arranger.test.mjs',
        `        if (now.x === rect.x && now.y === rect.y &&
            now.width === rect.width && now.height === rect.height)
            return;`,
        '',
        'always move, even when already in place'],
    ['arranger.js', 'arranger.test.mjs',
        'if (this._handle !== null)\n            return;', '',
        'defer once per schedule instead of coalescing'],
    ['arranger.js', 'arranger.test.mjs',
        'if (RIGID_LAYOUTS.has(kind))\n            return false;', '',
        'absorb resizes for layouts with no adjustable axis'],
    ['arranger.js', 'arranger.test.mjs',
        'forget(win) {\n        this._preTile.delete(win);',
        'forget(win) {',
        'forget() stops releasing the stash (leak)'],
    ['arranger.js', 'arranger.test.mjs',
        'this._preTile.delete(win);\n            if (stash.maximized) {',
        'if (stash.maximized) {',
        'restore leaves the stash behind'],
    ['arranger.js', 'arranger.test.mjs',
        'this._preTile.clear();', '',
        'destroy leaks the stash'],
    ['arranger.js', 'arranger.test.mjs',
        'win.unmaximize(this._env.maximizeFlags);', 'win.unmaximize();',
        'call unmaximize without the flags Meta requires'],
];

function run(testFile) {
    try {
        execFileSync(process.execPath, ['--test', testFile],
            {stdio: 'pipe', encoding: 'utf8'});
        return true;   // all passed
    } catch {
        return false;  // something failed
    }
}

let survivors = 0;
const originals = new Map();
for (const [file] of MUTANTS) {
    if (!originals.has(file))
        originals.set(file, readFileSync(file, 'utf8'));
}

console.log(`Applying ${MUTANTS.length} mutants\n`);
for (const [file, testFile, from, to, label] of MUTANTS) {
    const original = originals.get(file);
    if (!original.includes(from)) {
        console.log(`  SKIP    ${label}\n          (target text not found in ${file})`);
        survivors++;
        continue;
    }
    writeFileSync(file, original.replace(from, to));
    const stillGreen = run(testFile);
    writeFileSync(file, original);

    if (stillGreen) {
        console.log(`  SURVIVED ${label}  [${file}]`);
        survivors++;
    } else {
        console.log(`  killed   ${label}`);
    }
}

// Everything must be back exactly as it was.
for (const [file, original] of originals)
    writeFileSync(file, original);

console.log();
if (survivors) {
    console.log(`${survivors}/${MUTANTS.length} mutants survived — the tests do not`);
    console.log('pin the behaviour they claim to.');
    process.exit(1);
}
console.log(`all ${MUTANTS.length} mutants killed`);
