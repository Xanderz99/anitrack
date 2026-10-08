'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeDubMatcher } = require('../src/dubs');

const t = (english, romaji) => ({ title: { english, romaji } });

test('matches announced dubs by title', () => {
  const dub = makeDubMatcher(null);
  assert.strictEqual(dub(t('Overgeared', 'Tempal: Item no Chikara')), 'announced');
  assert.strictEqual(dub(t("A Returner's Magic Should be Special Season 2", 'Kikansha no Mahou wa Tokubetsu desu 2nd Season')), 'announced');
  assert.strictEqual(dub(t('The Laid-Off Cheat-Granting Mage Enjoys a Second Lease on Life', 'x')), 'announced');
  assert.strictEqual(dub(t("As a Reincarnated Aristocrat, I'll Use My Appraisal Skill to Rise in the World Season 3", 'x')), 'announced');
  assert.strictEqual(dub(t('PSYREN', 'PSYЯEN')), 'tbd');
  assert.strictEqual(dub(t(null, 'Some Unlisted Show')), null);
});

test('only whole words match', () => {
  const dub = makeDubMatcher(null);
  assert.strictEqual(dub(t('Overgeared', null)), 'announced');
  assert.strictEqual(dub(t('Overgearedness', null)), null);
  assert.strictEqual(dub(t('Black Cloverleaf', null)), null);
});

test('dubs.json adds titles, and a broken file is ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anitrack-'));
  const file = path.join(dir, 'dubs.json');
  fs.writeFileSync(file, JSON.stringify({ announced: ['My Extra Show'], tbd: ['Maybe Show'] }));
  const dub = makeDubMatcher(file);
  assert.strictEqual(dub(t('My Extra Show Season 2', null)), 'announced');
  assert.strictEqual(dub(t('Maybe Show', null)), 'tbd');
  fs.writeFileSync(file, '{ not json');
  assert.strictEqual(makeDubMatcher(file)(t('Overgeared', null)), 'announced');
});
