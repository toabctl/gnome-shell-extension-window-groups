/* node --test search.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';

import {scoreWindow, rankWindows, NO_MATCH} from './search.js';

const W = (title, app = '', group = '') => ({title, app, group});

const WINDOWS = [
    W('BWI: LGB Server · Issue #6886', 'Firefox', 'lgbserver'),
    W('Disks', 'Disks', 'lgbserver'),
    W('New Document (Draft)', 'Text Editor', 'ranger'),
    W('feat(images/kserve): add lgbserver', 'Firefox', 'lgbserver'),
    W('Home', 'Files', 'deepstream'),
];

test('an empty query keeps everything, in the original order', () => {
    assert.deepEqual(rankWindows('', WINDOWS), WINDOWS);
    assert.deepEqual(rankWindows('   ', WINDOWS), WINDOWS);
});

test('non-matching queries return nothing', () => {
    assert.deepEqual(rankWindows('zzzz', WINDOWS), []);
    assert.equal(scoreWindow('zzzz', WINDOWS[0]), NO_MATCH);
});

test('matching is case insensitive', () => {
    assert.equal(rankWindows('DISKS', WINDOWS).length, 1);
    assert.equal(rankWindows('disks', WINDOWS)[0].title, 'Disks');
});

test('a title hit outranks an application hit', () => {
    const titleHit = W('Firefox news', 'Text Editor', 'work');
    const appHit = W('Something else', 'Firefox', 'work');
    assert.ok(scoreWindow('firefox', titleHit) < scoreWindow('firefox', appHit));
});

test('an application hit outranks a group hit', () => {
    const appHit = W('nothing', 'ranger', 'other');
    const groupHit = W('nothing', 'other', 'ranger');
    assert.ok(scoreWindow('ranger', appHit) < scoreWindow('ranger', groupHit));
});

test('a prefix match outranks a mid-string match in the same field', () => {
    const prefix = W('server logs');
    const middle = W('the server logs');
    assert.ok(scoreWindow('server', prefix) < scoreWindow('server', middle));
});

test('position never outweighs a better field, at any title length', () => {
    // The original scoring used at * 0.01, which crosses a field step once a
    // title exceeds ~1000 characters. Test the regime where that breaks, not
    // just a comfortable one.
    for (const pad of [0, 10, 300, 5000, 100000]) {
        const lateTitle = W(`${'x'.repeat(pad)}ranger`, 'nothing', 'nothing');
        const earlyApp = W('nothing', 'ranger', 'nothing');
        assert.ok(scoreWindow('ranger', lateTitle) < scoreWindow('ranger', earlyApp),
            `pad=${pad}: a title match must always beat an app match`);
    }
});

test('within a field, score increases strictly with position', () => {
    let previous = -Infinity;
    for (const at of [0, 1, 2, 5, 50, 500, 5000]) {
        const score = scoreWindow('needle', W(`${'x'.repeat(at)}needle`));
        assert.ok(score > previous,
            `position ${at} did not rank worse than the one before it`);
        previous = score;
    }
});

test('searching a group name finds every window in it', () => {
    const hits = rankWindows('lgbserver', WINDOWS);
    assert.equal(hits.length, 3);
    // The one with it in the title comes first, ahead of the group-only hits.
    assert.match(hits[0].title, /lgbserver/);
});

test('equal scores keep their original relative order', () => {
    const same = [W('alpha', 'App', 'G'), W('alpha', 'App', 'G'), W('alpha', 'App', 'G')];
    const tagged = same.map((w, i) => ({...w, id: i}));
    assert.deepEqual(rankWindows('alpha', tagged).map(w => w.id), [0, 1, 2]);
});

test('missing fields do not throw', () => {
    assert.doesNotThrow(() => scoreWindow('x', {}));
    assert.equal(scoreWindow('x', {}), NO_MATCH);
    assert.equal(scoreWindow('', {}), 0);
    assert.doesNotThrow(() => rankWindows('x', [{}, {title: undefined}]));
});

test('ranking never invents or loses entries', () => {
    for (const q of ['', 'e', 'server', 'DISKS', 'lgb', '#6886', '(']) {
        const out = rankWindows(q, WINDOWS);
        assert.ok(out.length <= WINDOWS.length, `${q}: grew`);
        assert.equal(new Set(out).size, out.length, `${q}: duplicated`);
        for (const w of out)
            assert.ok(WINDOWS.includes(w), `${q}: invented an entry`);
    }
});

test('scores are stable across calls', () => {
    for (const w of WINDOWS)
        assert.equal(scoreWindow('e', w), scoreWindow('e', w));
});
