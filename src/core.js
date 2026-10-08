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

function createCore({ AL, settings, tracking, cache, dubMatch = () => null, getToken, clearToken, now = Date.now }) {
  // Everything the UI shows is derived from this.
  const S = { raw: [], extra: [], list: [], listMap: {}, taste: null, season: seasonFor(new Date(now())), updatedAt: 0, errors: {} };
  const allRaw = () => [...S.raw, ...S.extra]; // this season plus shows you watch from earlier seasons
  const findRaw = (id) => allRaw().find((r) => r.id === id);
  const userName = () => String(settings.get('userName') || '').trim();

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
    const cr = (r.externalLinks || []).find((l) => l.type === 'STREAMING' && /crunchyroll/i.test(l.site));
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
      studio: r.studios?.nodes?.[0]?.name?.trim() || '',
      start: r.startDate,
      next: r.nextAiringEpisode,
      crUrl: cr?.url || null,
      onCR: !!cr,
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
    if (u && u.name === userName()) useUser(u);
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
        .slice(0, SEASONS_KEPT - 1);
      cache.set('seasons', { ...Object.fromEntries(keep), [key]: fresh });
      return fresh;
    } catch (e) {
      errors.season = `Could not load the season from AniList: ${e.message}`;
      return c || { ts: 0, shows: [] };
    }
  }

  async function syncUser(force, errors) {
    const name = userName();
    if (!name) return useUser(null);
    const u = cache.get('user');
    if (u && u.name === name && !force && now() - u.ts < USER_TTL) return useUser(u);
    try {
      const entries = await AL.fetchUserList(name);
      const fresh = { name, ts: now(), listMap: listMapFrom(entries), list: compactList(entries), taste: buildTaste(entries) };
      cache.set('user', fresh);
      useUser(fresh);
    } catch (e) {
      errors.user = `Could not read the AniList list for "${name}": ${e.message}`;
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
    const push = await pushToAniList(id, patch, next);
    const item = tracking.get('items')[id];
    if (item) {
      if (push.pushed) delete item.dirty;
      else if (push.reason !== 'local-only' && ('progress' in patch || (patch.status && patch.status !== 'SKIP'))) item.dirty = true;
      tracking.set('items', tracking.get('items'));
    }
    return { me: meFor(id), ...push };
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

  return { S, allRaw, findRaw, meFor, enrich, basePayload, pendingCount, loadFromCache, refresh, setTrack, upcoming };
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
