'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { norm, base, seasonOf, parseEpisode, parseNetflix, pickEntry, nextSave, linkKey } = require('../extension/match');

test('titles compare without punctuation, dubs or season markers', () => {
  assert.strictEqual(norm('Frieren: Beyond Journey’s End (English Dub)'), 'frieren beyond journeys end');
  assert.strictEqual(base('Frieren: Beyond Journey’s End Season 2'), 'frieren beyond journeys end');
  assert.strictEqual(base('Sousou no Frieren 2nd Season'), 'sousou no frieren');
  assert.strictEqual(base('Mushoku Tensei II'), 'mushoku tensei');
  assert.deepStrictEqual(['Season 3', '2nd Season', 'Mushoku Tensei II', 'Kaiju No. 8', 'Mob Psycho 100', 'Re:Zero Season Two', 'Spy x Family Part 2'].map(seasonOf), [3, 2, 2, null, null, 2, null]);
  assert.strictEqual(base('Kaiju No. 8'), 'kaiju no 8');
});

test('the episode comes from page data first, then the heading, then the tab title', () => {
  const url = '/watch/GABC123/some-episode';
  assert.strictEqual(parseEpisode({ url: '/series/GABC/x', h1: 'E3 - Title' }), null, 'not a watch page');
  const ld = [{ '@context': 'https://schema.org', '@type': 'TVEpisode', episodeNumber: '3', partOfSeason: { seasonNumber: 2 }, partOfSeries: { name: 'Frieren: Beyond Journey’s End' } }];
  assert.deepStrictEqual(parseEpisode({ url, jsonld: ld }), { series: 'Frieren: Beyond Journey’s End', season: 2, episode: 3, source: 'page data' });
  assert.deepStrictEqual(parseEpisode({ url, jsonld: [{ '@graph': ld }] }).episode, 3, 'inside an @graph too');
  assert.deepStrictEqual(parseEpisode({ url, h1: 'E12 - The Finale', series: 'Dandadan' }), { series: 'Dandadan', season: null, episode: 12, source: 'page' });
  assert.deepStrictEqual(parseEpisode({ url, h1: 'S2 E4 - Title', series: 'Dandadan' }).season, 2);
  assert.deepStrictEqual(parseEpisode({ url, docTitle: 'Watch Solo Leveling Season 2 Episode 5 - Title - Crunchyroll' }), { series: 'Solo Leveling', season: 2, episode: 5, source: 'tab title' });
  assert.deepStrictEqual(parseEpisode({ url, h1: 'E7 - Title', docTitle: 'Crunchyroll' }), { series: null, season: null, episode: 7, source: null, partial: true });
  assert.strictEqual(parseEpisode({ url, h1: 'E12.5 - Recap', series: 'X' }).episode, 12.5);
});

const entry = (mediaId, titles, status = 'CURRENT', progress = 0, episodes = 12) => ({ mediaId, titles, status, progress, episodes, title: titles[0] });

test('picks the right season of a show on your list', () => {
  const list = [
    entry(1, ['Frieren: Beyond Journey’s End', 'Sousou no Frieren'], 'COMPLETED', 28, 28),
    entry(2, ['Frieren: Beyond Journey’s End Season 2', 'Sousou no Frieren 2nd Season'], 'CURRENT', 2),
    entry(3, ['Dandadan'], 'PLANNING', 0),
  ];
  assert.strictEqual(pickEntry({ series: 'Frieren: Beyond Journey’s End', season: 2, episode: 3 }, list).entry.mediaId, 2);
  assert.strictEqual(pickEntry({ series: 'Frieren: Beyond Journey’s End', season: null, episode: 3 }, list).entry.mediaId, 2, 'the one you are watching');
  assert.strictEqual(pickEntry({ series: 'DAN DA DAN', season: 1, episode: 1 }, list).entry, null, 'different spelling: link it by hand');
  assert.strictEqual(pickEntry({ series: 'Dandadan', season: 1, episode: 1 }, list).entry.mediaId, 3);
  assert.strictEqual(pickEntry({ series: 'One Piece', season: 1, episode: 1 }, list).why, 'not on your list');
});

test('two equally good matches are not guessed', () => {
  const list = [entry(1, ['Show A'], 'CURRENT', 2), entry(2, ['Show A'], 'CURRENT', 2)];
  const r = pickEntry({ series: 'Show A', season: null, episode: 3 }, list);
  assert.strictEqual(r.entry, null);
  assert.strictEqual(r.candidates.length, 2);
});

test('a show you linked by hand wins, with its episode numbering', () => {
  const info = { series: 'DAN DA DAN', season: 1, episode: 14 };
  const list = [entry(3, ['Dandadan'], 'CURRENT', 1)];
  const r = pickEntry(info, list, { [linkKey(info)]: { mediaId: 3, offset: 12 } });
  assert.deepStrictEqual([r.entry.mediaId, r.offset, r.why], [3, 12, 'linked']);
});

test('what to save: next episodes count, the last completes, nothing goes backwards', () => {
  const e = entry(5, ['X'], 'PLANNING', 2, 12);
  assert.deepStrictEqual(nextSave(e, 3), { save: { mediaId: 5, progress: 3, status: 'CURRENT' } });
  assert.deepStrictEqual(nextSave(e, 12).save.status, 'COMPLETED');
  assert.strictEqual(nextSave(e, 2).skip, 'already marked');
  assert.match(nextSave(e, 13).skip, /past the 12/);
  assert.strictEqual(nextSave(e, 12.5).skip, 'not a numbered episode');
  assert.strictEqual(nextSave({ ...e, status: 'REPEATING' }, 3).save.status, 'REPEATING');
  assert.strictEqual(nextSave({ ...e, episodes: null }, 40).save.progress, 40, 'ongoing shows have no total');
});

test('the manifest loads only files that exist, and asks for nothing beyond AniList and storage', () => {
  const dir = path.join(__dirname, '..', 'extension');
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const files = [m.background.service_worker, ...m.background.scripts, m.action.default_popup, ...Object.values(m.icons), ...m.content_scripts.flatMap((c) => c.js)];
  for (const f of files) assert.ok(fs.existsSync(path.join(dir, f)), `${f} is missing`);
  assert.deepStrictEqual(m.permissions, ['storage']);
  assert.deepStrictEqual(m.host_permissions, ['https://graphql.anilist.co/*']);
});

test('Netflix: the player title gives the show, season and episode', () => {
  const url = '/watch/81234567';
  assert.deepStrictEqual(parseNetflix({ url, show: 'Kaiju No. 8', parts: ['S2:E3', 'The Man Called Isao'] }), { series: 'Kaiju No. 8', season: 2, episode: 3, source: 'netflix', site: 'netflix' });
  assert.deepStrictEqual(parseNetflix({ url, show: 'Dandadan', parts: ['E7', 'Title'] }).episode, 7, 'one-season shows say just E7');
  assert.strictEqual(parseNetflix({ url, show: 'Dandadan', parts: ['Episode 4', 'Title'] }).episode, 4);
  assert.strictEqual(parseNetflix({ url, show: 'A Film', parts: [] }).partial, true, 'films have no episode');
  assert.strictEqual(parseNetflix({ url: '/browse', show: 'X', parts: ['E1'] }), null, 'not a watch page');
  // and it matches the right season on your list like Crunchyroll does
  const list = [
    { mediaId: 1, titles: ['Kaiju No. 8'], status: 'COMPLETED', progress: 12, episodes: 12, title: 'Kaiju No. 8' },
    { mediaId: 2, titles: ['Kaiju No. 8 Season 2', 'Kaijuu 8-gou 2nd Season'], status: 'CURRENT', progress: 2, episodes: 11, title: 'Kaiju No. 8 Season 2' },
  ];
  assert.strictEqual(pickEntry(parseNetflix({ url, show: 'Kaiju No. 8', parts: ['S2:E3'] }), list).entry.mediaId, 2);
});
