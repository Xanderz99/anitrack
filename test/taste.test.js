'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildTaste, scoreShow, summarizeTaste, listMapFrom, seasonFor, entryValue, scoreScale } = require('../src/taste');

const entry = (id, status, score, genres, tags = [], studio) => ({
  status,
  score,
  progress: 0,
  media: { id, genres, tags: tags.map(([name, rank]) => ({ name, rank })), ...(studio ? { studios: { nodes: [{ name: studio }] } } : {}) },
});
const entries = [
  entry(1, 'COMPLETED', 10, ['Action', 'Fantasy'], [['Male Protagonist', 90]]),
  entry(2, 'COMPLETED', 9, ['Action', 'Sci-Fi']),
  entry(3, 'COMPLETED', 8, ['Action', 'Comedy', 'Fantasy']),
  entry(4, 'DROPPED', 2, ['Romance', 'Slice of Life']),
  entry(5, 'DROPPED', 0, ['Romance', 'Comedy']),
  entry(6, 'DROPPED', 3, ['Slice of Life']),
  entry(7, 'PLANNING', 0, ['Horror']),
];
const taste = buildTaste(entries);
const fantasy = { genres: ['Action', 'Fantasy'], tags: [{ name: 'Male Protagonist', rank: 80 }], averageScore: 70 };
const romance = { genres: ['Romance', 'Slice of Life'], tags: [], averageScore: 70 };

test('liked genres outrank disliked ones, with reasons', () => {
  const a = scoreShow(fantasy, taste);
  const b = scoreShow(romance, taste);
  assert.ok(a.pct > b.pct + 20, `${a.pct} vs ${b.pct}`);
  assert.ok(a.pct <= 99 && b.pct >= 1, 'scores stay within 1..99');
  assert.ok(a.why.includes('Action'), 'explains the match');
  assert.ok(b.against.length > 0, 'explains what you usually skip');
});

test('no taste means no score; planning entries carry no signal', () => {
  assert.strictEqual(scoreShow(fantasy, null), null);
  assert.ok(!('Horror' in taste.genres));
});

test('summary lists what you like', () => {
  assert.ok(summarizeTaste(taste).likes.includes('Action'));
});

test('scores are read relative to how you use the scale', () => {
  // A harsh and a generous scorer who agree on the order of their shows end up with the same taste.
  const shows = (shift) => [
    entry(1, 'COMPLETED', 6 + shift, ['Action']),
    entry(2, 'COMPLETED', 6 + shift, ['Action']),
    entry(3, 'COMPLETED', 4 + shift, ['Romance']),
    entry(4, 'COMPLETED', 4 + shift, ['Romance']),
    entry(5, 'COMPLETED', 5 + shift, ['Comedy']),
  ];
  const harsh = buildTaste(shows(0));
  const generous = buildTaste(shows(4));
  assert.deepStrictEqual(harsh.genres, generous.genres);
  // Someone who rates everything 8-10 still dislikes the shows they gave an 8.
  assert.ok(generous.genres.Romance < 0, 'an 8 from a generous scorer reads as below average');
});

test('short lists fall back to the plain 10-point reading', () => {
  assert.deepStrictEqual(scoreScale([entry(1, 'COMPLETED', 9, [])]), { mean: 6.5, spread: 3.5 });
  assert.strictEqual(entryValue({ score: 10 }), 1);
  assert.strictEqual(entryValue({ score: 3 }), -1);
  assert.strictEqual(entryValue({ score: 0, status: 'DROPPED' }), -0.6);
  assert.strictEqual(entryValue({ score: 0, status: 'PLANNING' }), null);
});

test('defining tags count more than barely-applying ones', () => {
  const t = buildTaste([
    entry(1, 'COMPLETED', 10, ['Drama'], [['Strong', 100]]),
    entry(2, 'COMPLETED', 10, ['Drama'], [['Weak', 60]]),
  ]);
  assert.ok(t.tags.Strong > t.tags.Weak);
});

test('a studio you rate well lifts its new shows once you have seen two of theirs', () => {
  const list = [
    entry(1, 'COMPLETED', 10, ['Drama'], [], 'Good Studio'),
    entry(2, 'COMPLETED', 10, ['Action'], [], 'Good Studio'),
    entry(3, 'COMPLETED', 3, ['Drama'], [], 'Other'),
    entry(4, 'COMPLETED', 3, ['Action'], [], 'Other'),
    entry(5, 'COMPLETED', 6, ['Comedy']),
  ];
  const t = buildTaste(list);
  const show = (studio) => ({ genres: ['Comedy'], tags: [], averageScore: 70, studios: { nodes: [{ name: studio }] } });
  const good = scoreShow(show('Good Studio'), t);
  assert.ok(good.pct > scoreShow(show('Unknown'), t).pct);
  assert.ok(good.why.includes('Good Studio'));
  assert.ok(scoreShow(show('Other'), t).against.includes('Other'));
  // Tastes cached before studios were tracked still score.
  const { studios, studioCounts, ...old } = t;
  assert.ok(scoreShow(show('Good Studio'), old).pct >= 1);
});

test('list map and seasons', () => {
  assert.deepStrictEqual(listMapFrom(entries)[1], { status: 'COMPLETED', score: 10, progress: 0 });
  assert.deepStrictEqual(seasonFor(new Date(2026, 9, 8)), { season: 'FALL', year: 2026 });
  assert.deepStrictEqual(seasonFor(new Date(2027, 0, 1)), { season: 'WINTER', year: 2027 });
  assert.deepStrictEqual(seasonFor(new Date(2026, 6, 31)), { season: 'SUMMER', year: 2026 });
});
