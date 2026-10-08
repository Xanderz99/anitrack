'use strict';
const assert = require('assert');
const { buildTaste, scoreShow, summarizeTaste, listMapFrom, seasonFor } = require('../src/taste');
const { makeDubMatcher } = require('../src/dubs');

const entry = (id, status, score, genres, tags = []) => ({ status, score, progress: 0, media: { id, genres, tags: tags.map(([name, rank]) => ({ name, rank })) } });
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
const a = scoreShow(fantasy, taste);
const b = scoreShow(romance, taste);
assert.ok(a.pct > b.pct + 20, `liked genres should outrank disliked ones (${a.pct} vs ${b.pct})`);
assert.ok(a.pct <= 99 && b.pct >= 1, 'scores stay within 1..99');
assert.ok(a.why.includes('Action'), 'explains the match');
assert.ok(b.against.length > 0, 'explains what you usually skip');
assert.strictEqual(scoreShow(fantasy, null), null, 'no taste means no score');
assert.ok(!('Horror' in taste.genres), 'unscored planning entries carry no signal');

const sum = summarizeTaste(taste);
assert.ok(sum.likes.includes('Action'));

assert.deepStrictEqual(listMapFrom(entries)[1], { status: 'COMPLETED', score: 10, progress: 0 });
assert.deepStrictEqual(seasonFor(new Date(2026, 9, 8)), { season: 'FALL', year: 2026 });
assert.deepStrictEqual(seasonFor(new Date(2027, 0, 1)), { season: 'WINTER', year: 2027 });
assert.deepStrictEqual(seasonFor(new Date(2026, 6, 31)), { season: 'SUMMER', year: 2026 });

const dub = makeDubMatcher(null);
const t = (english, romaji) => ({ title: { english, romaji } });
assert.strictEqual(dub(t('Overgeared', 'Tempal: Item no Chikara')), 'announced');
assert.strictEqual(dub(t("A Returner's Magic Should be Special Season 2", 'Kikansha no Mahou wa Tokubetsu desu 2nd Season')), 'announced');
assert.strictEqual(dub(t('The Laid-Off Cheat-Granting Mage Enjoys a Second Lease on Life', 'x')), 'announced');
assert.strictEqual(dub(t("As a Reincarnated Aristocrat, I'll Use My Appraisal Skill to Rise in the World Season 3", 'x')), 'announced');
assert.strictEqual(dub(t('PSYREN', 'PSYЯEN')), 'tbd');
assert.strictEqual(dub(t(null, 'Some Unlisted Show')), null);

console.log('taste + dub tests passed');
