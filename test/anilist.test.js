'use strict';
const test = require('node:test');
const assert = require('node:assert');
const AL = require('../src/anilist');

AL.config.sleep = async () => {};

// Replaces fetch with a queue of canned responses and records each request.
function mockFetch(t, responses) {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return {
      status: r.status || 200,
      ok: (r.status || 200) < 400,
      headers: { get: (h) => (r.headers || {})[h.toLowerCase()] ?? null },
      json: async () => {
        if (r.json === undefined) throw new Error('not json');
        return r.json;
      },
    };
  };
  t.after(() => (global.fetch = real));
  return calls;
}

test('returns data and sends the token only when given', async (t) => {
  const calls = mockFetch(t, [{ json: { data: { Viewer: { id: 1, name: 'me' } } } }, { json: { data: { x: 1 } } }]);
  assert.deepStrictEqual(await AL.fetchViewer('tok'), { id: 1, name: 'me' });
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer tok');
  await AL.gql('query { x }');
  assert.ok(!('Authorization' in calls[1].init.headers));
});

test('retries rate limits, outages and dropped connections', async (t) => {
  const calls = mockFetch(t, [
    { status: 429, headers: { 'retry-after': '1' } },
    { status: 502 },
    { json: { data: { ok: true } } },
  ]);
  assert.deepStrictEqual(await AL.gql('query { ok }'), { ok: true });
  assert.strictEqual(calls.length, 3);

  mockFetch(t, [new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed')]);
  await assert.rejects(AL.gql('query { ok }'), /Could not reach AniList/);
});

test('a hung request times out with a clear message', async (t) => {
  const real = global.fetch;
  global.fetch = (_url, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const old = AL.config.timeoutMs;
  AL.config.timeoutMs = 5;
  t.after(() => {
    global.fetch = real;
    AL.config.timeoutMs = old;
  });
  await assert.rejects(AL.gql('query { ok }'), /took too long/);
});

test('GraphQL errors are not retried and carry their status', async (t) => {
  const calls = mockFetch(t, [{ status: 400, json: { errors: [{ message: 'Invalid token', status: 400 }] } }]);
  await assert.rejects(AL.gql('query { x }', {}, 'bad'), (e) => e.message === 'Invalid token' && e.status === 400);
  assert.strictEqual(calls.length, 1);
});

test('saveEntry only sends the fields it is given', async (t) => {
  const calls = mockFetch(t, [{ json: { data: { SaveMediaListEntry: { id: 9 } } } }, { json: { data: { SaveMediaListEntry: { id: 9 } } } }]);
  await AL.saveEntry('tok', { mediaId: 5, progress: 3 });
  assert.deepStrictEqual(calls[0].body.variables, { mediaId: 5, progress: 3 });
  assert.ok(!/\$status/.test(calls[0].body.query));
  await AL.saveEntry('tok', { mediaId: 5, progress: null, status: 'COMPLETED' });
  assert.deepStrictEqual(calls[1].body.variables, { mediaId: 5, status: 'COMPLETED' });
});

test('fetchUserList drops the repeats custom lists create', async (t) => {
  const e = (id) => ({ status: 'CURRENT', score: 0, progress: 1, media: { id } });
  mockFetch(t, [{ json: { data: { MediaListCollection: { lists: [{ entries: [e(1), e(2)] }, { entries: [e(2), e(3)] }] } } } }]);
  assert.deepStrictEqual((await AL.fetchUserList('me')).map((x) => x.media.id), [1, 2, 3]);
});

test('fetchSeason follows pages and fetchByIds batches by 50', async (t) => {
  const page = (ids, more) => ({ json: { data: { Page: { pageInfo: { hasNextPage: more }, media: ids.map((id) => ({ id })) } } } });
  const calls = mockFetch(t, [page([1, 2], true), page([3], false)]);
  assert.deepStrictEqual((await AL.fetchSeason('FALL', 2026)).map((m) => m.id), [1, 2, 3]);
  assert.deepStrictEqual(calls[1].body.variables, { page: 2, season: 'FALL', year: 2026 });

  const ids = Array.from({ length: 60 }, (_, i) => i + 1);
  const calls2 = mockFetch(t, [page(ids.slice(0, 50)), page(ids.slice(50))]);
  assert.strictEqual((await AL.fetchByIds(ids)).length, 60);
  assert.strictEqual(calls2[0].body.variables.ids.length, 50);
  assert.strictEqual(calls2[1].body.variables.ids.length, 10);
});

test('fetchUserList reads your own list by id with your token', async (t) => {
  const calls = mockFetch(t, [{ json: { data: { MediaListCollection: { lists: [] } } } }]);
  await AL.fetchUserList({ userId: 5 }, 'tok');
  assert.deepStrictEqual(calls[0].body.variables, { id: 5 });
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer tok');
});

test('searchAnime asks for safe-for-work title matches', async (t) => {
  const calls = mockFetch(t, [{ json: { data: { Page: { media: [{ id: 3 }] } } } }]);
  assert.deepStrictEqual(await AL.searchAnime('  frieren '), [{ id: 3 }]);
  assert.deepStrictEqual(calls[0].body.variables, { q: 'frieren' });
  assert.match(calls[0].body.query, /isAdult:false/);
});

test('saveEntry sends a 1-10 score as scoreRaw so any scoring system gets it right', async (t) => {
  const calls = mockFetch(t, [{ json: { data: { SaveMediaListEntry: { id: 1 } } } }]);
  await AL.saveEntry('tok', { mediaId: 5, score: 8 });
  assert.deepStrictEqual(calls[0].body.variables, { mediaId: 5, scoreRaw: 80 });
});

test('deleteEntry removes a list entry by its entry id', async (t) => {
  const calls = mockFetch(t, [{ json: { data: { DeleteMediaListEntry: { deleted: true } } } }]);
  assert.strictEqual(await AL.deleteEntry('tok', 555), true);
  assert.deepStrictEqual(calls[0].body.variables, { id: 555 });
  assert.match(calls[0].body.query, /DeleteMediaListEntry/);
});
