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
  const extras = new Map(); // id -> details-only data (trailer, related titles), fetched once
  async function details(id) {
    id = Number(id);
    let full = extras.get(id);
    if (!full) {
      try {
        full = await AL.fetchDetails(id);
        if (full) extras.set(id, full);
      } catch (e) {
        if (!findRaw(id)) throw e; // nothing to show at all
        // Offline or AniList hiccup: show the page from what is loaded, without trailer and titles.
      }
    }
    let raw = findRaw(id);
    if (!raw) {
      if (!full) return null;
      raw = full;
      found.set(id, raw);
    }
    if (full) raw = { ...raw, description: full.description ?? raw.description, trailer: full.trailer, relations: full.relations || raw.relations };
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
