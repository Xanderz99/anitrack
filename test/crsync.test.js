'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseItem, plan, createCrClient, syncOnce, WEB_CLIENT } = require('../src/crsync');

// A history entry shaped like crunchyroll.com's watch-history response.
const item = (series, season, episode, { at = '2026-10-10T20:00:00Z', playhead = 1400, duration = 1440000, fully = false } = {}) => ({
  panel: { id: `E${episode}`, title: `Episode ${episode}`, episode_metadata: { series_title: series, season_number: season, episode_number: episode, duration_ms: duration, series_id: 'G1' } },
  date_played: at,
  playhead,
  fully_watched: fully,
});
const entry = (mediaId, titles, status = 'CURRENT', progress = 0, episodes = 12) => ({ mediaId, titles, status, progress, episodes, title: titles[0] });

test('history entries: watched means past the threshold or marked fully watched', () => {
  assert.deepStrictEqual(parseItem(item('Dandadan', 1, 3), 0.9), { series: 'Dandadan', season: 1, episode: 3, at: Date.parse('2026-10-10T20:00:00Z'), watched: true, seriesId: 'G1' });
  assert.strictEqual(parseItem(item('Dandadan', 1, 3, { playhead: 300 }), 0.9).watched, false);
  assert.strictEqual(parseItem(item('Dandadan', 1, 3, { playhead: 0, fully: true }), 0.9).watched, true);
  assert.strictEqual(parseItem(item('Dandadan', 1, 12.5), 0.9), null, 'recaps and specials are skipped');
  assert.strictEqual(parseItem({ panel: { title: 'A movie' } }, 0.9), null);
});

test('plan: the furthest watched episode per season, matched to your list, never backwards', () => {
  const items = [item('Dandadan', 1, 5), item('Dandadan', 1, 4), item('Dandadan', 1, 6, { playhead: 100 }), item('Frieren: Beyond Journey’s End', 2, 3), item('Some Show', 1, 2)];
  const entries = [
    entry(1, ['Dandadan'], 'CURRENT', 3),
    entry(2, ['Frieren: Beyond Journey’s End', 'Sousou no Frieren'], 'CURRENT', 28, 28),
    entry(3, ['Frieren: Beyond Journey’s End Season 2', 'Sousou no Frieren 2nd Season'], 'PLANNING', 0),
  ];
  const p = plan(items, entries, {}, { threshold: 0.9 });
  assert.deepStrictEqual(
    p.marks.map((m) => [m.mediaId, m.ep, m.from]),
    [
      [1, 5, 3],
      [3, 3, 0],
    ]
  );
  assert.deepStrictEqual(p.unmatched.map((u) => [u.series, u.episode]), [['Some Show', 2]]);
  assert.deepStrictEqual(plan([item('Dandadan', 1, 2)], entries, {}).marks, [], 'already past it');
});

test('plan: links you chose win, ignored shows are left alone, old history is skipped', () => {
  const entries = [entry(9, ['Dandadan'], 'CURRENT', 0)];
  const key = 'dan da dan|1';
  assert.strictEqual(plan([item('DAN DA DAN', 1, 2)], entries, {}).marks.length, 0);
  assert.deepStrictEqual(plan([item('DAN DA DAN', 1, 2)], entries, { [key]: { mediaId: 9 } }).marks.map((m) => m.ep), [2]);
  assert.deepStrictEqual(plan([item('DAN DA DAN', 1, 2)], entries, { [key]: { ignore: true } }), { marks: [], unmatched: [], newest: Date.parse('2026-10-10T20:00:00Z') });
  assert.strictEqual(plan([item('Dandadan', 1, 2)], entries, {}, { since: Date.parse('2026-10-11T00:00:00Z') }).marks.length, 0);
});

// A fake crunchyroll.com: the sign-in grant, the account and two pages of history.
function fakeCrunchyroll({ signedIn = true, challenge = false, expireOnce = false } = {}) {
  const calls = [];
  let expired = expireOnce;
  const json = (status, body, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] || null }, json: async () => body });
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (challenge) return json(403, null, { 'cf-mitigated': 'challenge' });
    if (url.endsWith('/auth/v1/token')) return signedIn ? json(200, { access_token: `tok${calls.length}`, expires_in: 300, account_id: 'acc1' }) : json(401, { error: 'invalid_grant' });
    if (url.includes('/watch-history')) {
      if (expired) {
        expired = false;
        return json(401, {});
      }
      if (url.includes('page=2')) return json(200, { data: [item('Dandadan', 1, 2, { at: '2026-10-01T10:00:00Z' })], meta: {} });
      return json(200, { data: [item('Dandadan', 1, 4, { at: '2026-10-12T10:00:00Z' }), item('Dandadan', 1, 3, { at: '2026-10-11T10:00:00Z' })], meta: { next_page: '/content/v2/acc1/watch-history?page=2&page_size=100' } });
    }
    return json(404, {});
  };
  return { fetch, calls };
}
const memState = (init = {}) => {
  let v = { ...init };
  return { get: () => v, patch: (o) => (v = { ...v, ...o }) };
};

test('client: signs in with the session cookie grant, pages through history, stays on crunchyroll.com', async () => {
  const cr = fakeCrunchyroll();
  const state = memState();
  const client = createCrClient({ fetch: cr.fetch, state, now: () => Date.parse('2026-10-13T00:00:00Z') });
  const items = await client.history(0);
  assert.strictEqual(items.length, 3);
  const grant = cr.calls[0];
  assert.strictEqual(grant.init.method, 'POST');
  assert.strictEqual(grant.init.headers.Authorization, WEB_CLIENT);
  assert.match(grant.init.body, /grant_type=etp_rt_cookie/);
  assert.ok(state.get().deviceId, 'a device id is kept for next time');
  assert.match(grant.url, /^https:\/\/beta-api\.crunchyroll\.com\//, 'the API host first');
  assert.ok(cr.calls.slice(1).every((c) => c.url.startsWith('https://beta-api.crunchyroll.com/') && c.init.headers.Authorization === 'Bearer tok1'));
});

test('client: if the API host refuses, the website host is tried, and history follows the host that worked', async () => {
  const cr = fakeCrunchyroll();
  const fetch = (url, init) => (url.startsWith('https://beta-api.') ? Promise.resolve({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: 'invalid_client' }) }) : cr.fetch(url, init));
  const items = await createCrClient({ fetch, state: memState() }).history(0);
  assert.strictEqual(items.length, 3);
  assert.ok(cr.calls.every((c) => c.url.startsWith('https://www.crunchyroll.com/')));
});

test('client: a refused sign-in says what each host answered', async () => {
  const refuse = async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: 'invalid_grant' }) });
  await assert.rejects(createCrClient({ fetch: refuse, state: memState() }).history(0), (e) => e.kind === 'signed-out' && /beta-api\.crunchyroll\.com: 401 invalid_grant; www\.crunchyroll\.com: 401 invalid_grant/.test(e.message));
});

test('client: stops paging once history is older than needed; renews an expired token once', async () => {
  const cr = fakeCrunchyroll({ expireOnce: true });
  const client = createCrClient({ fetch: cr.fetch, state: memState(), now: () => Date.parse('2026-10-13T00:00:00Z') });
  const items = await client.history(Date.parse('2026-10-11T12:00:00Z'));
  assert.strictEqual(items.length, 2, 'the second page is not needed');
  assert.strictEqual(cr.calls.filter((c) => c.url.endsWith('/auth/v1/token')).length, 2, 'signed in again after the 401');
});

test('client: says why when signed out or when Crunchyroll wants a browser check', async () => {
  await assert.rejects(createCrClient({ fetch: fakeCrunchyroll({ signedIn: false }).fetch, state: memState() }).history(0), { kind: 'signed-out' });
  await assert.rejects(createCrClient({ fetch: fakeCrunchyroll({ challenge: true }).fetch, state: memState() }).history(0), { kind: 'challenge' });
});

test('sync: the first run looks back two weeks, later runs continue from the newest episode seen', async () => {
  const now = () => Date.parse('2026-10-13T00:00:00Z');
  const state = memState();
  const client = createCrClient({ fetch: fakeCrunchyroll().fetch, state, now });
  const first = await syncOnce({ client, state, entries: [entry(1, ['Dandadan'], 'CURRENT', 1)], threshold: 0.9, now });
  assert.strictEqual(first.since, now() - 14 * 86400e3);
  assert.deepStrictEqual(first.marks.map((m) => m.ep), [4]);
  state.patch({ newest: first.newest });
  const second = await syncOnce({ client, state, entries: [entry(1, ['Dandadan'], 'CURRENT', 4)], threshold: 0.9, now });
  assert.strictEqual(second.since, Date.parse('2026-10-12T10:00:00Z') - 3600e3);
  assert.deepStrictEqual(second.marks, []);
});
