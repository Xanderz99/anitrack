'use strict';
(() => {
const __m = {};
const __f = {
  fs: (module) => { module.exports = { readFileSync() { throw new Error('no fs'); } }; },
  config: (module, exports, require) => {
'use strict';
// App-wide settings shared by the Mac app and the web app.
//
// anilistClientId: the AniList API client everyone logs in through, so nobody has to register their own.
// Create it once at https://anilist.co/settings/developer with the redirect URL set to webUrl below,
// then paste its numeric ID here and rebuild the web app (npm run build:web).
// The Mac app uses the same client: its login window catches the redirect before the page loads.
// Leave it empty and the app asks each person for their own client ID instead (the old behaviour).
module.exports = {
  anilistClientId: '',
  webUrl: 'https://xanderz99.github.io/anitrack/',
};

  },
  anilist: (module, exports, require) => {
'use strict';
// Thin AniList GraphQL client (https://docs.anilist.co). Uses the global fetch in Electron's main process.
const API = 'https://graphql.anilist.co';
// Swappable so tests run without real waiting.
const config = { timeoutMs: 20000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

async function post(body, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs);
  try {
    return await fetch(API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Retries rate limits (429), AniList outages (5xx) and dropped connections. Every query and the one
// mutation here are safe to repeat: SaveMediaListEntry sets values rather than adding to them.
async function gql(query, variables = {}, token) {
  const body = JSON.stringify({ query, variables });
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await post(body, token);
    } catch (e) {
      lastErr = new Error(e.name === 'AbortError' ? 'AniList took too long to answer.' : 'Could not reach AniList. Check your internet connection.');
      await config.sleep(1000 * (attempt + 1));
      continue;
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 10;
      lastErr = new Error('AniList is rate limiting requests. Try again in a minute.');
      await config.sleep(Math.min(wait, 60) * 1000);
      continue;
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON error body */
    }
    if (res.status >= 500 && attempt < 2) {
      lastErr = new Error(`AniList returned HTTP ${res.status}`);
      await config.sleep(2000 * (attempt + 1));
      continue;
    }
    if (!res.ok || !json || json.errors) {
      const err = new Error(json?.errors?.[0]?.message || `AniList returned HTTP ${res.status}`);
      err.status = json?.errors?.[0]?.status || res.status;
      throw err;
    }
    return json.data;
  }
  throw lastErr;
}

const MEDIA_FIELDS = `
      id siteUrl title{ romaji english } format episodes duration genres
      tags{ name rank } averageScore popularity status description(asHtml:false)
      coverImage{ large extraLarge color } bannerImage studios(isMain:true){ nodes{ name } }
      startDate{ year month day } nextAiringEpisode{ episode airingAt }
      externalLinks{ site type url }
      relations{ edges{ relationType node{ id type format title{ romaji english } } } }
      trailer{ id site }
`;

const SEASON_Q = `query($page:Int,$season:MediaSeason,$year:Int){
  Page(page:$page, perPage:50){
    pageInfo{ hasNextPage }
    media(season:$season, seasonYear:$year, type:ANIME, sort:POPULARITY_DESC, format_in:[TV,TV_SHORT,ONA]){
${MEDIA_FIELDS}
    }
  }
}`;

const BY_IDS_Q = `query($ids:[Int]){
  Page(perPage:50){
    media(id_in:$ids, type:ANIME){
${MEDIA_FIELDS}
    }
  }
}`;

const SEARCH_Q = `query($q:String){
  Page(perPage:20){
    media(search:$q, type:ANIME, sort:[SEARCH_MATCH, POPULARITY_DESC], isAdult:false){
${MEDIA_FIELDS}
    }
  }
}`;

// Any anime on AniList by title, best matches first.
async function searchAnime(q) {
  const data = await gql(SEARCH_Q, { q: String(q || '').trim() });
  return data.Page.media;
}

async function fetchSeason(season, year) {
  const all = [];
  for (let page = 1; page <= 8; page++) {
    const data = await gql(SEASON_Q, { page, season, year });
    all.push(...data.Page.media);
    if (!data.Page.pageInfo.hasNextPage) break;
  }
  return all;
}

// Shows from other seasons (for example something you are still watching from last season).
async function fetchByIds(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const data = await gql(BY_IDS_Q, { ids: ids.slice(i, i + 50) });
    out.push(...data.Page.media);
  }
  return out;
}

const USER_Q = `query($u:String,$id:Int){
  MediaListCollection(userName:$u, userId:$id, type:ANIME){
    lists{ entries{ status score(format:POINT_10) progress media{ id genres tags{ name rank } studios(isMain:true){ nodes{ name } } title{ romaji english } coverImage{ medium color } episodes format siteUrl } } }
  }
}`;

// who: { userId } (with that account's token, so private lists work) or { userName } for a public list.
// A plain string is treated as a username.
async function fetchUserList(who, token) {
  const w = typeof who === 'string' ? { userName: who } : who;
  const vars = w.userId ? { id: w.userId } : { u: w.userName };
  const data = await gql(USER_Q, vars, token || undefined);
  const seen = new Set();
  const entries = [];
  for (const list of data.MediaListCollection?.lists || []) {
    for (const e of list.entries) {
      if (seen.has(e.media.id)) continue; // custom lists repeat entries
      seen.add(e.media.id);
      entries.push(e);
    }
  }
  return entries;
}

async function fetchViewer(token) {
  const data = await gql('query { Viewer { id name avatar{ medium } } }', {}, token);
  return data.Viewer;
}

// Only sends the fields it is given, so it never overwrites anything else on the entry.
// score is 1-10; scoreRaw (0-100) is used so it lands right whatever scoring system the account uses.
async function saveEntry(token, { mediaId, progress, status, score }) {
  const vars = { mediaId };
  let defs = '$mediaId:Int';
  let args = 'mediaId:$mediaId';
  if (progress != null) {
    vars.progress = progress;
    defs += ',$progress:Int';
    args += ',progress:$progress';
  }
  if (status) {
    vars.status = status;
    defs += ',$status:MediaListStatus';
    args += ',status:$status';
  }
  if (score != null) {
    vars.scoreRaw = Math.round(score * 10);
    defs += ',$scoreRaw:Int';
    args += ',scoreRaw:$scoreRaw';
  }
  const data = await gql(`mutation(${defs}){ SaveMediaListEntry(${args}){ id status progress } }`, vars, token);
  return data.SaveMediaListEntry;
}

module.exports = { fetchSeason, fetchByIds, searchAnime, fetchUserList, fetchViewer, saveEntry, gql, config };

  },
  taste: (module, exports, require) => {
'use strict';
// Learns genre/tag preferences from a user's AniList list and scores shows against them.

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// How you use the 10-point scale. A generous scorer's 7 is a weak show and a harsh scorer's 7 a good
// one, so scores are read relative to your own average and spread. Short lists use a neutral default.
const DEFAULT_SCALE = { mean: 6.5, spread: 3.5 };
function scoreScale(entries) {
  const s = entries.map((e) => e.score).filter((x) => x > 0);
  if (s.length < 5) return DEFAULT_SCALE;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
  return { mean, spread: Math.max(1.5, sd * 1.5) };
}

// How strongly one list entry says "I like this" (+1) or "I don't" (-1). null = no signal.
function entryValue(e, scale = DEFAULT_SCALE) {
  if (e.score > 0) return clamp((e.score - scale.mean) / scale.spread, -1, 1);
  if (e.status === 'DROPPED') return -0.6;
  if (e.status === 'COMPLETED' || e.status === 'REPEATING') return 0.3;
  if (e.status === 'CURRENT') return 0.4;
  return null; // planning / paused with no score tells us nothing
}

const studiosOf = (media) => (media.studios?.nodes || []).map((n) => n?.name?.trim()).filter(Boolean);

function buildTaste(entries) {
  const g = {};
  const t = {};
  const st = {};
  // weight lets a tag that barely applies (rank 60) count for less than a defining one (rank 100).
  const add = (map, key, v, weight = 1) => {
    const o = map[key] || (map[key] = { sum: 0, w: 0, n: 0 });
    o.sum += v * weight;
    o.w += weight;
    o.n += 1;
  };
  const scale = scoreScale(entries);
  for (const e of entries) {
    const v = entryValue(e, scale);
    if (v === null) continue;
    for (const name of e.media.genres || []) add(g, name, v);
    for (const tag of e.media.tags || []) if (tag.rank >= 60) add(t, tag.name, v, tag.rank / 100);
    for (const name of studiosOf(e.media)) add(st, name, v);
  }
  const fin = (map) => {
    const w = {};
    const n = {};
    for (const [k, o] of Object.entries(map)) {
      w[k] = o.sum / (o.w + 2); // smoothing: a single entry cannot dominate
      n[k] = o.n;
    }
    return { w, n };
  };
  const G = fin(g);
  const T = fin(t);
  const ST = fin(st);
  return { genres: G.w, genreCounts: G.n, tags: T.w, tagCounts: T.n, studios: ST.w, studioCounts: ST.n };
}

function scoreShow(show, taste) {
  if (!taste) return null;
  const gs = (show.genres || []).map((n) => ({ n, w: taste.genres[n] ?? 0 }));
  const ts = (show.tags || [])
    .filter((x) => x.rank >= 60)
    .slice(0, 8)
    .map((x) => ({ n: x.name, w: taste.tags[x.name] ?? 0 }));
  // A studio only counts once you have seen at least two of its shows (tastes caches from before studios were tracked have none).
  const studio = studiosOf(show).find((n) => (taste.studioCounts?.[n] || 0) >= 2);
  const sw = studio ? taste.studios[studio] : 0;
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x.w, 0) / a.length : 0);
  const quality = ((show.averageScore || 65) - 65) / 100 * 0.4;
  const raw = 0.55 * mean(gs) + 0.45 * mean(ts) + 0.2 * sw + quality;
  const pct = clamp(Math.round(50 + raw * 110), 1, 99);
  const all = [...gs, ...ts, ...(studio ? [{ n: studio, w: sw }] : [])];
  const why = all.filter((x) => x.w > 0.15).sort((a, b) => b.w - a.w).slice(0, 3).map((x) => x.n);
  const against = all.filter((x) => x.w < -0.2).sort((a, b) => a.w - b.w).slice(0, 2).map((x) => x.n);
  return { pct, why, against };
}

function summarizeTaste(taste) {
  const rank = (w, n, min) =>
    Object.keys(w)
      .filter((k) => n[k] >= min)
      .sort((a, b) => w[b] - w[a]);
  const gl = rank(taste.genres, taste.genreCounts, 3);
  const tl = rank(taste.tags, taste.tagCounts, 4);
  return {
    likes: gl.filter((k) => taste.genres[k] > 0.1).slice(0, 5),
    skips: gl.filter((k) => taste.genres[k] < -0.1).slice(-3).reverse(),
    tagLikes: tl.filter((k) => taste.tags[k] > 0.1).slice(0, 4),
  };
}

function listMapFrom(entries) {
  const m = {};
  for (const e of entries) m[e.media.id] = { status: e.status, score: e.score, progress: e.progress };
  return m;
}

const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
function seasonFor(date) {
  return { season: SEASONS[Math.floor(date.getMonth() / 3)], year: date.getFullYear() };
}

module.exports = { buildTaste, scoreShow, summarizeTaste, listMapFrom, seasonFor, entryValue, scoreScale };

  },
  dubs: (module, exports, require) => {
'use strict';
// English dub announcements. AniList has no dub data, so this list comes from Crunchyroll's
// Fall 2026 announcements (via Siliconera / Anime News Network coverage) and is matched by title.
// To add or fix entries without touching code, create dubs.json in the app's data folder:
//   { "announced": ["some title"], "tbd": ["another title"] }
const fs = require('fs');

const BUNDLED = {
  announced: [
    'aoashi',
    'apothecary diaries',
    'reincarnated aristocrat',
    'black clover',
    'detective is already dead',
    'firefly wedding',
    'fx fighter',
    'iceblade sorcerer',
    'laid off cheat granting mage',
    'magic knight rayearth',
    'magical explorer',
    'prince of tennis',
    'overgeared',
    'reborn as a space mercenary',
    'returner s magic',
    'sasaki and peeps',
    'world s strongest witch',
  ],
  tbd: ['psyren'],
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function loadExtra(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function makeDubMatcher(extraFile) {
  const extra = extraFile ? loadExtra(extraFile) : null;
  const ann = [...BUNDLED.announced, ...(extra?.announced || [])].map(norm);
  const tbd = [...BUNDLED.tbd, ...(extra?.tbd || [])].map(norm);
  return (show) => {
    // Whole words only, so a short entry cannot match inside an unrelated title.
    const names = [show.title?.english, show.title?.romaji].map(norm).filter(Boolean).map((n) => ` ${n} `);
    const has = (list) => list.some((k) => k && names.some((n) => n.includes(` ${k} `)));
    if (has(ann)) return 'announced';
    if (has(tbd)) return 'tbd';
    return null;
  };
}

module.exports = { makeDubMatcher, norm };

  },
  core: (module, exports, require) => {
'use strict';
// Shared engine for the Mac app (src/main.js) and the iPhone web app (web/core.js): loads and caches
// AniList data, merges it with what you track locally and syncs changes back. The platform supplies
// the stores, the AniList client and the login token; nothing here touches Electron or the DOM.
const { buildTaste, scoreShow, summarizeTaste, listMapFrom, seasonFor } = require('./taste');

// AniList list status -> AniTrack status, and back.
const L2ME = { CURRENT: 'WATCHING', REPEATING: 'WATCHING', PLANNING: 'PLANNING', COMPLETED: 'COMPLETED', PAUSED: 'PAUSED', DROPPED: 'DROPPED' };
const ME2L = { WATCHING: 'CURRENT', PLANNING: 'PLANNING', COMPLETED: 'COMPLETED', PAUSED: 'PAUSED', DROPPED: 'DROPPED' }; // SKIP stays local

const SEASON_TTL = 30 * 60e3;
const EXTRA_TTL = 30 * 60e3;
const USER_TTL = 6 * 3600e3;
const SEASONS_KEPT = 4; // cached seasons; older ones are fetched again if you browse back to them
const FLUSH_MAX = 10; // unsynced changes sent per refresh, to stay well inside AniList's rate limit

const seasonKey = (s) => `${s.season}-${s.year}`;
const titleOf = (r) => r.title?.english || r.title?.romaji || 'Untitled';
const isAuthError = (e) => e?.status === 401 || /invalid token|unauthori[sz]ed/i.test(e?.message || '');
const LOGIN_EXPIRED = 'Your AniList login expired. Log in again in Settings.';

function compactList(entries) {
  return entries.map((e) => ({
    id: e.media.id,
    title: titleOf(e.media),
    romaji: e.media.title?.romaji || '',
    cover: e.media.coverImage?.medium || null,
    color: e.media.coverImage?.color || null,
    format: e.media.format,
    episodes: e.media.episodes,
    siteUrl: e.media.siteUrl,
    score: e.score,
  }));
}

// Local tracking is kept per account, so two people sharing a device (or one person with two AniList
// accounts) never see, or push, each other's changes. Logged out, everything goes to the "guest" space.
// Older installs kept one flat { items, resume }; that moves into the space of whoever is using the app.
function migrateTracking(store, loggedIn) {
  if (!store.get('items') && !store.get('resume')) return;
  const accounts = store.get('accounts') || {};
  const key = loggedIn ? 'legacy' : 'guest';
  if (!accounts[key]) accounts[key] = { items: store.get('items') || {}, resume: store.get('resume') || {} };
  store.patch({ accounts, items: undefined, resume: undefined });
}

function createCore({ AL, settings, tracking: store, cache, dubMatch = () => null, getToken, clearToken, now = Date.now, seasonsKept = SEASONS_KEPT }) {
  // Everything the UI shows is derived from this.
  const S = { raw: [], extra: [], list: [], listMap: {}, taste: null, season: seasonFor(new Date(now())), updatedAt: 0, errors: {} };
  const allRaw = () => [...S.raw, ...S.extra]; // this season plus shows you watch from earlier seasons
  const found = new Map(); // shows seen in search results, so they can be tracked like any other
  const findRaw = (id) => allRaw().find((r) => r.id === id) || found.get(id);
  const userName = () => String(settings.get('userName') || '').trim();
  const loggedIn = () => !!settings.get('token'); // presence only: the Mac keeps it encrypted

  if (!store.get('accounts')) store.set('accounts', {});
  migrateTracking(store, loggedIn());

  /* ---------- whose data this is ---------- */
  function accountKey() {
    if (!loggedIn()) return 'guest';
    const id = settings.get('viewerId');
    return id ? `anilist:${id}` : 'legacy'; // logged in before AniTrack stored account ids
  }
  function space(key = accountKey()) {
    const accounts = store.get('accounts');
    if (!accounts[key]) accounts[key] = { items: {}, resume: {} };
    return accounts[key];
  }
  // Same get/set shape as a store, scoped to the current account. Everything below uses this.
  const tracking = {
    get: (k) => space()[k] || (space()[k] = {}),
    set(k, v) {
      space()[k] = v;
      store.set('accounts', store.get('accounts'));
    },
  };

  // The AniList list this app reads: your own when logged in (private lists work too), otherwise
  // the public list of whatever username you entered.
  function who() {
    const id = settings.get('viewerId');
    if (loggedIn() && id) return { key: `id:${id}`, userId: id, label: settings.get('viewerName') || 'your account' };
    const name = userName();
    return !loggedIn() && name ? { key: `name:${name.toLowerCase()}`, userName: name, label: name } : null;
  }

  // Called after a login. Data from a login made before ids were stored becomes this account's.
  function setViewer(viewer) {
    settings.patch({ viewerId: viewer.id, viewerName: viewer.name, viewerAvatar: viewer.avatar?.medium || '' });
    const accounts = store.get('accounts');
    if (accounts.legacy) {
      const key = `anilist:${viewer.id}`;
      if (!accounts[key]) accounts[key] = accounts.legacy;
      delete accounts.legacy;
      store.set('accounts', accounts);
    }
  }

  async function ensureViewer(errors) {
    const token = getToken();
    if (!token || settings.get('viewerId')) return;
    try {
      setViewer(await AL.fetchViewer(token));
    } catch (e) {
      if (isAuthError(e)) {
        clearToken();
        errors.sync = LOGIN_EXPIRED;
      }
    }
  }

  // Shows you tracked logged out on this device, before logging in.
  const guestCount = () => (loggedIn() ? Object.keys(store.get('accounts').guest?.items || {}).length : 0);
  function adoptGuest() {
    if (!loggedIn()) return 0;
    const accounts = store.get('accounts');
    const guest = accounts.guest?.items || {};
    const mine = space().items;
    let n = 0;
    for (const [id, it] of Object.entries(guest)) {
      if (mine[id]) continue; // what the account already has wins
      mine[id] = { ...it, ...(it.status === 'SKIP' ? {} : { dirty: true }) };
      n += 1;
    }
    delete accounts.guest;
    store.set('accounts', accounts);
    return n;
  }

  function meFor(id) {
    const t = tracking.get('items')[id];
    const l = S.listMap[id];
    return {
      status: t?.status ?? (l ? L2ME[l.status] : null) ?? null,
      progress: t?.progress ?? l?.progress ?? 0,
      inList: !!l,
    };
  }

  function enrich(r) {
    const streaming = (r.externalLinks || []).filter((l) => l.type === 'STREAMING' && /^https:\/\//.test(l.url || ''));
    const cr = streaming.find((l) => /crunchyroll/i.test(l.site));
    // Every legal service AniList lists, Crunchyroll first, one link per service.
    const streams = [];
    for (const l of [...(cr ? [cr] : []), ...streaming]) if (!streams.some((x) => x.site === l.site)) streams.push({ site: l.site, url: l.url });
    const prequels = (r.relations?.edges || []).filter((e) => e.relationType === 'PREQUEL' && e.node.type === 'ANIME').map((e) => e.node.id);
    const seenPrequel = prequels.some((id) => ['COMPLETED', 'REPEATING', 'CURRENT'].includes(S.listMap[id]?.status));
    const match = scoreShow(r, S.taste);
    return {
      id: r.id,
      title: titleOf(r),
      romaji: r.title?.romaji || '',
      format: r.format,
      episodes: r.episodes,
      duration: r.duration,
      genres: r.genres || [],
      tags: (r.tags || []).filter((t) => t.rank >= 60).slice(0, 5).map((t) => t.name),
      score: r.averageScore,
      popularity: r.popularity,
      airStatus: r.status,
      color: r.coverImage?.color || null,
      cover: r.coverImage?.large || null,
      coverXL: r.coverImage?.extraLarge || r.coverImage?.large || null, // sharper art for big heroes
      banner: r.bannerImage || null,
      studio: r.studios?.nodes?.[0]?.name?.trim() || '',
      start: r.startDate,
      next: r.nextAiringEpisode,
      crUrl: cr?.url || null,
      onCR: !!cr,
      streams,
      dub: dubMatch(r),
      isSequel: prequels.length > 0,
      needsPrequel: prequels.length > 0 && !!S.taste && !seenPrequel,
      siteUrl: r.siteUrl,
      description: String(r.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 260),
      match: match ? match.pct : null,
      why: match ? match.why : [],
      against: match ? match.against : [],
    };
  }

  const pendingCount = () => Object.values(tracking.get('items')).filter((it) => it.dirty).length;

  // The part of the UI payload both platforms share; each adds its own settings/auth fields.
  function basePayload({ resumeFor = () => null } = {}) {
    return {
      shows: allRaw().map((r) => ({ ...enrich(r), me: meFor(r.id), resume: resumeFor(r.id), offSeason: !S.raw.includes(r) })),
      list: S.list.map((e) => ({ ...e, me: meFor(e.id) })),
      season: S.season,
      updatedAt: S.updatedAt,
      taste: S.taste ? summarizeTaste(S.taste) : null,
      errors: S.errors,
      pending: pendingCount(),
      guestItems: guestCount(),
      account: who()?.label || null,
    };
  }

  /* ---------- loading ---------- */
  function useUser(u) {
    S.listMap = u?.listMap || {};
    S.list = u?.list || [];
    S.taste = u?.taste || null;
  }

  function loadFromCache() {
    const c = cache.get('seasons')[seasonKey(S.season)];
    if (c) {
      S.raw = c.shows;
      S.updatedAt = c.ts;
    }
    const u = cache.get('user');
    if (u && u.name === who()?.key) useUser(u);
    S.extra = cache.get('extra')?.shows || [];
  }

  async function loadSeason(want, force, errors) {
    const key = seasonKey(want);
    const c = cache.get('seasons')[key];
    if (c && !force && now() - c.ts < SEASON_TTL) return c;
    try {
      const shows = await AL.fetchSeason(want.season, want.year);
      const fresh = { ts: now(), shows };
      // Re-read after the await: another refresh may have cached a different season meanwhile.
      const keep = Object.entries(cache.get('seasons'))
        .filter(([k]) => k !== key)
        .sort((a, b) => b[1].ts - a[1].ts)
        .slice(0, seasonsKept - 1);
      cache.set('seasons', { ...Object.fromEntries(keep), [key]: fresh });
      return fresh;
    } catch (e) {
      errors.season = `Could not load the season from AniList: ${e.message}`;
      return c || { ts: 0, shows: [] };
    }
  }

  async function syncUser(force, errors) {
    const w = who();
    if (!w) return useUser(null);
    const name = w.key; // the cache is keyed by account, so switching accounts never shows the old list
    const u = cache.get('user');
    if (u && u.name === name && !force && now() - u.ts < USER_TTL) return useUser(u);
    try {
      const entries = await AL.fetchUserList(w.userId ? { userId: w.userId } : { userName: w.userName }, w.userId ? getToken() : null);
      const fresh = { name, ts: now(), listMap: listMapFrom(entries), list: compactList(entries), taste: buildTaste(entries) };
      if (who()?.key !== name) return; // you logged in or out while this was loading
      cache.set('user', fresh);
      useUser(fresh);
    } catch (e) {
      if (w.userId && isAuthError(e)) {
        clearToken();
        errors.sync = LOGIN_EXPIRED;
      } else {
        errors.user = w.userId ? `Could not read your AniList list: ${e.message}` : `Could not read the AniList list for "${w.label}": ${e.message}. Check the username, and that the list is public.`;
      }
      useUser(u && u.name === name ? u : null);
    }
  }

  // Anything already synced follows AniList, so changes made on the website, the phone or the Mac agree.
  // Unsynced ("dirty") local changes win, except that a higher episode count on AniList is always taken.
  function syncProgressFromList() {
    const items = tracking.get('items');
    let changed = false;
    for (const [id, it] of Object.entries(items)) {
      const l = S.listMap[id];
      if (!l) continue;
      if (!it.dirty && it.status !== 'SKIP' && L2ME[l.status] && it.status !== L2ME[l.status]) {
        it.status = L2ME[l.status];
        changed = true;
      }
      if (!it.dirty && l.progress != null && it.progress !== l.progress) {
        it.progress = l.progress;
        changed = true;
      } else if (it.progress != null && l.progress != null && l.progress > it.progress) {
        it.progress = l.progress;
        changed = true;
      }
    }
    if (changed) tracking.set('items', items);
  }

  // Sends changes that could not be synced earlier (offline, not logged in yet, AniList hiccup).
  async function flushDirty(errors) {
    const token = getToken();
    if (!token || errors.user) return; // only once we know what AniList currently has
    const items = tracking.get('items');
    const dirty = Object.entries(items).filter(([, it]) => it.dirty);
    if (!dirty.length) return;
    let sent = 0;
    for (const [id, it] of dirty.slice(0, FLUSH_MAX)) {
      const l = S.listMap[id];
      // Only send a status AniList does not already have (keeps REPEATING from turning into CURRENT).
      const status = ME2L[it.status] && L2ME[l?.status] !== it.status ? ME2L[it.status] : null;
      const progress = it.progress != null && it.progress !== l?.progress ? it.progress : null;
      try {
        if (status || progress != null) await AL.saveEntry(token, { mediaId: Number(id), progress, status });
        delete it.dirty;
        S.listMap[id] = { score: 0, ...l, status: status || l?.status || 'CURRENT', progress: progress ?? l?.progress ?? 0 };
        sent += 1;
      } catch (e) {
        if (isAuthError(e)) {
          clearToken();
          errors.sync = LOGIN_EXPIRED;
        } else {
          errors.sync = `Some changes are not on AniList yet and will be retried: ${e.message}`;
        }
        break;
      }
    }
    if (sent) tracking.set('items', items);
  }

  async function loadExtra(force, errors) {
    const inSeason = new Set(S.raw.map((r) => r.id));
    const ids = new Set();
    for (const [id, l] of Object.entries(S.listMap)) if (['CURRENT', 'REPEATING'].includes(l.status)) ids.add(Number(id));
    for (const [id, t] of Object.entries(tracking.get('items'))) if (['WATCHING', 'PLANNING'].includes(t.status)) ids.add(Number(id));
    const want = [...ids].filter((id) => !inSeason.has(id)).sort((a, b) => a - b);
    if (!want.length) {
      S.extra = [];
      return;
    }
    const c = cache.get('extra');
    if (c && c.ids.join(',') === want.join(',') && !force && now() - c.ts < EXTRA_TTL) {
      S.extra = c.shows;
      return;
    }
    try {
      S.extra = await AL.fetchByIds(want);
      cache.set('extra', { ts: now(), ids: want, shows: S.extra });
    } catch (e) {
      errors.extra = `Could not load your other watching shows: ${e.message}`;
      S.extra = c ? c.shows : [];
    }
  }

  async function refresh({ season, year, force, user } = {}) {
    if (season && year) S.season = { season, year };
    const want = { ...S.season };
    const errors = {};
    await ensureViewer(errors);
    const [loaded] = await Promise.all([loadSeason(want, force, errors), syncUser(force && user !== false, errors)]);
    // If you switched season while this one was loading, the newer request owns S.raw and the errors.
    const current = seasonKey(S.season) === seasonKey(want);
    if (current) {
      S.raw = loaded.shows;
      S.updatedAt = loaded.ts;
    }
    syncProgressFromList();
    await flushDirty(errors);
    await loadExtra(force, errors);
    if (current) S.errors = errors;
  }

  /* ---------- tracking + AniList sync ---------- */
  async function pushToAniList(id, patch, next) {
    let status = null;
    if (next.status === 'COMPLETED') status = 'COMPLETED';
    else if ('status' in patch) status = ME2L[next.status] || null;
    else if ('progress' in patch && next.progress > 0) status = S.listMap[id]?.status === 'REPEATING' ? null : 'CURRENT';
    const progress = 'progress' in patch ? next.progress : null;
    if (progress == null && !status) return { pushed: false, reason: 'local-only' };
    const token = getToken();
    if (!token) return { pushed: false, reason: 'not-logged-in' };
    try {
      await AL.saveEntry(token, { mediaId: id, progress, status });
      const old = S.listMap[id] || { score: 0, progress: 0 };
      S.listMap[id] = { ...old, status: status || old.status || 'CURRENT', progress: progress ?? old.progress };
      return { pushed: true };
    } catch (e) {
      if (isAuthError(e)) {
        clearToken();
        return { pushed: false, error: LOGIN_EXPIRED };
      }
      return { pushed: false, error: e.message };
    }
  }

  async function setTrack(id, patch) {
    id = Number(id);
    const items = tracking.get('items');
    const next = { ...(items[id] || {}) };
    if ('status' in patch) {
      if (patch.status) next.status = patch.status;
      else delete next.status;
    }
    if ('progress' in patch) {
      next.progress = Math.max(0, Math.floor(Number(patch.progress) || 0));
      if (next.progress > 0 && (!next.status || ['PLANNING', 'PAUSED'].includes(next.status))) next.status = 'WATCHING';
    }
    const total = findRaw(id)?.episodes || S.list.find((e) => e.id === id)?.episodes || null;
    if (total && next.progress != null) {
      if (next.progress >= total) {
        next.progress = total;
        next.status = 'COMPLETED';
      } else if (next.status === 'COMPLETED') {
        next.status = 'WATCHING';
      }
    }
    if (next.status == null && next.progress == null) delete items[id];
    else items[id] = next;
    tracking.set('items', items);
    const fromSearch = found.get(id);
    if (fromSearch && next.status && !allRaw().some((r) => r.id === id)) S.extra.push(fromSearch);
    const push = await pushToAniList(id, patch, next);
    const item = tracking.get('items')[id];
    if (item) {
      if (push.pushed) delete item.dirty;
      else if (push.reason !== 'local-only' && ('progress' in patch || (patch.status && patch.status !== 'SKIP'))) item.dirty = true;
      tracking.set('items', tracking.get('items'));
    }
    return { me: meFor(id), ...push };
  }

  /* ---------- search all of AniList ---------- */
  const searches = new Map(); // query -> ids, so retyping does not ask AniList again
  async function search(q) {
    const key = String(q || '').trim().toLowerCase();
    if (key.length < 2) return [];
    if (!searches.has(key)) {
      const results = await AL.searchAnime(key);
      for (const r of results) found.set(r.id, r);
      searches.set(key, results.map((r) => r.id));
      if (searches.size > 50) searches.delete(searches.keys().next().value);
    }
    return searches.get(key).map((id) => findRaw(id)).filter(Boolean).map((r) => ({ ...enrich(r), me: meFor(r.id), resume: null, offSeason: !S.raw.includes(r) }));
  }

  /* ---------- details page ---------- */
  const RELATED = { PREQUEL: 'Prequel', SEQUEL: 'Sequel', PARENT: 'Main story', SIDE_STORY: 'Side story', SPIN_OFF: 'Spin-off', ALTERNATIVE: 'Alternative version' };
  const trailerUrl = (t) => (t?.site === 'youtube' && /^[\w-]{6,20}$/.test(t.id) ? `https://www.youtube.com/watch?v=${t.id}` : t?.site === 'dailymotion' && /^\w{4,20}$/.test(t.id) ? `https://www.dailymotion.com/video/${t.id}` : null);
  // Everything about one show. Looks it up on AniList when it is not loaded (an old show on your list).
  async function details(id) {
    id = Number(id);
    let raw = findRaw(id);
    if (!raw) {
      [raw] = await AL.fetchByIds([id]);
      if (!raw) return null;
      found.set(id, raw);
    }
    const order = Object.keys(RELATED);
    const related = (raw.relations?.edges || [])
      .filter((e) => RELATED[e.relationType] && e.node?.type === 'ANIME')
      .sort((a, b) => order.indexOf(a.relationType) - order.indexOf(b.relationType))
      .slice(0, 8)
      .map((e) => ({ id: e.node.id, relation: RELATED[e.relationType], title: titleOf(e.node), format: e.node.format, me: meFor(e.node.id) }));
    return {
      ...enrich(raw),
      me: meFor(id),
      offSeason: !S.raw.includes(raw),
      synopsis: String(raw.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500),
      trailer: trailerUrl(raw.trailer),
      related,
      season: raw.startDate?.year || null,
    };
  }

  /* ---------- rating ---------- */
  // Saves a 1-10 score to AniList. Ratings drive For You, so the next refresh relearns your taste.
  async function rate(id, score) {
    id = Number(id);
    score = Math.round(Number(score));
    if (!(score >= 1 && score <= 10)) return { ok: false, error: 'Pick a score from 1 to 10.' };
    const token = getToken();
    if (!token) return { ok: false, error: 'Log in with AniList to rate shows.' };
    try {
      await AL.saveEntry(token, { mediaId: id, score });
    } catch (e) {
      if (isAuthError(e)) {
        clearToken();
        return { ok: false, error: LOGIN_EXPIRED };
      }
      return { ok: false, error: e.message };
    }
    if (S.listMap[id]) S.listMap[id].score = score;
    const entry = S.list.find((e) => e.id === id);
    if (entry) entry.score = score;
    const u = cache.get('user');
    if (u) cache.set('user', { ...u, ts: 0 }); // stale: relearn taste on the next refresh
    return { ok: true, score };
  }

  /* ---------- upcoming episodes (menu bar, calendar) ---------- */
  function upcoming() {
    const t = now() / 1000;
    return allRaw()
      .filter((r) => r.nextAiringEpisode && ['WATCHING', 'PLANNING'].includes(meFor(r.id).status))
      .map((r) => ({ id: r.id, title: titleOf(r), ep: r.nextAiringEpisode.episode, at: r.nextAiringEpisode.airingAt, mins: r.duration || 24 }))
      .filter((x) => x.at > t - 3600)
      .sort((a, b) => a.at - b.at);
  }

  return { S, tracking, allRaw, findRaw, meFor, enrich, basePayload, pendingCount, loadFromCache, refresh, setTrack, search, rate, details, upcoming, setViewer, adoptGuest, accountKey };
}

/* ---------- calendar (.ics) ---------- */
const icsText = (t) => String(t).replace(/([,;\\])/g, '\\$1').replace(/\r?\n/g, '\\n');
const icsStamp = (sec) => new Date(sec * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const utf8 = new TextEncoder();
// RFC 5545 caps lines at 75 octets; longer ones continue on the next line after a space.
function icsFold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = utf8.encode(ch).length;
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function buildIcs(items, nowMs = Date.now()) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AniTrack//EN', 'CALSCALE:GREGORIAN'];
  for (const x of items) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:anitrack-${x.id}-${x.ep}@anitrack`,
      `DTSTAMP:${icsStamp(nowMs / 1000)}`,
      `DTSTART:${icsStamp(x.at)}`,
      `DTEND:${icsStamp(x.at + x.mins * 60)}`,
      `SUMMARY:${icsText(x.title)} - Episode ${x.ep}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsText(x.title)} episode ${x.ep} is out`,
      'TRIGGER:PT0M',
      'END:VALARM',
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(icsFold).join('\r\n')}\r\n`;
}

module.exports = { createCore, buildIcs, isAuthError, L2ME, ME2L, SEASONS_KEPT };

  },
};
const require = (n) => { n = n.replace(/^\.\//, ''); if (!__m[n]) { const module = { exports: {} }; __m[n] = module; __f[n](module, module.exports, require); } return __m[n].exports; };
window.__require = require;
})();
((require) => {
'use strict';
// Browser version of the Mac app's main process (src/main.js). It runs inside the page and exposes
// the same window.api the Mac renderer uses, so renderer/app.js works unchanged on the iPhone.
(() => {
  const AL = require('./anilist');
  const { createCore, buildIcs } = require('./core');
  const { makeDubMatcher } = require('./dubs');
  const config = require('./config');

  /* ---------- storage (localStorage, one key per store) ---------- */
  const stores = [];
  class Store {
    constructor(name, defaults) {
      this.key = `anitrack:${name}`;
      this.defaults = JSON.stringify(defaults);
      this.load();
      stores.push(this);
    }
    load() {
      this.data = JSON.parse(this.defaults); // deep copy: callers mutate nested objects in place
      try {
        Object.assign(this.data, JSON.parse(localStorage.getItem(this.key) || '{}'));
      } catch {
        /* private mode or corrupt: start fresh */
      }
    }
    get(k) {
      return this.data[k];
    }
    set(k, v) {
      this.data[k] = v;
      this.save();
    }
    patch(o) {
      Object.assign(this.data, o);
      this.save();
    }
    save() {
      const body = JSON.stringify(this.data);
      try {
        localStorage.setItem(this.key, body);
      } catch {
        // Storage full. Cached AniList data can be fetched again, so it goes first; your tracking and
        // login must still save. (Storage that is unavailable altogether just stays in memory.)
        freeCache();
        try {
          localStorage.setItem(this.key, body);
        } catch {
          console.warn('Could not save', this.key);
        }
      }
    }
  }

  const settings = new Store('settings', { userName: '', clientId: '', token: '', viewerId: null, viewerName: '', viewerAvatar: '', welcomed: false });
  const tracking = new Store('tracking', { accounts: {}, notified: {} });
  const cache = new Store('cache', { seasons: {}, user: null, extra: null });
  function freeCache() {
    cache.data = JSON.parse(cache.defaults);
    try {
      localStorage.removeItem(cache.key);
    } catch {
      /* nothing to free */
    }
  }
  const getToken = () => settings.get('token') || null;
  const clearToken = () => settings.patch({ token: '', viewerName: '', viewerId: null, viewerAvatar: '' });
  // Phones give a web app only a few MB, so keep fewer seasons than the Mac does.
  const core = createCore({ AL, settings, tracking, cache, dubMatch: makeDubMatcher(null), getToken, clearToken, seasonsKept: 2 });

  // The app's built-in AniList client only redirects to the official address; copies hosted elsewhere
  // (or opened from a file) need their own client ID.
  const onOfficialSite = () => location.origin + location.pathname === config.webUrl;
  const clientId = () => String(settings.get('clientId') || '').trim() || (onOfficialSite() ? String(config.anilistClientId || '') : '');

  const listeners = { data: [], toast: [], player: [], login: [] };
  const emit = (ch, d) => (listeners[ch] || []).forEach((cb) => cb(d));
  const redirectUrl = () => location.origin + location.pathname;

  function payload() {
    return {
      ...core.basePayload(),
      platform: 'web',
      redirectUrl: redirectUrl(),
      settings: { userName: settings.get('userName'), clientId: settings.get('clientId') },
      auth: { loggedIn: !!getToken(), name: settings.get('viewerName') || '', avatar: settings.get('viewerAvatar') || '', canLogin: /^\d+$/.test(clientId()), builtInClient: !!config.anilistClientId && onOfficialSite() },
      firstRun: !getToken() && !String(settings.get('userName') || '').trim() && !settings.get('welcomed'),
      drm: false,
    };
  }

  async function refresh(opts) {
    await core.refresh(opts || {});
    return payload();
  }

  /* ---------- login: AniList sends us back to this page with #access_token=… ---------- */
  const PENDING_LOGIN = 'anitrack:loginStarted';
  // Home Screen apps on iOS are a sandboxed browser: AniList's pages often load blank inside them and
  // redirects rarely find their way back. There, login happens in a Safari sheet and the code is pasted back.
  const standalone = () => navigator.standalone === true || !!window.matchMedia?.('(display-mode: standalone)').matches;
  // A pasted code may be the bare token, or a whole redirect URL that contains it.
  const tokenFrom = (text) => {
    const t = String(text || '').trim();
    const m = /access_token=([^&\s]+)/.exec(t);
    return m ? decodeURIComponent(m[1]) : t.replace(/\s+/g, '');
  };

  // Returns a message for the UI, or { handoff } when the token arrived without this copy of the app
  // asking for it: either the Safari sheet a Home Screen login opened (the code is then copied back to
  // the app), or a link someone else made (which must never log you in silently).
  async function finishLoginFromHash() {
    const m = /[#&]access_token=([^&]+)/.exec(location.hash);
    if (!m) return null;
    history.replaceState(null, '', location.pathname + location.search); // keep the token out of the address bar
    const token = decodeURIComponent(m[1]);
    let started = 0;
    try {
      started = Number(localStorage.getItem(PENDING_LOGIN)) || 0;
      localStorage.removeItem(PENDING_LOGIN);
    } catch {
      /* storage unavailable */
    }
    if (Date.now() - started < 30 * 60e3) return useToken(token);
    try {
      const viewer = await AL.fetchViewer(token);
      return { handoff: { name: viewer.name, token } };
    } catch (e) {
      return `AniList rejected the login: ${e.message}`;
    }
  }
  async function useToken(token) {
    try {
      const viewer = await AL.fetchViewer(token);
      settings.patch({ token });
      core.setViewer(viewer);
      return `Logged in as ${viewer.name}`;
    } catch (e) {
      return `AniList rejected the login: ${e.message}`;
    }
  }
  // After a login: offer to send what you tracked here while logged out to your AniList.
  function guestOffer() {
    const n = core.basePayload().guestItems;
    if (!n) return;
    emit('toast', {
      msg: `You tracked ${n} show${n > 1 ? 's' : ''} on this device before logging in. Add ${n > 1 ? 'them' : 'it'} to your AniList?`,
      action: { label: 'Add', fn: () => api.adoptGuest().then((r) => emit('data', r.data)) },
    });
  }

  /* ---------- calendar: Safari offers "Add to Calendar" for .ics files ---------- */
  function exportCalendar() {
    const items = core.upcoming();
    if (!items.length) return { ok: false, error: 'Nothing to export yet. Set a show to Watching or Planning first.' };
    const a = document.createElement('a');
    a.href = `data:text/calendar;charset=utf-8,${encodeURIComponent(buildIcs(items))}`;
    a.download = 'anitrack-airing.ics';
    document.body.append(a);
    a.click();
    a.remove();
    return { ok: true, count: items.length };
  }

  /* ---------- the api ---------- */
  let booted = false;
  const api = {
    platform: 'web',
    async init() {
      navigator.storage?.persist?.().catch(() => {}); // asks Safari not to clear this app's data
      let loginMsg = await finishLoginFromHash();
      if (loginMsg && loginMsg.handoff) {
        const { handoff } = loginMsg;
        loginMsg = null;
        setTimeout(() => emit('login', handoff), 300);
      } else if (loginMsg) {
        setTimeout(() => emit('toast', loginMsg), 300);
        setTimeout(guestOffer, 2500);
      }
      core.loadFromCache();
      if (!booted) {
        booted = true;
        setTimeout(() => refresh({ force: !!loginMsg }).then((p) => emit('data', p)).catch(console.error), 30);
        // Coming back to the app after a while: refresh quietly.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && Date.now() - core.S.updatedAt > 15 * 60e3) refresh({}).then((p) => emit('data', p)).catch(() => {});
        });
        // Another tab changed something: pick it up instead of overwriting it on the next save.
        window.addEventListener('storage', (e) => {
          const st = stores.find((x) => x.key === e.key);
          if (!st) return;
          st.load();
          if (st !== cache) refresh({}).then((p) => emit('data', p)).catch(() => {});
        });
      }
      return { ...payload(), loading: core.S.raw.length === 0 };
    },
    refresh,
    setTrack: core.setTrack,
    rate: core.rate,
    async details(id) {
      try {
        const show = await core.details(id);
        return show ? { show, resume: null } : { error: 'Could not find that show on AniList.' };
      } catch (e) {
        return { error: `Could not load the show: ${e.message}` };
      }
    },
    async search(q) {
      try {
        return { shows: await core.search(q) };
      } catch (e) {
        return { shows: [], error: e.message };
      }
    },
    async saveSettings(patch) {
      const before = String(settings.get('userName') || '').trim();
      const allowed = {};
      if (typeof patch.userName === 'string') allowed.userName = patch.userName.trim();
      if (typeof patch.clientId === 'string') allowed.clientId = patch.clientId.trim();
      if (typeof patch.welcomed === 'boolean') allowed.welcomed = patch.welcomed;
      settings.patch(allowed);
      if (allowed.userName !== undefined && allowed.userName !== before) {
        return refresh({ force: true });
      }
      return payload();
    },
    async login() {
      const id = clientId();
      if (!/^\d+$/.test(id)) return { ok: false, error: 'Enter your AniList client ID in Settings first (it is a number).' };
      const url = `https://anilist.co/api/v2/oauth/authorize?client_id=${id}&response_type=token`;
      // window.open runs before any await, so it still counts as the tap that allows a new window.
      if (standalone() && window.open(url, '_blank')) return { ok: false, paste: true };
      try {
        localStorage.setItem(PENDING_LOGIN, String(Date.now()));
      } catch {
        /* the confirm prompt covers this */
      }
      location.href = url;
      return new Promise(() => {}); // the page is leaving
    },
    // Fallback when the redirect lands in Safari instead of the Home Screen app: AniList's "pin" page shows the token to copy.
    async loginWithToken(token) {
      const t = tokenFrom(token);
      if (t.length < 40) return { ok: false, msg: 'That does not look like an AniList code. Copy the whole code and try again.', data: payload() };
      const msg = await useToken(t);
      const ok = !!getToken() && msg.startsWith('Logged');
      return { ok, msg, data: ok ? await refresh({ force: true }) : payload() };
    },
    async logout() {
      clearToken();
      return refresh({});
    },
    async adoptGuest() {
      const count = core.adoptGuest();
      return { count, data: await refresh({ force: true }) };
    },
    // Forgets everything this browser stored for AniTrack (for shared devices).
    async resetDevice() {
      try {
        for (const k of Object.keys(localStorage)) if (k.startsWith('anitrack:')) localStorage.removeItem(k);
      } catch {
        /* nothing stored */
      }
      location.reload();
      return new Promise(() => {});
    },
    async watch(id) {
      id = Number(id);
      const raw = core.findRaw(id);
      const listed = core.S.list.find((e) => e.id === id);
      const show = raw ? core.enrich(raw) : null;
      const title = show ? show.title : listed?.title || '';
      const url = show?.crUrl || show?.streams[0]?.url || `https://www.crunchyroll.com/search?q=${encodeURIComponent(title)}`;
      window.open(url, '_blank', 'noopener');
      return { ok: true, external: true, drm: true };
    },
    async closePlayer() {},
    exportCalendar: async () => exportCalendar(),
    playerExternal() {},
    openExternal(url) {
      if (/^https:\/\//.test(String(url))) window.open(url, '_blank', 'noopener');
    },
    on(ch, cb) {
      if (!listeners[ch]) return () => {};
      listeners[ch].push(cb);
      return () => (listeners[ch] = listeners[ch].filter((x) => x !== cb));
    },
  };

  window.api = api;

  // No pinch zoom: it behaves like a native app. Safari ignores user-scalable=no, so the gesture
  // itself is cancelled (gesture* events are Safari's pinch; two-finger touchmove covers the rest).
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });

  // Hourly refresh while the app stays open.
  setInterval(() => refresh({}).then((p) => emit('data', p)).catch(() => {}), 3600e3);
})();

})(window.__require);
'use strict';
(() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // UI preferences. Keys share the anitrack: prefix so "Remove all AniTrack data" clears them too;
  // values saved before the prefix existed are read once and moved.
  const store = {
    get(k, d) {
      try {
        let v = localStorage.getItem(`anitrack:ui:${k}`);
        if (v == null && localStorage.getItem(k) != null) {
          v = localStorage.getItem(k);
          localStorage.setItem(`anitrack:ui:${k}`, v);
          localStorage.removeItem(k);
        }
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(`anitrack:ui:${k}`, JSON.stringify(v));
      } catch {
        /* storage unavailable */
      }
    },
  };

  const svg = (d) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const VIEWS = [
    { id: 'home', label: 'Home', group: 'Watch', ico: svg('<path d="M3 11 12 3l9 8M5 10v10h5v-6h4v6h5V10"/>') },
    { id: 'tonight', label: 'Tonight', group: 'Watch', ico: svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>') },
    { id: 'mine', label: 'My Shows', group: 'Watch', ico: svg('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>') },
    { id: 'airing', label: 'Airing Soon', group: 'Watch', ico: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>') },
    { id: 'foryou', label: 'For You', group: 'Discover', ico: svg('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>') },
    { id: 'season', label: 'This Season', group: 'Discover', ico: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>') },
    { id: 'list', label: 'My List', group: 'Library', ico: svg('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>') },
    { id: 'settings', label: 'Settings', group: 'Library', ico: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>') },
  ];
  const ICON = {
    check: svg('<path d="M5 12.5 10 17l9-10"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>'),
  };
  const SORTS = { popular: 'Popular', match: 'Best match', score: 'Rating', airing: 'Airing soon', az: 'A–Z' };
  const TIMES = [
    { id: 30, label: 'Quick', sub: '1 episode' },
    { id: 60, label: 'An hour', sub: '2 episodes' },
    { id: 180, label: 'An evening', sub: 'up to 4' },
  ];
  const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
  const STATUS_LABEL = { WATCHING: 'Watching', PLANNING: 'Planning', DROPPED: 'Dropped', SKIP: 'Not interested', COMPLETED: 'Completed', PAUSED: 'Paused' };

  const WEB = window.api.platform === 'web';
  const TABS = ['home', 'tonight', 'mine', 'airing', 'foryou', 'list'];
  const S = {
    view: store.get('view', 'home'),
    sort: store.get('sort', 'popular'),
    tmins: store.get('tmins', 60),
    seed: Math.floor(Math.random() * 1e6),
    undo: null,
    data: null,
    filters: Object.assign({ cr: true, dub: false, hideSeq: true }, store.get('filters', {}), { genre: '', q: '' }), // genre and search reset each launch
    shownSyncHint: false,
    player: null,
    listTab: store.get('listTab', 'WATCHING'),
  };
  if (!VIEWS.some((v) => v.id === S.view)) S.view = 'home';

  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
  const saveFilters = () => store.set('filters', { cr: S.filters.cr, dub: S.filters.dub, hideSeq: S.filters.hideSeq });
  // For url('…') inside a style attribute: percent-encode anything that could end the value early.
  const cssUrl = (u) => esc(String(u || '').replace(/["'()\\\s]/g, encodeURIComponent));

  // A countdown that ticks by itself (see the minute timer), so the page needs no full redraw for it.
  const relSpan = (ts) => `<span class="rel" data-at="${ts}">${rel(ts)}</span>`;
  function rel(ts) {
    let s = Math.round(ts - Date.now() / 1000);
    const past = s < 0;
    s = Math.abs(s);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const t = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
    return past ? `${t} ago` : `in ${t}`;
  }

  const byId = (id) => S.data && S.data.shows.find((s) => s.id === id);
  const listById = (id) => S.data && S.data.list.find((e) => e.id === id);
  const LIST_TABS = ['WATCHING', 'PLANNING', 'PAUSED', 'DROPPED', 'COMPLETED'];
  const listStatus = (e) => (LIST_TABS.includes(e.me.status) ? e.me.status : 'PLANNING');
  const aired = (s) => (s.next ? s.next.episode - 1 : s.airStatus === 'FINISHED' ? s.episodes : null);

  /* ---------- filtering ---------- */
  function passes(s, opts = {}) {
    const f = S.filters;
    if (f.q && !`${s.title} ${s.romaji}`.toLowerCase().includes(f.q.toLowerCase())) return false;
    if (opts.skipToggles) return true;
    if (f.cr && !s.onCR) return false;
    if (f.dub && s.dub !== 'announced') return false;
    if (f.genre && !s.genres.includes(f.genre)) return false;
    if (opts.forYou && f.hideSeq && s.needsPrequel) return false;
    return true;
  }

  function applySort(arr) {
    const k = S.sort;
    if (k === 'popular') return arr.sort((a, b) => b.popularity - a.popularity);
    if (k === 'match') return arr.sort((a, b) => (b.match ?? -1) - (a.match ?? -1));
    if (k === 'score') return arr.sort((a, b) => (b.score || 0) - (a.score || 0));
    if (k === 'airing') return arr.sort((a, b) => (a.next ? a.next.airingAt : Infinity) - (b.next ? b.next.airingAt : Infinity));
    return arr.sort((a, b) => a.title.localeCompare(b.title));
  }
  const isNew = (s) => {
    const now = Date.now() / 1000;
    if (s.next && s.next.episode === 1 && s.next.airingAt - now < 7 * 86400) return 'Premieres soon';
    if (s.next && s.next.episode === 2 && s.next.airingAt - now > 0) return 'New this week';
    return '';
  };
  function rng(seed) {
    let t = seed + 0x6d2b79f5;
    return () => {
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Posters: the show's own colour fills the frame while the image loads; the first few in a row
  // load straight away, the rest as they scroll into view.
  const img = (src, eager) => `<img src="${esc(src)}" alt="" ${eager ? 'loading="eager"' : 'loading="lazy"'} decoding="async">`;
  function tile(s, sub, badge, i = 99) {
    const me = s.me;
    const pct = me.status && s.episodes ? Math.min(100, Math.round((me.progress / s.episodes) * 100)) : 0;
    return `<article class="tile" data-id="${s.id}" style="${s.color ? `--tint:${esc(s.color)}` : ''}">
      <button class="poster" data-act="details" aria-label="${esc(s.title)}: details" style="${s.color ? `background:${esc(s.color)}` : ''}">${s.cover ? img(s.cover, i < 4) : ''}
        ${s.dub === 'announced' ? '<span class="badge">DUB</span>' : ''}${s.match != null && !me.status ? `<span class="badge m">${s.match}%</span>` : ''}${badge ? `<span class="badge new">${esc(badge)}</span>` : ''}
        ${pct ? `<span class="track"><i style="width:${pct}%"></i></span>` : ''}</button>
      <div class="tt" title="${esc(s.title)}">${esc(s.title)}</div><div class="ts">${sub}</div></article>`;
  }
  function shelf(title, items, subFn, badgeFn = () => '') {
    if (!items.length) return '';
    return `<section class="shelf"><h2 class="shelf-t">${title}</h2><div class="shelf-row">${items.map((s, i) => tile(s, subFn(s), badgeFn(s), i)).join('')}</div></section>`;
  }
  function homeHtml() {
    const shows = S.data.shows;
    const upNext = shows
      .filter((s) => s.me.status === 'WATCHING' && aired(s) != null && aired(s) > s.me.progress)
      .sort((a, b) => (b.resume && !b.resume.done ? 1 : 0) - (a.resume && !a.resume.done ? 1 : 0));
    const foryou = listFor('foryou');
    const hero = upNext[0] || foryou[0] || shows.find((s) => s.onCR);
    let html = '';
    if (hero) {
      const up = hero === upNext[0];
      const resuming = hero.resume && !hero.resume.done && hero.resume.time > 30;
      const waiting = up ? aired(hero) - hero.me.progress : 0;
      const kind = up ? (resuming ? 'Continue Watching' : 'Up Next') : 'Featured for you';
      const bits = [hero.genres.slice(0, 3).join(' · '), hero.episodes ? `${hero.episodes} episodes` : '', hero.dub === 'announced' ? 'English dub' : ''].filter(Boolean);
      const blurb = up ? (waiting > 1 ? `${waiting} episodes ready to watch.` : 'The next episode is ready.') : hero.why && hero.why.length ? `Because you like ${hero.why.join(', ')}.` : '';
      const play = up && !resuming ? `Episode ${hero.me.progress + 1}` : watchLabel(hero);
      const pct = up && hero.episodes ? Math.min(100, Math.round((hero.me.progress / hero.episodes) * 100)) : 0;
      const prog = up ? `<div class="hero-prog"><span class="track"><i style="width:${pct}%"></i></span><span>${hero.me.progress}${hero.episodes ? ` of ${hero.episodes}` : ''} watched</span></div>` : '';
      const second = up
        ? `<button class="btn big icon" data-act="inc" aria-label="Mark episode ${hero.me.progress + 1} watched" title="Mark episode ${hero.me.progress + 1} watched">${ICON.check}</button>`
        : hero.me.status
          ? ''
          : `<button class="btn big icon" data-act="plan" aria-label="Plan to watch" title="Plan to watch">${ICON.plus}</button>`;
      const info = `<button class="btn big icon" data-act="details" aria-label="Details" title="Details">${ICON.info}</button>`;
      const art = hero.coverXL || hero.cover;
      html += `<section class="hero ${hero.banner ? 'has-banner' : ''}" data-id="${hero.id}" style="${hero.color ? `--tint:${esc(hero.color)}` : ''}">
        <div class="hero-bg" style="background-image:url('${cssUrl(hero.banner || art)}')"></div>
        ${art ? `<img class="hero-art" src="${esc(art)}" alt="" fetchpriority="high" decoding="async">` : ''}
        <div class="hero-in"><div class="eyebrow">${kind}${hero.match != null && !up ? ` · ${hero.match}% match` : ''}</div>
          <h1 class="hero-t">${esc(hero.title)}</h1><div class="hero-m">${esc(bits.join('  ·  '))}</div>${prog}<div class="hero-d">${esc(blurb)}</div>
          <div class="hero-a"><button class="btn primary big" data-act="watch">▶ ${esc(play)}</button>${second}${info}</div></div></section>`;
    }
    const wk = Date.now() / 1000 + 7 * 86400;
    const airing = shows.filter((s) => s.next && s.next.airingAt < wk && ['WATCHING', 'PLANNING'].includes(s.me.status)).sort((a, b) => a.next.airingAt - b.next.airingAt);
    const fresh = shows.filter((s) => isNew(s) && s.onCR && !s.me.status);
    const planning = shows.filter((s) => s.me.status === 'PLANNING');
    const epSub = (s) => (s.resume && !s.resume.done && s.resume.time > 30 ? `Ep ${s.resume.ep || s.me.progress + 1} · ${clock(s.resume.time)} in` : `Episode ${s.me.progress + 1}`);
    html += shelf('Up Next', upNext, epSub, (s) => (aired(s) - s.me.progress > 1 ? `${aired(s) - s.me.progress} new` : ''));
    html += shelf('Airing This Week', airing, (s) => `Ep ${s.next.episode} · ${relSpan(s.next.airingAt)}`);
    html += shelf('Top Picks for You', foryou.slice(0, 16), (s) => esc(s.why && s.why.length ? s.why.slice(0, 2).join(', ') : s.genres.slice(0, 2).join(', ')));
    html += shelf('New This Week', fresh, (s) => esc(isNew(s)));
    html += shelf('Plan to Watch', planning, (s) => (s.next ? `Ep ${s.next.episode} · ${relSpan(s.next.airingAt)}` : esc(s.genres.slice(0, 2).join(', '))));
    return html || '<div class="empty">Nothing to show yet. Log in with AniList in Settings, or pick shows to track from This Season.</div>';
  }
  function tonightPicks() {
    const shows = S.data.shows;
    const budget = S.tmins <= 30 ? 1 : S.tmins <= 60 ? 2 : 4;
    const ready = shows
      .filter((s) => s.me.status === 'WATCHING' && aired(s) != null && aired(s) > s.me.progress)
      .map((s) => ({ s, eps: Math.min(budget, aired(s) - s.me.progress), kind: s.resume && !s.resume.done && s.resume.time > 30 ? 'resume' : 'next' }));
    const planned = shows.filter((s) => s.me.status === 'PLANNING' && aired(s) >= 1).map((s) => ({ s, eps: Math.min(budget, aired(s)), kind: 'start' }));
    const fresh = listFor('foryou').slice(0, 8).filter((s) => aired(s) >= 1).map((s) => ({ s, eps: Math.min(budget, aired(s)), kind: 'try' }));
    const r = rng(S.seed);
    const shuf = (a) => a.map((x) => [r(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const resumes = ready.filter((x) => x.kind === 'resume');
    const rest = shuf(ready.filter((x) => x.kind !== 'resume'));
    return [...resumes, ...rest, ...shuf(planned), ...shuf(fresh)].slice(0, 3);
  }
  function tonightHtml() {
    const picks = tonightPicks();
    const pills = TIMES.map((t) => `<button class="pill ${S.tmins === t.id ? 'on' : ''}" data-tmins="${t.id}">${t.label} <span class="sub">${t.sub}</span></button>`).join('');
    const KIND = { resume: 'Pick up where you left off', next: 'Next up', start: 'From your plan-to-watch', try: 'Something new for you' };
    const body = picks.length
      ? picks
          .map(
            (p, i) => `<div class="pick"><div class="pick-k">${i === 0 ? 'Top pick · ' : ''}${KIND[p.kind]} · ${p.eps} ep${p.eps > 1 ? 's' : ''}</div>${card(p.s)}</div>`
          )
          .join('')
      : '<div class="empty">Nothing aired and waiting. You are all caught up. Try Discover for something new.</div>';
    return `<div class="tonight-top"><div><h2 class="sec">What are you in the mood for?</h2><div class="sub">How long have you got tonight?</div></div><div class="tpills">${pills}<button class="btn small" data-act="shuffle">Shuffle</button></div></div><div class="picks">${body}</div>`;
  }

  function listFor(view) {
    if (!S.data) return [];
    const shows = S.data.shows;
    if (view === 'foryou') {
      const hasTaste = !!S.data.taste || shows.some((s) => s.match != null);
      return shows
        .filter((s) => !s.me.status && passes(s, { forYou: true }))
        .sort((a, b) => (hasTaste ? (b.match ?? 0) - (a.match ?? 0) : b.popularity - a.popularity));
    }
    if (view === 'season') return applySort(shows.filter((s) => !s.offSeason && passes(s)));
    if (view === 'mine') {
      return shows
        .filter((s) => ['WATCHING', 'PLANNING'].includes(s.me.status) && passes(s, { skipToggles: true }))
        .sort((a, b) => {
          if (a.me.status !== b.me.status) return a.me.status === 'WATCHING' ? -1 : 1;
          return (a.next ? a.next.airingAt : Infinity) - (b.next ? b.next.airingAt : Infinity);
        });
    }
    if (view === 'airing') return shows.filter((s) => s.next && passes(s)).sort((a, b) => a.next.airingAt - b.next.airingAt);
    return [];
  }

  /* ---------- rendering ---------- */
  function renderNav() {
    const counts = S.data
      ? {
          foryou: listFor('foryou').length,
          season: listFor('season').length,
          mine: listFor('mine').length,
          list: S.data.list.length,
          airing: listFor('airing').length,
        }
      : {};
    let grp = '';
    $('#nav').innerHTML = VIEWS.map((v) => {
      const head = v.group !== grp ? `<div class="nav-label">${v.group}</div>` : '';
      grp = v.group;
      return `${head}<button class="nav-btn ${S.view === v.id ? 'on' : ''}" data-nav="${v.id}">${v.ico}<span class="nl">${v.label}</span>${
        counts[v.id] != null ? `<span class="n">${counts[v.id]}</span>` : ''
      }</button>`;
    }).join('');
    const tb = $('#tabbar');
    if (tb) {
      tb.innerHTML = VIEWS.filter((v) => TABS.includes(v.id))
        .map((v) => `<button class="tab ${S.view === v.id ? 'on' : ''}" data-nav="${v.id}" aria-label="${v.label}">${v.ico}<span>${v.id === 'foryou' ? 'Discover' : v.label.replace('Airing Soon', 'Airing')}</span></button>`)
        .join('');
    }
    const d = S.data;
    const seasonName = d ? `${d.season.season[0]}${d.season.season.slice(1).toLowerCase()} ${d.season.year}` : '';
    const updated = d && d.updatedAt ? `Updated ${timeFmt.format(new Date(d.updatedAt))}` : 'Loading…';
    $('#sidefoot').innerHTML = d
      ? `<div class="season"><button class="btn small" data-season="-1" aria-label="Previous season">‹</button><b>${esc(seasonName)}</b><button class="btn small" data-season="1" aria-label="Next season">›</button></div>
         <div class="updated">${esc(updated)}</div><button class="btn small" data-refresh>Refresh now</button>`
      : '<div>Loading…</div>';
  }

  function renderBar() {
    if (S.player) {
      $('#bar').innerHTML = `<button class="btn" data-act="closePlayer">← Library</button><h1>${esc(S.player.title)}</h1><span class="spacer"></span><button class="btn small" data-act="playerExt">Open in browser</button>`;
      return;
    }
    const v = VIEWS.find((x) => x.id === S.view);
    const f = S.filters;
    const pill = (key, label) => `<button class="pill ${f[key] ? 'on' : ''}" data-filter="${key}" aria-pressed="${!!f[key]}">${label}</button>`;
    let html = `<h1>${v.label}</h1>`;
    let ctl = ''; // filters, sorting and tabs: one row that swipes sideways on a phone
    if (['foryou', 'season', 'airing'].includes(S.view)) ctl += pill('cr', 'Crunchyroll') + pill('dub', 'English dub');
    if (S.view === 'foryou') ctl += pill('hideSeq', 'Hide unseen sequels');
    if (['foryou', 'season', 'airing'].includes(S.view) && S.data) ctl += genreSelect();
    if (S.view === 'season') ctl += `<select id="sort" aria-label="Sort by">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${S.sort === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
    if (S.view === 'airing' || S.view === 'mine') ctl += '<button class="btn small" data-act="exportCal" title="Save upcoming episodes as a calendar file">Export calendar</button>';
    if (S.view === 'list' && S.data) {
      const counts = {};
      for (const e of S.data.list) counts[listStatus(e)] = (counts[listStatus(e)] || 0) + 1;
      ctl += LIST_TABS.map(
        (t) => `<button class="pill ${S.listTab === t ? 'on' : ''}" data-listtab="${t}" aria-pressed="${S.listTab === t}">${STATUS_LABEL[t]} ${counts[t] || 0}</button>`
      ).join('');
    }
    if (WEB && S.view === 'foryou') ctl += '<button class="pill narrow-only" data-nav="season">Whole season</button>';
    if (WEB && S.view === 'season' && S.data) {
      const d = S.data.season;
      ctl += `<span class="narrow-only pager"><button class="btn small" data-season="-1" aria-label="Previous season">‹</button>${d.season[0]}${d.season.slice(1).toLowerCase()} ${d.year}<button class="btn small" data-season="1" aria-label="Next season">›</button></span>`;
    }
    if (ctl) html += `<div class="filters">${ctl}</div>`;
    html += '<span class="spacer"></span>';
    if (WEB && S.view !== 'settings') html += `<button class="btn small narrow-only gear" data-nav="settings" aria-label="Settings">${VIEWS.find((v) => v.id === 'settings').ico}</button>`;
    if (!['settings', 'tonight', 'home'].includes(S.view)) html += `<input type="search" id="q" placeholder="Search" value="${esc(f.q)}" aria-label="Search shows">`;
    $('#bar').innerHTML = html;
  }

  function genreSelect() {
    const all = [...new Set(S.data.shows.flatMap((s) => s.genres))].sort();
    if (S.filters.genre && !all.includes(S.filters.genre)) all.unshift(S.filters.genre);
    const opt = (v, label) => `<option value="${esc(v)}" ${S.filters.genre === v ? 'selected' : ''}>${esc(label)}</option>`;
    return `<select id="genre" aria-label="Genre">${opt('', 'All genres')}${all.map((g) => opt(g, g)).join('')}</select>`;
  }

  function badges(s) {
    const b = [];
    if (s.onCR) b.push('<span class="chip cr">Crunchyroll</span>');
    for (const x of (s.streams || []).filter((x) => !/crunchyroll/i.test(x.site)).slice(0, 2)) b.push(`<span class="chip">${esc(x.site)}</span>`);
    if (s.dub === 'announced') b.push('<span class="chip dub">English dub</span>');
    else if (s.dub === 'tbd') b.push('<span class="chip">Dub TBD</span>');
    if (s.offSeason) b.push('<span class="chip">Earlier season</span>');
    if (s.isSequel) b.push(`<span class="chip">${s.needsPrequel ? 'Sequel · earlier season not on your list' : 'Sequel'}</span>`);
    return b.join('');
  }

  function nextLine(s) {
    if (s.next) {
      const d = new Date(s.next.airingAt * 1000);
      const live = s.next.airingAt * 1000 <= Date.now();
      return `<div class="next ${live ? 'live' : ''}">Ep ${s.next.episode} · ${dayFmt.format(d)}, ${timeFmt.format(d)} · ${relSpan(s.next.airingAt)}</div>`;
    }
    if (s.start && s.start.year && s.airStatus === 'NOT_YET_RELEASED') {
      const { year, month, day } = s.start;
      const when = month && day ? dateFmt.format(new Date(year, month - 1, day)) : month ? monthFmt.format(new Date(year, month - 1, 1)) : String(year);
      return `<div class="next">Starts ${esc(when)}</div>`;
    }
    return '';
  }

  function clock(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function watchLabel(s) {
    const r = s.resume;
    if (r && !r.done && r.time > 30) return `Resume${r.ep ? ` ep ${r.ep}` : ''} · ${clock(r.time)}`;
    if (s.onCR) return 'Watch';
    return s.streams?.length ? `Watch on ${s.streams[0].site}` : 'Find on Crunchyroll';
  }

  function card(s) {
    const me = s.me;
    const behind = me.status === 'WATCHING' && aired(s) != null && aired(s) > me.progress ? aired(s) - me.progress : 0;
    const matchLine =
      s.match != null
        ? `<div class="why">${s.why.length ? `Because you like ${esc(s.why.join(', '))}` : ''}${
            s.against.length ? `${s.why.length ? ' · ' : ''}Not your usual: ${esc(s.against.join(', '))}` : ''
          }</div>`
        : '';
    const pct = me.status && s.episodes ? Math.min(100, Math.round((me.progress / s.episodes) * 100)) : 0;
    return `<article class="card" data-id="${s.id}" style="${s.color ? `--tint:${esc(s.color)}` : ''}">
      <div class="cover" data-act="details" role="button" tabindex="-1" aria-hidden="true" style="${s.color ? `background:${esc(s.color)}` : ''}">${s.cover ? img(s.cover) : ''}</div>
      <div class="info">
        <div class="head">
          <button class="title tlink" data-act="details">${esc(s.title)}</button>
          ${s.match != null ? `<span class="score ${s.match < 45 ? 'low' : ''}" title="How well this fits your AniList ratings">${s.match}%</span>` : ''}
          <button class="link ext" data-act="details" aria-label="${esc(s.title)}: details" title="Details">${ICON.info}</button>
        </div>
        <div class="meta">${esc([s.genres.slice(0, 3).join(', '), s.episodes ? `${s.episodes} eps` : 'ongoing', s.studio].filter(Boolean).join(' · '))}</div>
        ${matchLine}
        <div class="chips">${behind ? `<span class="chip hot">${behind} behind</span>` : ''}${isNew(s) ? `<span class="chip hot">${isNew(s)}</span>` : ''}${badges(s)}</div>
        ${nextLine(s)}
        ${pct ? `<div class="track" title="${me.progress} of ${s.episodes} watched"><i style="width:${pct}%"></i></div>` : ''}
      </div>
        ${actsHtml(s)}
    </article>`;
  }

  // Watch, status and the episode stepper: shared by cards and the details page.
  function actsHtml(s) {
    const me = s.me;
    const total = s.episodes ? ` / ${s.episodes}` : '';
    const opts = ['', 'PLANNING', 'WATCHING', 'DROPPED', 'SKIP']
      .map((v) => `<option value="${v}" ${me.status === v || (!me.status && v === '') ? 'selected' : ''}>${v ? STATUS_LABEL[v] : 'Not tracking'}</option>`)
      .join('');
    const status = ['COMPLETED', 'PAUSED'].includes(me.status) ? `<option value="${me.status}" selected>${STATUS_LABEL[me.status]}</option>` : '';
    return `<div class="acts">
          <button class="btn primary small" data-act="watch">${esc(watchLabel(s))}</button>
          <select data-act="status" aria-label="Status for ${esc(s.title)}">${opts}${status}</select>
          ${
            me.status === 'WATCHING'
              ? `<span class="prog"><button class="btn small" data-act="dec" aria-label="One episode back">−</button>Ep ${me.progress}${total}<button class="btn small" data-act="inc">+1</button></span>`
              : ''
          }
        </div>`;
  }

  function tastePanel() {
    const t = S.data.taste;
    if (!t) {
      return `<p class="note">Ranking is by popularity for now. Log in with AniList in <b>Settings</b> (or enter a public username) and shows will be ranked by how well they match what you rate highly.</p>`;
    }
    if (!t.likes.length) return '<p class="note">Ranked against your AniList ratings. Rate a few more shows on AniList and the picks get sharper. Shows already on your list live under My Shows.</p>';
    return `<p class="note">Ranked against your AniList ratings. You tend to like <b>${esc(t.likes.join(', '))}</b>${
      t.tagLikes.length ? ` (especially ${esc(t.tagLikes.join(', '))})` : ''
    }${t.skips.length ? `, and tend to skip <b>${esc(t.skips.join(', '))}</b>` : ''}. Shows already on your list live under My Shows.</p>`;
  }

  function errors() {
    const e = S.data.errors || {};
    return Object.values(e)
      .map((m) => `<p class="err">${esc(m)}</p>`)
      .join('');
  }

  function listRow(e) {
    const me = e.me;
    const total = e.episodes ? ` / ${e.episodes}` : '';
    const sel = LIST_TABS.map((v) => `<option value="${v}" ${listStatus(e) === v ? 'selected' : ''}>${STATUS_LABEL[v]}</option>`).join('');
    return `<div class="row" data-id="${e.id}">
      <div class="rcover" style="${e.color ? `background:${esc(e.color)}` : ''}">${e.cover ? img(e.cover) : ''}</div>
      <div class="rmain"><button class="title tlink" data-act="details">${esc(e.title)}</button><div class="meta">${esc([e.format, `${me.progress}${total} eps`].filter(Boolean).join(' · '))}</div></div>
      <div class="rscore" title="Your score">${e.score ? e.score : '–'}</div>
      <div class="racts">
        <button class="btn small" data-act="watch">Watch</button>
        ${['WATCHING', 'PAUSED'].includes(me.status) ? '<button class="btn small" data-act="inc" aria-label="Add one episode">+1</button>' : ''}
        <select data-act="status" aria-label="Status for ${esc(e.title)}">${sel}</select>
      </div>
    </div>`;
  }

  function listHtml() {
    const d = S.data;
    if (!d.account) return '<div class="empty">Log in with AniList in Settings (or enter a public username) to see your list here.</div>';
    if (!d.list.length) return `<div class="empty">No anime on ${d.auth.loggedIn ? 'your AniList list yet' : `the list for "${esc(d.account)}". Check the username in Settings and that the list is public`}.</div>`;
    const q = S.filters.q.toLowerCase();
    const items = d.list
      .filter((e) => listStatus(e) === S.listTab && (!q || `${e.title} ${e.romaji}`.toLowerCase().includes(q)))
      .sort((a, b) => (S.listTab === 'COMPLETED' ? (b.score || 0) - (a.score || 0) : 0) || a.title.localeCompare(b.title));
    const done = d.list.filter((e) => listStatus(e) === 'COMPLETED').length;
    const head = `<p class="note"><b>${esc(d.account)}</b> on AniList · ${d.list.length} anime, ${done} completed. ${d.auth.loggedIn ? 'Changes here are saved to your AniList.' : 'Log in to save changes to AniList.'}</p>`;
    return head + (items.length ? `<div class="rows">${items.map(listRow).join('')}</div>` : '<div class="empty">Nothing here.</div>');
  }

  function renderContent() {
    const el = $('#content');
    const top = el.scrollTop;
    if (S.player) {
      el.innerHTML = '';
      return;
    }
    if (!S.data || (S.data.loading && S.view !== 'settings')) {
      // Placeholder shapes while the first load runs, so the layout does not jump when data arrives.
      el.innerHTML = `<div class="skel" aria-label="Loading" role="status">${
        S.view === 'home'
          ? `<div class="sk sk-hero"></div><div class="sk sk-t"></div><div class="sk-row">${'<div class="sk sk-tile"></div>'.repeat(5)}</div>`
          : '<div class="sk sk-card"></div>'.repeat(4)
      }</div>`;
      return;
    }
    if (S.data.firstRun && S.view !== 'settings') {
      el.innerHTML = welcomeHtml();
      return;
    }
    if (S.view === 'settings') {
      el.innerHTML = settingsHtml();
      return;
    }
    if (S.view === 'list') {
      el.innerHTML = errors() + listHtml() + searchMore(new Set(S.data.list.filter((e) => listStatus(e) === S.listTab).map((e) => e.id)));
      el.scrollTop = top;
      return;
    }
    if (S.view === 'home') {
      const sl = [...el.querySelectorAll('.shelf-row')].map((r) => r.scrollLeft);
      el.innerHTML = errors() + homeHtml();
      el.querySelectorAll('.shelf-row').forEach((r, i) => (r.scrollLeft = sl[i] || 0));
      el.scrollTop = top;
      return;
    }
    if (S.view === 'tonight') {
      el.innerHTML = errors() + tonightHtml();
      el.scrollTop = top;
      return;
    }
    const list = listFor(S.view);
    let html = errors();
    if (S.view === 'foryou') html += tastePanel();
    if (S.view === 'season' || S.view === 'airing') {
      if (S.filters.dub) html += `<p class="note">English dub status comes from Crunchyroll's announcements. A dub often starts days or weeks after the subtitled episode.</p>`;
    }
    if (!list.length && S.filters.q.trim().length >= 2) {
      html += `<p class="note">Nothing in this view matches "${esc(S.filters.q.trim())}".</p>`;
    } else if (!list.length) {
      html += `<div class="empty">${
        S.view === 'mine' ? 'Nothing here yet. Shows you are watching on AniList appear here automatically. Search above to find and add any anime.' : 'No shows match these filters.'
      }</div>`;
    } else if (S.view === 'airing') {
      let day = '';
      let open = false;
      for (const s of list) {
        const d = dayFmt.format(new Date(s.next.airingAt * 1000));
        if (d !== day) {
          if (open) html += '</div>';
          day = d;
          html += `<div class="day">${esc(d)}</div><div class="grid">`;
          open = true;
        }
        html += card(s);
      }
      if (open) html += '</div>';
    } else {
      html += `<div class="grid">${list.map(card).join('')}</div>`;
    }
    html += searchMore(new Set(list.map((x) => x.id)));
    el.innerHTML = html;
    el.scrollTop = top;
  }

  /* ---------- search all of AniList ---------- */
  // The search box filters the current view instantly; after a pause it also asks AniList for any
  // anime with that title, shown below so you can track shows from other seasons.
  const searchById = (id) => S.search?.shows?.find((x) => x.id === id);
  function searchMore(shown) {
    const q = S.filters.q.trim();
    if (q.length < 2 || !S.search || S.search.q !== q) return '';
    if (S.search.loading) return '<section class="more"><h2 class="shelf-t">On AniList</h2><p class="note">Searching AniList…</p></section>';
    if (S.search.error) return `<section class="more"><h2 class="shelf-t">On AniList</h2><p class="err">Could not search AniList: ${esc(S.search.error)}</p></section>`;
    const more = S.search.shows.filter((x) => !shown.has(x.id));
    if (!more.length) return S.search.shows.length ? '' : '<section class="more"><h2 class="shelf-t">On AniList</h2><p class="note">No anime with that title on AniList.</p></section>';
    return `<section class="more"><h2 class="shelf-t">On AniList</h2><div class="grid">${more.map(card).join('')}</div></section>`;
  }
  let searchTimer;
  function scheduleSearch() {
    clearTimeout(searchTimer);
    const q = S.filters.q.trim();
    if (q.length < 2) {
      S.search = null;
      return;
    }
    if (S.search?.q !== q) S.search = { q, loading: true, shows: [] };
    searchTimer = setTimeout(async () => {
      const r = await window.api.search(q).catch((e) => ({ shows: [], error: e.message }));
      if (S.filters.q.trim() !== q) return; // typed on meanwhile
      S.search = { q, shows: r.shows || [], error: r.error || null };
      renderContent();
    }, 450);
  }

  function syncField(d) {
    if (!d.pending) return '<span>Everything is on AniList.</span>';
    const n = `${d.pending} change${d.pending > 1 ? 's' : ''}`;
    return d.auth.loggedIn
      ? `<span>${n} not sent to AniList yet.</span> <button class="btn small" data-refresh>Sync now</button>`
      : `<span>${n} saved on this device only. Log in to add ${d.pending > 1 ? 'them' : 'it'} to your AniList.</span>`;
  }

  // Your AniList account is your AniTrack account: progress lives on AniList, so it follows you to any
  // device. Without one, the app still works from a public username or entirely on this device.
  function accountSection(d) {
    const st = d.settings;
    const a = d.auth;
    const redirect = WEB ? d.redirectUrl : 'http://localhost/anitrack';
    const clientField = `<div class="field"><label for="clientId">Client ID</label><input type="text" id="clientId" inputmode="numeric" value="${esc(st.clientId)}" placeholder="e.g. 12345"><span class="hint">${
      a.builtInClient
        ? 'Optional. Only if you want to log in through your own AniList API client instead of the built-in one.'
        : 'Needed once to log in: create a free client at anilist.co/settings/developer and paste its ID here.'
    } Its redirect URL must be <b>${esc(redirect)}</b>${WEB ? ' (not http://localhost/anitrack, which only works in the Mac app)' : ''}.</span></div>`;
    const advanced = a.builtInClient ? `<details class="field adv"><summary>Advanced</summary>${clientField}</details>` : clientField;
    if (a.loggedIn) {
      const guest = d.guestItems
        ? `<div class="field"><label>This device</label><div><span>${d.guestItems} show${d.guestItems > 1 ? 's' : ''} tracked here before you logged in.</span> <button class="btn small" data-act="adoptGuest">Add to my AniList</button></div></div>`
        : '';
      return `<section class="section">
        <h2>Account</h2>
        <div class="field"><label>AniList</label><div class="who">${a.avatar ? `<img class="avatar" src="${esc(a.avatar)}" alt="">` : ''}<span>Logged in as <b>${esc(a.name)}</b></span> <button class="btn small" data-act="logout">Log out</button></div>
          <span class="hint">Your list, ratings and episode progress are saved on your AniList account, so they stay in step on every device you log in on.${WEB ? ' To switch to a different AniList account, also log out on anilist.co.' : ''}</span></div>
        <div class="field"><label>Sync</label><div>${syncField(d)}</div></div>
        ${guest}${advanced}
      </section>`;
    }
    const loginBtn = a.canLogin
      ? '<button class="btn primary small" data-act="login">Log in with AniList</button>'
      : '<span class="hint">Enter a client ID below to log in.</span>';
    const paste = WEB && a.canLogin ? '<div class="field"><label>Have a code?</label><div><button class="btn small" data-act="pasteCode">Paste an AniList code</button></div></div>' : '';
    return `<section class="section">
        <h2>Account</h2>
        <div class="field"><label>AniList</label><div>${loginBtn}</div>
          <span class="hint">Log in to save your progress to your AniList account and sync it across devices. No AniList account? Sign up free at anilist.co.</span></div>
        <div class="field"><label for="userName">Or just view</label><input type="text" id="userName" value="${esc(st.userName)}" placeholder="A public AniList username" autocapitalize="off" autocorrect="off"><span class="hint">Learns your taste from a public list without logging in. Anything you track is then kept on this device only.</span></div>
        <div class="field"><label>Sync</label><div>${syncField(d)}</div></div>
        ${a.builtInClient ? `${advanced}${paste}` : `${clientField}${paste}`}
      </section>`;
  }

  function deviceSection() {
    return `<section class="section">
        <h2>Privacy</h2>
        <p class="note">AniTrack has no servers. It talks only to AniList${WEB ? '' : ' and Crunchyroll'}, and keeps everything else on this device.</p>
        <div class="field"><label>This device</label><div><button class="btn small danger" data-act="resetDevice">Remove all AniTrack data from this ${WEB ? 'browser' : 'Mac'}</button></div><span class="hint">Logs out and clears local tracking and caches. Useful on a shared device. Nothing on AniList is deleted.</span></div>
      </section>`;
  }

  function welcomeHtml() {
    const a = S.data.auth;
    return `<section class="welcome">
      <h1 class="hero-t">Welcome to AniTrack</h1>
      <p class="note">Keep up with this season's anime: what airs when, what is ready to watch, and picks ranked by your taste.</p>
      <div class="welcome-opts">
        <div class="wopt"><h3>Log in with AniList</h3><p class="note">Recommended. Your progress is saved to your AniList account and syncs between devices. Free to sign up at anilist.co.</p>
          ${a.canLogin ? '<button class="btn primary" data-act="login">Log in with AniList</button>' : '<button class="btn primary" data-nav="settings">Set up login</button>'}</div>
        <div class="wopt"><h3>Use a public username</h3><p class="note">Learn your taste from a public AniList list without logging in.</p>
          <form data-form="welcomeName"><input type="text" name="u" placeholder="AniList username" autocapitalize="off" autocorrect="off" aria-label="AniList username"> <button class="btn">Continue</button></form></div>
        <div class="wopt"><h3>Just look around</h3><p class="note">Browse the season with nothing saved anywhere but this device.</p>
          <button class="btn" data-act="welcomeSkip">Continue without an account</button></div>
      </div></section>`;
  }

  function addonList() {
    const v = store.get('stremioAddons', []);
    return Array.isArray(v) ? v : [];
  }
  function saveAddonList(v) { store.set('stremioAddons', v.slice(0, 30)); }
  function stremioUrl(url) {
    const u = new URL(url);
    return 'stremio://' + u.host + u.pathname + u.search + u.hash;
  }
  async function getAddon(url) {
    let u = String(url || '').trim();
    if (!/^https?:\\/\\//i.test(u)) throw new Error('Enter an HTTPS manifest URL.');
    if (u.endsWith('/')) u += 'manifest.json';
    const res = await fetch(u, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) throw new Error('Could not read the manifest (HTTP ' + res.status + ').');
    const m = await res.json();
    for (const k of ['id','version','name','description','resources','types']) if (m[k] == null) throw new Error('Manifest is missing ' + k + '.');
    return { id:String(m.id), version:String(m.version), name:String(m.name), description:String(m.description), logo:typeof m.logo === 'string' ? m.logo : '', url:u, configurable:!!m.behaviorHints?.configurable };
  }
  function addonsSection() {
    const rows = addonList().map((a) => '<div class="field"><div><b>' + esc(a.name) + '</b><div class="hint">v' + esc(a.version) + ' · ' + esc(a.description) + '</div></div><div><button class="btn primary small" data-act="installAddon" data-addon-id="' + esc(a.id) + '">Install in Stremio ↗</button>' + (a.configurable ? ' <button class="btn small" data-act="configureAddon" data-addon-id="' + esc(a.id) + '">Configure ↗</button>' : '') + ' <button class="btn small" data-act="removeAddon" data-addon-id="' + esc(a.id) + '">Remove</button></div></div>').join('');
    return '<section class="section"><h2>Stremio Addons</h2><p class="note">Add a Stremio addon by its manifest URL. AniTrack stores the addon details on this device.</p><form data-form="stremioAddon" class="field"><label for="addonUrl">Addon manifest URL</label><div><input id="addonUrl" name="url" type="url" placeholder="https://example.com/manifest.json" required><button class="btn primary" type="submit">Add addon</button></div><span class="hint">Stremio addons expose a manifest.json describing their capabilities.</span></form>' + (rows || '<p class="note">No addons added yet.</p>') + '</section>';
  }
  function torboxSection() {
    return `<section class="section">
        <h2>TorBox / Stremio</h2>
        <p class="note">Use TorBox with Stremio for media already in your TorBox account. AniTrack does not scrape torrent sources or handle third-party stream discovery.</p>
        <div class="field"><label>Setup</label><div><button class="btn primary small" data-act="torboxStremio">Set up TorBox in Stremio ↗</button> <button class="btn small" data-act="torboxSettings">TorBox settings ↗</button></div><span class="hint">TorBox discontinued its official hosted Stremio addon. The Stremio setup opens a community addon that exposes your own TorBox library; your TorBox API key is entered in that addon, not stored by AniTrack.</span></div>
      </section>`;
  }

  function settingsHtml() {
    const d = S.data;
    const st = d.settings;
    if (WEB) {
      return `
      ${accountSection(d)}
      ${torboxSection()}
      ${addonsSection()}
      <section class="section">
        <h2>Watching on iPhone</h2>
        <p class="note">Watch opens the show on Crunchyroll. When you come back, AniTrack asks whether you finished the episode and marks it on AniList for you.</p>
        <p class="note">For a reminder when episodes air, use <b>Export calendar</b> on My Shows and choose Add All.</p>
      </section>
      <section class="section"><h2>Season</h2><div class="season"><button class="btn small" data-season="-1" aria-label="Previous season">‹</button><b>${esc(`${d.season.season[0]}${d.season.season.slice(1).toLowerCase()} ${d.season.year}`)}</b><button class="btn small" data-season="1" aria-label="Next season">›</button></div>
        <p class="note">${d.updatedAt ? `Updated ${esc(timeFmt.format(new Date(d.updatedAt)))}` : ''} <button class="btn small" data-refresh>Refresh now</button></p></section>
      ${deviceSection()}`;
    }
    return `
      ${accountSection(d)}
      ${torboxSection()}
      ${addonsSection()}
      <section class="section">
        <h2>Watching</h2>
        <div class="field"><label for="autoMark">Mark episode watched at</label><select id="autoMark">${[0.8, 0.9, 0.95]
          .map((v) => `<option value="${v}" ${Number(st.autoMarkPct) === v ? 'selected' : ''}>${Math.round(v * 100)}% of the episode</option>`)
          .join('')}</select><span class="hint">Applies when you watch in the Crunchyroll window. The next episode is counted and sent to AniList.</span></div>
        <div class="field"><label for="notify">Notifications</label><label><input type="checkbox" id="notify" ${st.notify ? 'checked' : ''}> Tell me when an episode of a Watching or Planning show airs</label></div>
        <div class="field"><label>Crunchyroll playback</label><div>${
          d.drm
            ? 'Widevine build detected. Sign in to Crunchyroll once in the watch window and it stays signed in.'
            : 'This copy of Electron has no Widevine, so video will not play in the app. Watch opens Crunchyroll but you will need the Widevine build (see README).'
        }</div></div>
      </section>
      <section class="section">
        <h2>More</h2>
        <div class="field"><label>Menu bar</label><div>The next episode countdown for your shows shows in the menu bar. Click it to open AniTrack.</div></div>
        <div class="field"><label>Shortcuts</label><div class="keys"><span><kbd>⌘1</kbd>–<kbd>⌘8</kbd> switch view</span><span><kbd>/</kbd> or <kbd>⌘F</kbd> search</span><span><kbd>Esc</kbd> clear search / close player</span></div></div>
      </section>
      ${deviceSection()}`;
  }

  function render() {
    document.querySelector('.main').dataset.view = S.player ? 'player' : S.data?.firstRun && S.view !== 'settings' ? 'welcome' : S.view;
    renderNav();
    renderBar();
    renderContent();
    if (S.detail) renderDetails();
  }

  // Refreshes from AniList. Ignores clicks while a load is running, so repeated taps cannot pile up requests.
  async function load(msg, opts) {
    if (S.loadingMsg) return;
    S.loadingMsg = msg;
    toast(msg);
    try {
      S.data = await window.api.refresh(opts);
    } catch (err) {
      toast(`Could not refresh: ${err?.message || err}`);
    } finally {
      S.loadingMsg = null;
    }
    render();
  }

  async function adoptGuest() {
    const r = await window.api.adoptGuest();
    S.data = r.data;
    toast(r.count ? `Added ${r.count} show${r.count > 1 ? 's' : ''} to your AniList` : 'Nothing new to add');
    render();
  }
  // Right after logging in: offer to send what was tracked here while logged out.
  function offerGuest() {
    const n = S.data?.guestItems;
    if (n) setTimeout(() => toast(`You tracked ${n} show${n > 1 ? 's' : ''} on this device before logging in. Add ${n > 1 ? 'them' : 'it'} to your AniList?`, { label: 'Add', fn: adoptGuest }), 1500);
  }

  // Switches view. A new view opens at the top; tapping the view you are on scrolls it back up.
  function go(view) {
    const same = S.view === view;
    S.view = view;
    store.set('view', S.view);
    render();
    if (same) {
      $('#content').scrollTo({ top: 0, behavior: 'smooth' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      $('#content').scrollTop = 0;
      window.scrollTo(0, 0);
    }
    onScroll();
  }

  // Phones scroll the page, the Mac scrolls #content. Past the hero (or the top), the header turns solid.
  function onScroll() {
    const top = Math.max($('#content').scrollTop, window.scrollY);
    const hero = $('#content .hero');
    document.documentElement.classList.toggle('scrolled', top > (hero ? hero.offsetHeight - 90 : 8));
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  $('#content').addEventListener('scroll', onScroll, { passive: true });

  /* ---------- login sheets (Home Screen app: log in in Safari, paste the code back) ---------- */
  function openSheet(html) {
    closeSheet();
    const back = document.createElement('div');
    back.className = 'sheet-back';
    back.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
    back.addEventListener('click', (e) => {
      if (e.target === back || e.target.closest('[data-sheet-close]')) closeSheet();
    });
    document.body.append(back);
    return back.querySelector('.sheet');
  }
  function closeSheet() {
    document.querySelector('.sheet-back')?.remove();
    S.detail = null;
  }

  async function submitCode(sheet, text) {
    const msgEl = sheet.querySelector('.sheet-msg');
    msgEl.textContent = 'Checking with AniList…';
    const r = await window.api.loginWithToken(text);
    S.data = r.data;
    if (!r.ok) {
      msgEl.textContent = r.msg;
      return;
    }
    closeSheet();
    toast(r.msg);
    offerGuest();
    render();
  }

  // In the Home Screen app, after AniList opened in a Safari sheet.
  function pasteSheet() {
    const sheet = openSheet(`<h2>Finish logging in</h2>
      <ol class="steps"><li>In the AniList window, log in if asked and tap <b>Authorize</b>.</li>
        <li>Tap <b>Copy code</b> on the page that follows, then <b>Done</b> to come back here.</li>
        <li>Tap <b>Paste code</b>.</li></ol>
      <p class="hint">If Safari says it can't connect to the server, that is fine: your code is in its address. Tap the address bar, copy the whole address, come back and tap Paste code. To avoid this next time, set your AniList client's redirect URL to <b>${esc(S.data?.redirectUrl || '')}</b>.</p>
      <button class="btn primary big wide" data-sheet="paste">Paste code</button>
      <form data-sheet="form"><input type="text" name="code" placeholder="Or paste the code here" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="AniList code"><button class="btn">Log in</button></form>
      <p class="sheet-msg" role="status"></p>
      <div class="sheet-foot"><button class="link" data-act="login">Open AniList again</button><button class="link" data-sheet-close>Cancel</button></div>`);
    sheet.querySelector('[data-sheet="paste"]').addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) return submitCode(sheet, text);
      } catch {
        /* no clipboard access: the field below works */
      }
      sheet.querySelector('.sheet-msg').textContent = 'Could not read the clipboard. Long-press the box below, tap Paste, then Log in.';
      sheet.querySelector('input').focus();
    });
    sheet.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = e.target.elements.code.value;
      if (v.trim()) submitCode(sheet, v);
    });
  }

  // In the Safari sheet that AniList returned to (or after a login link this browser did not start).
  function handoffSheet({ name, token }) {
    const sheet = openSheet(`<h2>Almost there, ${esc(name)}</h2>
      <p class="note">Tap <b>Copy code</b>, go back to the AniTrack app (tap <b>Done</b> at the top), and tap <b>Paste code</b>.</p>
      <button class="btn primary big wide" data-sheet="copy">Copy code</button>
      <textarea class="code" readonly hidden aria-label="Your AniList code"></textarea>
      <p class="sheet-msg" role="status"></p>
      <div class="sheet-foot"><button class="link" data-sheet="here">Use AniTrack in this browser instead</button><button class="link" data-sheet-close>Close</button></div>
      <p class="hint">Only continue if you just tapped Log in yourself. Keep this code private: it lets an app update your AniList list.</p>`);
    sheet.querySelector('[data-sheet="copy"]').addEventListener('click', async () => {
      const msgEl = sheet.querySelector('.sheet-msg');
      try {
        await navigator.clipboard.writeText(token);
        msgEl.textContent = 'Copied. Now go back to the AniTrack app and tap Paste code.';
      } catch {
        const box = sheet.querySelector('.code');
        box.hidden = false;
        box.value = token;
        box.select();
        msgEl.textContent = 'Select the code above, tap Copy, then go back to the AniTrack app.';
      }
    });
    sheet.querySelector('[data-sheet="here"]').addEventListener('click', () => submitCode(sheet, token));
  }

  /* ---------- details page ---------- */
  const anyById = (id) => byId(id) || listById(id) || searchById(id) || (S.detail?.id === id ? S.detail : null);

  async function openDetails(id) {
    openSheet('<p class="note">Loading…</p>').classList.add('detail'); // closes any open sheet first
    S.detail = { id, loading: true };
    const r = await window.api.details(id);
    if (S.detail?.id !== id) return; // closed or replaced meanwhile
    if (r.error) {
      S.detail = null;
      closeSheet();
      toast(r.error);
      return;
    }
    S.detail = { ...r.show, resume: r.resume };
    renderDetails();
  }

  function renderDetails() {
    const sheet = document.querySelector('.sheet.detail');
    const d = S.detail;
    if (!sheet || !d || d.loading) return;
    const top = sheet.scrollTop;
    const facts = [d.format?.replace('_', ' '), d.episodes ? `${d.episodes} episodes` : '', d.season, d.studio, d.score ? `${d.score}% on AniList` : ''].filter(Boolean).join(' · ');
    const pct = d.me.status && d.episodes ? Math.min(100, Math.round((d.me.progress / d.episodes) * 100)) : 0;
    const streams = d.streams.map((x) => `<button class="btn small" data-act="ext" data-url="${esc(x.url)}">${esc(x.site)} ↗</button>`).join('');
    const related = d.related
      .map((x) => `<button class="rel-item" data-act="details" data-id="${x.id}"><span class="sub">${esc(x.relation)}${x.format ? ` · ${esc(x.format.replace('_', ' '))}` : ''}</span><span>${esc(x.title)}</span>${x.me.status ? `<span class="chip">${esc(STATUS_LABEL[x.me.status] || '')}</span>` : ''}</button>`)
      .join('');
    sheet.innerHTML = `<div class="d-head" data-id="${d.id}">
        <div class="d-cover" style="${d.color ? `background:${esc(d.color)}` : ''}">${d.coverXL || d.cover ? `<img src="${esc(d.coverXL || d.cover)}" alt="" decoding="async">` : ''}</div>
        <div class="d-title"><h2>${esc(d.title)}</h2>${d.romaji && d.romaji !== d.title ? `<div class="sub">${esc(d.romaji)}</div>` : ''}
          <div class="meta">${esc(facts)}</div>
          ${d.match != null ? `<div class="why">${d.match}% match${d.why.length ? ` · you like ${esc(d.why.join(', '))}` : ''}</div>` : ''}
          <div class="chips">${badges(d)}</div></div>
        <button class="link d-close" data-sheet-close aria-label="Close">✕</button>
      </div>
      <div class="d-body" data-id="${d.id}">
        ${actsHtml(d)}
        ${nextLine(d)}
        ${pct ? `<div class="hero-prog"><span class="track"><i style="width:${pct}%"></i></span><span>${d.me.progress}${d.episodes ? ` of ${d.episodes}` : ''} watched</span></div>` : ''}
        ${d.synopsis ? `<p class="synopsis">${esc(d.synopsis)}</p>` : ''}
        ${d.genres.length ? `<div class="chips">${d.genres.map((g) => `<span class="chip">${esc(g)}</span>`).join('')}</div>` : ''}
        ${streams ? `<h3>Where to watch</h3><div class="d-row">${streams}</div>` : ''}
        ${d.trailer ? `<h3>Trailer</h3><div class="d-row"><button class="btn small" data-act="ext" data-url="${esc(d.trailer)}">▶ Watch the trailer ↗</button></div>` : ''}
        ${related ? `<h3>Related</h3><div class="d-related">${related}</div>` : ''}
        <div class="sheet-foot">${d.siteUrl ? `<button class="link" data-act="ext" data-url="${esc(d.siteUrl)}">Open on AniList ↗</button>` : '<span></span>'}<button class="link" data-sheet-close>Close</button></div>
      </div>`;
    sheet.scrollTop = top;
  }

  // After the last episode: a quick 1-10 score, saved to AniList (it also sharpens For You).
  function rateSheet(id, title) {
    const sheet = openSheet(`<h2>You finished ${esc(title)}</h2><p class="note">How would you rate it?</p>
      <div class="rate">${Array.from({ length: 10 }, (_, i) => `<button class="btn" data-score="${i + 1}">${i + 1}</button>`).join('')}</div>
      <p class="sheet-msg" role="status"></p>
      <div class="sheet-foot"><span class="hint">Saved to your AniList score.</span><button class="link" data-sheet-close>Not now</button></div>`);
    sheet.querySelector('.rate').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-score]');
      if (!b) return;
      const r = await window.api.rate(id, Number(b.dataset.score));
      if (!r.ok) {
        sheet.querySelector('.sheet-msg').textContent = r.error;
        return;
      }
      closeSheet();
      const entry = listById(id);
      if (entry) entry.score = r.score;
      toast(`Rated ${title} ${r.score}/10`);
      render();
    });
  }

  /* ---------- pull to refresh (phones) ---------- */
  if (WEB) {
    const ptr = document.createElement('div');
    ptr.className = 'ptr';
    ptr.setAttribute('aria-hidden', 'true');
    ptr.innerHTML = '<span>↓</span>';
    document.body.append(ptr);
    let startY = null;
    let pull = 0;
    document.addEventListener('touchstart', (e) => {
      startY = window.scrollY <= 0 && e.touches.length === 1 && !document.querySelector('.sheet-back') && !e.target.closest?.('.shelf-row, .filters, input, select') ? e.touches[0].clientY : null;
      pull = 0;
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (startY == null) return;
      pull = Math.max(0, Math.min(120, (e.touches[0].clientY - startY) * 0.5));
      ptr.style.transform = `translate(-50%, ${pull - 50}px) rotate(${pull * 3}deg)`;
      ptr.classList.toggle('ready', pull >= 64);
    }, { passive: true });
    document.addEventListener('touchend', () => {
      if (startY == null) return;
      const go = pull >= 64;
      startY = null;
      ptr.style.transform = '';
      ptr.classList.remove('ready');
      if (go) load('Refreshing from AniList…', { force: true });
    });
  }

  /* ---------- toast ---------- */
  let toastTimer;
  function toast(msg, action) {
    const t = $('#toast');
    t.textContent = msg;
    S.undo = action || null;
    if (action) {
      const b = document.createElement('button');
      b.className = 'toast-act';
      b.textContent = action.label;
      b.dataset.act = 'undo';
      t.append(b);
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), action ? 15000 : 5000);
  }

  /* ---------- actions ---------- */
  async function applyTrack(id, patch, noUndo) {
    const found = searchById(id);
    const det = S.detail?.id === id ? S.detail : null;
    const s = byId(id) || found || det;
    const l = listById(id);
    if (!s && !l) return;
    const before = { status: (s || l).me.status || null, progress: (s || l).me.progress };
    const r = await window.api.setTrack(id, patch);
    for (const x of [byId(id), found, l, det]) if (x) x.me = r.me;
    // A show added from search: reload so it appears in My Shows and the other views straight away.
    if (found && !byId(id)) S.data = await window.api.refresh({});
    if (r.me.status === 'COMPLETED' && before.status !== 'COMPLETED' && S.data.auth.loggedIn && !noUndo) setTimeout(() => rateSheet(id, (s || l).title), 600);
    const undo = noUndo ? null : { label: 'Undo', fn: () => applyTrack(id, before, true) };
    if (r.pushed) toast(`AniList updated: ${(s || l).title}`, undo);
    else if (r.error) toast(`Saved here, but AniList said: ${r.error}`);
    else if (!noUndo && patch.progress != null) toast(`${(s || l).title}: episode ${r.me.progress}`, undo);
    else if (r.reason === 'not-logged-in' && !S.shownSyncHint) {
      S.shownSyncHint = true;
      toast('Saved here. Log in with AniList in Settings to sync it to your list.');
    }
    render();
  }

  document.addEventListener('click', async (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      if (S.player) await window.api.closePlayer();
      go(nav.dataset.nav);
      return;
    }
    const tm = e.target.closest('[data-tmins]');
    if (tm) {
      S.tmins = Number(tm.dataset.tmins);
      store.set('tmins', S.tmins);
      render();
      return;
    }
    const lt = e.target.closest('[data-listtab]');
    if (lt) {
      S.listTab = lt.dataset.listtab;
      store.set('listTab', S.listTab);
      render();
      return;
    }
    const filter = e.target.closest('[data-filter]');
    if (filter) {
      const k = filter.dataset.filter;
      S.filters[k] = !S.filters[k];
      saveFilters();
      render();
      return;
    }
    if (e.target.closest('[data-refresh]')) {
      load('Refreshing from AniList…', { force: true });
      return;
    }
    const sw = e.target.closest('[data-season]');
    if (sw && S.data) {
      const { season, year } = S.data.season;
      let i = SEASONS.indexOf(season) + Number(sw.dataset.season);
      let y = year;
      if (i < 0) {
        i = 3;
        y -= 1;
      } else if (i > 3) {
        i = 0;
        y += 1;
      }
      load(`Loading ${SEASONS[i].toLowerCase()} ${y}…`, { season: SEASONS[i], year: y });
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.tagName === 'SELECT') return;
    const act = btn.dataset.act;
    if (act === 'undo') {
      const u = S.undo;
      S.undo = null;
      $('#toast').hidden = true;
      if (u) u.fn();
      return;
    }
    if (act === 'plan') {
      const id0 = Number(btn.closest('[data-id]').dataset.id);
      applyTrack(id0, { status: 'PLANNING' });
      return;
    }
    if (act === 'shuffle') {
      S.seed = Math.floor(Math.random() * 1e6);
      render();
      return;
    }
    if (act === 'exportCal') {
      const r = await window.api.exportCalendar();
      if (r && r.ok) toast(`Saved ${r.count} upcoming episodes to your calendar file`);
      else if (r && r.error) toast(r.error);
      return;
    }
    if (act === 'login') {
      toast('Opening AniList…');
      const r = await window.api.login();
      if (r.paste) {
        $('#toast').hidden = true;
        pasteSheet();
        return;
      }
      if (r.ok) {
        S.data = r.data;
        toast(`Logged in as ${r.name}`);
        offerGuest();
      } else toast(r.error);
      render();
      return;
    }
    if (act === 'logout') {
      S.data = await window.api.logout();
      toast('Logged out. Anything you track now stays on this device.');
      render();
      return;
    }
    if (act === 'pasteCode') {
      pasteSheet();
      return;
    }
    if (act === 'adoptGuest') {
      adoptGuest();
      return;
    }
    if (act === 'resetDevice') {
      if (!window.confirm('Remove all AniTrack data from this device? You will be logged out. Your AniList account is not affected.')) return;
      await window.api.resetDevice();
      return;
    }
    if (act === 'welcomeSkip') {
      S.data = await window.api.saveSettings({ welcomed: true });
      S.view = 'season';
      store.set('view', S.view);
      render();
      return;
    }
    if (act === 'closePlayer') {
      await window.api.closePlayer();
      return;
    }
    if (act === 'playerExt') {
      window.api.playerExternal();
      return;
    }
    if (['installAddon','configureAddon','removeAddon'].includes(act)) {
      const addon = addonList().find((x) => x.id === btn.dataset.addonId);
      if (!addon) return;
      if (act === 'removeAddon') { saveAddonList(addonList().filter((x) => x.id !== addon.id)); toast('Addon removed'); render(); return; }
      if (act === 'configureAddon') { window.api.openExternal(new URL('configure', new URL(addon.url)).href); return; }
      window.api.openExternal(stremioUrl(addon.url));
      return;
    }
    if (act === 'torboxStremio') {
      window.api.openExternal('https://st-tor.notkek.workers.dev/');
      return;
    }
    if (act === 'torboxSettings') {
      window.api.openExternal('https://torbox.app/settings?section=stremio-settings');
      return;
    }
    const cardEl = btn.closest('[data-id]');
    const id = cardEl ? Number(cardEl.dataset.id) : null;
    const s = id ? anyById(id) : null;
    if (act === 'details' && id) openDetails(id);
    else if (act === 'ext') window.api.openExternal(btn.dataset.url);
    else if (act === 'watch' && id) {
      if (S.detail) closeSheet();
      const r = await window.api.watch(id);
      if (r.ok && r.external && s) {
        S.pending = { id, ep: (s.me.progress || 0) + 1, title: s.title, t: Date.now() };
        store.set('pending', S.pending);
      }
      if (!r.ok) toast(r.error);
      else if (!r.drm) toast('No Widevine in this Electron build, so video may not play. See the README.');
    } else if ((act === 'inc' || act === 'dec') && s) {
      applyTrack(id, { progress: Math.max(0, s.me.progress + (act === 'inc' ? 1 : -1)) });
    }
  });

  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'sort') {
      S.sort = t.value;
      store.set('sort', S.sort);
      render();
      return;
    }
    if (t.id === 'genre') {
      S.filters.genre = t.value;
      render();
      return;
    }
    if (t.dataset.act === 'status') {
      const id = Number(t.closest('[data-id]').dataset.id);
      applyTrack(id, { status: t.value || null });
      return;
    }
    if (!S.data || S.view !== 'settings') return;
    const patch = {};
    if (t.id === 'userName') patch.userName = t.value;
    else if (t.id === 'clientId') patch.clientId = t.value;
    else if (t.id === 'notify') patch.notify = t.checked;
    else if (t.id === 'autoMark') patch.autoMarkPct = Number(t.value);
    else return;
    S.data = await window.api.saveSettings(patch);
    toast('Saved');
    render();
  });

    const form = e.target.closest('[data-form="welcomeName"]');
    if (!form) return;
    e.preventDefault();
    const u = form.elements.u.value.trim();
    if (!u) return;
    toast(`Reading ${u}'s list…`);
    S.data = await window.api.saveSettings({ userName: u, welcomed: true });
    S.view = 'foryou';
    store.set('view', S.view);
    toast(S.data.errors?.user || `Ranked by ${u}'s taste`);
    render();
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'q') {
      S.filters.q = e.target.value;
      scheduleSearch();
      renderNav();
      renderContent();
    }
  });

  document.addEventListener('keydown', async (e) => {
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if ((e.metaKey || e.ctrlKey) && /^[1-8]$/.test(e.key)) {
      e.preventDefault();
      const v = VIEWS[Number(e.key) - 1];
      if (v) {
        if (S.player) await window.api.closePlayer();
        go(v.id);
      }
    } else if (((e.metaKey || e.ctrlKey) && e.key === 'f') || (e.key === '/' && !typing)) {
      const q = $('#q');
      if (q) {
        e.preventDefault();
        q.focus();
        q.select();
      }
    } else if (e.key === 'Escape' && document.querySelector('.sheet-back')) {
      closeSheet();
    } else if (e.key === 'Escape') {
      if (S.player) window.api.closePlayer();
      else if (S.filters.q) {
        S.filters.q = '';
        render();
      }
    }
  });

  // iPhone: you watched in the Crunchyroll app, so ask about it when you come back.
  S.pending = store.get('pending', null);
  function askPending() {
    const p = S.pending;
    if (!p || !S.data) return;
    const away = Date.now() - p.t;
    if (away < 4 * 60e3) return; // just a quick look
    S.pending = null;
    store.set('pending', null);
    if (away > 12 * 3600e3) return;
    const cur = byId(p.id) || listById(p.id);
    if (cur && cur.me.progress >= p.ep) return; // already counted
    toast(`Finished ${p.title} episode ${p.ep}?`, { label: 'Mark watched', fn: () => applyTrack(p.id, { progress: p.ep }) });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setTimeout(askPending, 600);
  });

  window.api.on('data', (d) => {
    S.data = d;
    render();
  });
  window.api.on('login', handoffSheet);
  window.api.on('toast', (t) => (typeof t === 'string' ? toast(t) : toast(t.msg, t.action)));
  window.api.on('player', (p) => {
    S.player = p;
    render();
  });
  // Every minute the countdowns tick in place. A full redraw (which re-sorts and moves shows whose
  // episode just aired) only happens every ten minutes, and never while you are typing or choosing.
  let ticks = 0;
  setInterval(() => {
    for (const el of document.querySelectorAll('.rel[data-at]')) el.textContent = rel(Number(el.dataset.at));
    ticks += 1;
    if (ticks % 10 === 0 && S.data && !S.player && !S.detail && S.view !== 'settings' && document.activeElement?.id !== 'q' && document.activeElement?.tagName !== 'SELECT') renderContent();
  }, 60000);

  render();
  window.api.init().then((d) => {
    S.data = d;
    render();
    setTimeout(askPending, 800);
  });
})();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
