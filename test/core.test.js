'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createCore, buildIcs, SEASONS_KEPT } = require('../src/core');

class MemStore {
  constructor(defaults) {
    this.data = JSON.parse(JSON.stringify(defaults));
  }
  get(k) {
    return this.data[k];
  }
  set(k, v) {
    this.data[k] = v;
  }
  patch(o) {
    Object.assign(this.data, o);
  }
}

const media = (id, extra = {}) => ({ id, title: { english: `Show ${id}`, romaji: `Show ${id}` }, genres: [], tags: [], episodes: 12, ...extra });
const listEntry = (id, status, progress, score = 0) => ({ status, score, progress, media: media(id) });

// A fake AniList: season shows, a user list, and a log of saved entries.
function setup({ token = 'tok', shows = [media(1), media(2)], list = [], saveError = null, now = () => new Date(2026, 9, 8).getTime() } = {}) {
  const saved = [];
  const listReads = [];
  const AL = {
    fetchSeason: async () => shows,
    fetchViewer: async () => ({ id: 7, name: 'me' }),
    fetchUserList: async (w, tok) => {
      listReads.push({ ...w, token: tok });
      return list;
    },
    fetchByIds: async (ids) => ids.map((id) => media(id)),
    saveEntry: async (_tok, e) => {
      if (saveError) throw saveError;
      saved.push(e);
      return {};
    },
  };
  const settings = new MemStore({ userName: token ? '' : 'me', token, viewerId: token ? 7 : null, viewerName: token ? 'me' : '' });
  const tracking = new MemStore({ accounts: {}, notified: {} });
  const cache = new MemStore({ seasons: {}, user: null, extra: null });
  const core = createCore({
    AL,
    settings,
    tracking,
    cache,
    getToken: () => settings.get('token') || null,
    clearToken: () => settings.patch({ token: '', viewerId: null, viewerName: '' }),
    now,
  });
  return { core, AL, settings, tracking, cache, saved, listReads };
}

test('progress starts watching, reaching the total completes, going back reopens', async () => {
  const { core, saved } = setup();
  await core.refresh({});
  let r = await core.setTrack(1, { progress: 3 });
  assert.deepStrictEqual(r.me, { status: 'WATCHING', progress: 3, inList: true });
  assert.ok(r.pushed);
  assert.deepStrictEqual(saved.at(-1), { mediaId: 1, progress: 3, status: 'CURRENT' });

  r = await core.setTrack(1, { progress: 99 });
  assert.strictEqual(r.me.status, 'COMPLETED');
  assert.strictEqual(r.me.progress, 12);
  assert.deepStrictEqual(saved.at(-1), { mediaId: 1, progress: 12, status: 'COMPLETED' });

  r = await core.setTrack(1, { progress: 11 });
  assert.strictEqual(r.me.status, 'WATCHING');
});

test('rewatching keeps AniList on REPEATING', async () => {
  const { core, saved } = setup({ list: [listEntry(1, 'REPEATING', 2)] });
  await core.refresh({});
  await core.setTrack(1, { progress: 3 });
  assert.deepStrictEqual(saved.at(-1), { mediaId: 1, progress: 3, status: null });
});

test('"Not interested" stays local', async () => {
  const { core, saved, tracking } = setup();
  await core.refresh({});
  const r = await core.setTrack(2, { status: 'SKIP' });
  assert.strictEqual(r.reason, 'local-only');
  assert.strictEqual(saved.length, 0);
  assert.ok(!core.tracking.get('items')[2].dirty);
});

test('logged-out tracking stays on the device until you choose to add it to your AniList', async () => {
  const { core, settings, saved } = setup({ token: '' });
  await core.refresh({});
  const r = await core.setTrack(1, { progress: 4 });
  assert.strictEqual(r.reason, 'not-logged-in');
  assert.ok(core.tracking.get('items')[1].dirty);
  await core.setTrack(2, { status: 'SKIP' });

  // Log in: the account starts from its own (empty) space, and nothing is sent by itself.
  settings.patch({ token: 'tok' });
  core.setViewer({ id: 7, name: 'me' });
  await core.refresh({ force: true });
  assert.deepStrictEqual(saved, []);
  assert.deepStrictEqual(core.meFor(1), { status: null, progress: 0, inList: false });
  assert.strictEqual(core.basePayload().guestItems, 2);

  assert.strictEqual(core.adoptGuest(), 2);
  await core.refresh({ force: true });
  assert.deepStrictEqual(saved, [{ mediaId: 1, progress: 4, status: 'CURRENT' }], '"Not interested" is adopted but stays local');
  assert.strictEqual(core.meFor(2).status, 'SKIP');
  assert.strictEqual(core.basePayload().pending, 0);
  assert.strictEqual(core.basePayload().guestItems, 0);
});

test("two accounts on one device never see or push each other's changes", async () => {
  const { core, settings, saved, AL } = setup();
  await core.refresh({});
  AL.saveEntry = async () => {
    throw new Error('offline');
  };
  await core.setTrack(1, { progress: 3 }); // account 7, left unsynced
  AL.saveEntry = async (_t, e) => saved.push(e);

  settings.patch({ token: 'tok2' });
  core.setViewer({ id: 8, name: 'other' });
  await core.refresh({ force: true });
  assert.deepStrictEqual(saved, [], "account 8 does not send account 7's change");
  assert.strictEqual(core.meFor(1).progress, 0);

  settings.patch({ token: 'tok' });
  core.setViewer({ id: 7, name: 'me' });
  await core.refresh({ force: true });
  assert.deepStrictEqual(saved, [{ mediaId: 1, progress: 3, status: 'CURRENT' }], 'account 7 gets it back and syncs it');
});

test('logged in, your own list is read by account id with your token (private lists work)', async () => {
  const { core, listReads } = setup();
  await core.refresh({});
  assert.deepStrictEqual(listReads, [{ userId: 7, token: 'tok' }]);
  assert.strictEqual(core.basePayload().account, 'me');

  const guest = setup({ token: '' });
  await guest.core.refresh({});
  assert.deepStrictEqual(guest.listReads, [{ userName: 'me', token: null }]);
});

test('data from before accounts moves to whoever was using the app', async () => {
  const settings = new MemStore({ token: 'tok', viewerName: 'me', viewerId: null, userName: 'me' });
  const tracking = new MemStore({ items: { 5: { status: 'WATCHING', progress: 2 } }, resume: { 5: { time: 60 } }, notified: { x: 1 } });
  const AL = { fetchSeason: async () => [], fetchUserList: async () => [], fetchByIds: async () => [], fetchViewer: async () => ({ id: 42, name: 'me' }) };
  const core = createCore({ AL, settings, tracking, cache: new MemStore({ seasons: {}, user: null, extra: null }), getToken: () => settings.get('token'), clearToken() {} });
  assert.strictEqual(tracking.get('items'), undefined);
  assert.deepStrictEqual(tracking.get('notified'), { x: 1 }, 'device-wide data stays');
  await core.refresh({}); // learns the account id
  assert.strictEqual(core.accountKey(), 'anilist:42');
  assert.deepStrictEqual(core.meFor(5), { status: 'WATCHING', progress: 2, inList: false });
  assert.deepStrictEqual(core.tracking.get('resume'), { 5: { time: 60 } });
  assert.ok(!tracking.get('accounts').legacy);
});

test('an expired token found while reading your list logs you out instead of erroring forever', async () => {
  const { core, settings, AL } = setup();
  AL.fetchUserList = async () => {
    throw Object.assign(new Error('Invalid token'), { status: 400 });
  };
  await core.refresh({});
  assert.strictEqual(settings.get('token'), '');
  assert.match(core.S.errors.sync, /login expired/);
});

test('a failed send stays pending, is retried on refresh, and says why meanwhile', async () => {
  const { core, AL, tracking, saved } = setup();
  await core.refresh({});
  const working = AL.saveEntry;
  AL.saveEntry = async () => {
    throw new Error('AniList returned HTTP 503');
  };
  const r = await core.setTrack(1, { progress: 2 });
  assert.match(r.error, /503/);
  assert.ok(core.tracking.get('items')[1].dirty);

  await core.refresh({ force: true });
  assert.ok(core.tracking.get('items')[1].dirty);
  assert.match(core.S.errors.sync, /will be retried/);

  AL.saveEntry = working;
  await core.refresh({ force: true });
  assert.ok(!core.tracking.get('items')[1].dirty);
  assert.deepStrictEqual(saved, [{ mediaId: 1, progress: 2, status: 'CURRENT' }]);
  assert.strictEqual(core.S.errors.sync, undefined);
});

test('an expired login is cleared instead of failing forever', async () => {
  const err = Object.assign(new Error('Invalid token'), { status: 400 });
  const { core, settings } = setup({ saveError: err });
  await core.refresh({});
  const r = await core.setTrack(1, { progress: 1 });
  assert.match(r.error, /login expired/);
  assert.strictEqual(settings.get('token'), '');
});

test('AniList wins for synced items; a higher remote episode count always wins', async () => {
  const { core, tracking } = setup({ token: '', list: [listEntry(1, 'CURRENT', 5), listEntry(2, 'PAUSED', 2)] });
  core.tracking.set('items', { 1: { status: 'WATCHING', progress: 3 }, 2: { status: 'WATCHING', progress: 1, dirty: true } });
  await core.refresh({});
  assert.deepStrictEqual(core.meFor(1), { status: 'WATCHING', progress: 5, inList: true });
  assert.deepStrictEqual(core.meFor(2), { status: 'WATCHING', progress: 2, inList: true }, 'unsynced status kept, higher remote progress taken');
});

test('switching season mid-load does not let the older load overwrite the newer one', async () => {
  const { core, AL } = setup();
  let releaseFall;
  AL.fetchSeason = (season) =>
    season === 'FALL' ? new Promise((r) => (releaseFall = () => r([media(10)]))) : Promise.resolve([media(20)]);
  const fall = core.refresh({ season: 'FALL', year: 2026, force: true });
  await core.refresh({ season: 'WINTER', year: 2027, force: true });
  releaseFall();
  await fall;
  assert.deepStrictEqual(core.S.season, { season: 'WINTER', year: 2027 });
  assert.deepStrictEqual(core.S.raw.map((r) => r.id), [20]);
});

test('only the most recent seasons stay cached', async () => {
  let t = 0;
  const { core, cache } = setup({ now: () => ++t });
  for (const [season, year] of [['WINTER', 2026], ['SPRING', 2026], ['SUMMER', 2026], ['FALL', 2026], ['WINTER', 2027]]) {
    await core.refresh({ season, year, force: true });
  }
  const keys = Object.keys(cache.get('seasons')).sort();
  assert.strictEqual(keys.length, SEASONS_KEPT);
  assert.deepStrictEqual(keys, ['FALL-2026', 'SPRING-2026', 'SUMMER-2026', 'WINTER-2027']);
});

test('a failed season load keeps the cached copy and reports the error', async () => {
  const { core, AL } = setup();
  await core.refresh({});
  AL.fetchSeason = async () => {
    throw new Error('Could not reach AniList.');
  };
  await core.refresh({ force: true });
  assert.strictEqual(core.S.raw.length, 2);
  assert.match(core.S.errors.season, /Could not reach AniList/);
});

test('upcoming lists tracked shows by air time', async () => {
  const at = new Date(2026, 9, 8).getTime() / 1000;
  const { core } = setup({
    shows: [media(1, { nextAiringEpisode: { episode: 3, airingAt: at + 7200 } }), media(2, { nextAiringEpisode: { episode: 5, airingAt: at + 60 } }), media(3, { nextAiringEpisode: { episode: 1, airingAt: at + 30 } })],
  });
  await core.refresh({});
  await core.setTrack(1, { status: 'WATCHING' });
  await core.setTrack(2, { status: 'PLANNING' });
  assert.deepStrictEqual(core.upcoming().map((x) => [x.id, x.ep]), [[2, 5], [1, 3]]);
});

test('calendar file escapes text and folds long lines', () => {
  const ics = buildIcs([{ id: 1, ep: 2, at: 1790000000, mins: 24, title: `Long, title; with \\ ${'x'.repeat(80)} ★` }], 0);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`);
  const unfolded = ics.replace(/\r\n /g, '');
  assert.match(unfolded, /SUMMARY:Long\\, title\\; with \\\\ x+ ★ - Episode 2/);
  assert.match(unfolded, /DTSTART:\d{8}T\d{6}Z/);
});

test('search finds any anime, and a tracked result joins your shows at once', async () => {
  const { core, AL } = setup();
  let asked = 0;
  AL.searchAnime = async () => {
    asked += 1;
    return [media(99, { externalLinks: [{ type: 'STREAMING', site: 'Netflix', url: 'https://www.netflix.com/x' }] })];
  };
  await core.refresh({});
  const r = await core.search('Old Show');
  assert.deepStrictEqual(r.map((x) => x.id), [99]);
  assert.strictEqual(r[0].offSeason, true);
  assert.deepStrictEqual(r[0].streams, [{ site: 'Netflix', url: 'https://www.netflix.com/x' }]);
  await core.search('old show ');
  assert.strictEqual(asked, 1, 'the same search is not asked twice');
  assert.deepStrictEqual(await core.search('x'), [], 'one letter is too short to search');

  await core.setTrack(99, { status: 'PLANNING' });
  assert.ok(core.basePayload().shows.some((s) => s.id === 99 && s.me.status === 'PLANNING'));
});

test('streams list Crunchyroll first and each service once', async () => {
  const links = [
    { type: 'STREAMING', site: 'Netflix', url: 'https://netflix.com/a' },
    { type: 'STREAMING', site: 'Crunchyroll', url: 'https://crunchyroll.com/a' },
    { type: 'STREAMING', site: 'Netflix', url: 'https://netflix.com/b' },
    { type: 'INFO', site: 'Official Site', url: 'https://example.com' },
    { type: 'STREAMING', site: 'Sketchy', url: 'http://insecure.example' },
  ];
  const { core } = setup({ shows: [media(1, { externalLinks: links })] });
  await core.refresh({});
  assert.deepStrictEqual(core.basePayload().shows[0].streams.map((x) => x.site), ['Crunchyroll', 'Netflix']);
});

test('rating saves to AniList and marks your taste for relearning', async () => {
  const { core, saved, cache, settings } = setup({ list: [listEntry(1, 'COMPLETED', 12)] });
  await core.refresh({});
  assert.deepStrictEqual(await core.rate(1, 8), { ok: true, score: 8 });
  assert.deepStrictEqual(saved.at(-1), { mediaId: 1, score: 8 });
  assert.strictEqual(core.S.list.find((e) => e.id === 1).score, 8);
  assert.strictEqual(cache.get('user').ts, 0);
  assert.strictEqual((await core.rate(1, 11)).ok, false);
  settings.patch({ token: '' });
  assert.match((await core.rate(1, 7)).error, /Log in/);
});

test('details: full synopsis, trailer, related seasons, and lookup of shows not loaded', async () => {
  const rich = media(1, {
    description: 'Line one.<br><br>Line <i>two</i>.',
    trailer: { site: 'youtube', id: 'abc123XYZ' },
    relations: { edges: [
      { relationType: 'SEQUEL', node: { id: 2, type: 'ANIME', format: 'TV', title: { english: 'Season 2' } } },
      { relationType: 'PREQUEL', node: { id: 3, type: 'ANIME', format: 'TV', title: { romaji: 'Zero' } } },
      { relationType: 'ADAPTATION', node: { id: 4, type: 'MANGA', title: { romaji: 'Manga' } } },
    ] },
  });
  const { core, AL } = setup({ shows: [rich] });
  await core.refresh({});
  const d = await core.details(1);
  assert.strictEqual(d.synopsis, 'Line one.\n\nLine two.');
  assert.strictEqual(d.trailer, 'https://www.youtube.com/watch?v=abc123XYZ');
  assert.deepStrictEqual(d.related.map((r) => [r.relation, r.title]), [['Prequel', 'Zero'], ['Sequel', 'Season 2']]);

  let looked = 0;
  AL.fetchByIds = async (ids) => (looked++, ids.map((id) => media(id)));
  assert.strictEqual((await core.details(77)).title, 'Show 77');
  await core.details(77);
  assert.strictEqual(looked, 1, 'a looked-up show is remembered');
});
