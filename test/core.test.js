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
  const AL = {
    fetchSeason: async () => shows,
    fetchUserList: async () => list,
    fetchByIds: async (ids) => ids.map((id) => media(id)),
    saveEntry: async (_tok, e) => {
      if (saveError) throw saveError;
      saved.push(e);
      return {};
    },
  };
  const settings = new MemStore({ userName: 'me', token });
  const tracking = new MemStore({ items: {} });
  const cache = new MemStore({ seasons: {}, user: null, extra: null });
  const core = createCore({
    AL,
    settings,
    tracking,
    cache,
    getToken: () => settings.get('token') || null,
    clearToken: () => settings.patch({ token: '' }),
    now,
  });
  return { core, AL, settings, tracking, cache, saved };
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
  assert.ok(!tracking.get('items')[2].dirty);
});

test('changes made while logged out are sent after logging in', async () => {
  const { core, settings, tracking, saved } = setup({ token: '' });
  await core.refresh({});
  const r = await core.setTrack(1, { progress: 4 });
  assert.strictEqual(r.reason, 'not-logged-in');
  assert.ok(tracking.get('items')[1].dirty);
  assert.strictEqual(core.basePayload().pending, 1);

  settings.patch({ token: 'tok' });
  await core.refresh({ force: true });
  assert.deepStrictEqual(saved, [{ mediaId: 1, progress: 4, status: 'CURRENT' }]);
  assert.ok(!tracking.get('items')[1].dirty);
  assert.strictEqual(core.basePayload().pending, 0);
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
  assert.ok(tracking.get('items')[1].dirty);

  await core.refresh({ force: true });
  assert.ok(tracking.get('items')[1].dirty);
  assert.match(core.S.errors.sync, /will be retried/);

  AL.saveEntry = working;
  await core.refresh({ force: true });
  assert.ok(!tracking.get('items')[1].dirty);
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
  tracking.set('items', { 1: { status: 'WATCHING', progress: 3 }, 2: { status: 'WATCHING', progress: 1, dirty: true } });
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
