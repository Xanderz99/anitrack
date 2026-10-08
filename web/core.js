'use strict';
// Browser version of the Mac app's main process (src/main.js). It runs inside the page and exposes
// the same window.api the Mac renderer uses, so renderer/app.js works unchanged on the iPhone.
(() => {
  const AL = require('./anilist');
  const { buildTaste, scoreShow, summarizeTaste, listMapFrom, seasonFor } = require('./taste');
  const { makeDubMatcher } = require('./dubs');

  /* ---------- storage (localStorage, one key per store) ---------- */
  class Store {
    constructor(name, defaults) {
      this.key = `anitrack:${name}`;
      this.data = { ...defaults };
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
      try {
        localStorage.setItem(this.key, JSON.stringify(this.data));
      } catch {
        // Storage full: drop cached seasons (they can be fetched again) and retry once.
        if (this.data.seasons) {
          this.data.seasons = {};
          try {
            localStorage.setItem(this.key, JSON.stringify(this.data));
          } catch {
            /* give up quietly */
          }
        }
      }
    }
  }

  const settings = new Store('settings', { userName: 'Xanderz99', clientId: '', token: '', viewerName: '' });
  const tracking = new Store('tracking', { items: {}, notified: {} });
  const cache = new Store('cache', { seasons: {}, user: null, extra: null });
  const dubMatch = makeDubMatcher(null);

  const listeners = { data: [], toast: [], player: [] };
  const emit = (ch, d) => (listeners[ch] || []).forEach((cb) => cb(d));

  const S = { raw: [], extra: [], list: [], listMap: {}, taste: null, season: seasonFor(new Date()), updatedAt: 0, errors: {} };
  const allRaw = () => [...S.raw, ...S.extra];
  const L2ME = { CURRENT: 'WATCHING', REPEATING: 'WATCHING', PLANNING: 'PLANNING', COMPLETED: 'COMPLETED', PAUSED: 'PAUSED', DROPPED: 'DROPPED' };
  const redirectUrl = () => location.origin + location.pathname;

  function meFor(id) {
    const t = tracking.get('items')[id];
    const l = S.listMap[id];
    return { status: t?.status ?? (l ? L2ME[l.status] : null) ?? null, progress: t?.progress ?? l?.progress ?? 0, inList: !!l };
  }

  function enrich(r) {
    const title = r.title.english || r.title.romaji;
    const cr = (r.externalLinks || []).find((l) => l.type === 'STREAMING' && /crunchyroll/i.test(l.site));
    const prequels = (r.relations?.edges || []).filter((e) => e.relationType === 'PREQUEL' && e.node.type === 'ANIME').map((e) => e.node.id);
    const seenPrequel = prequels.some((id) => ['COMPLETED', 'REPEATING', 'CURRENT'].includes(S.listMap[id]?.status));
    const match = scoreShow(r, S.taste);
    return {
      id: r.id,
      title,
      romaji: r.title.romaji,
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
      match: match ? match.pct : null,
      why: match ? match.why : [],
      against: match ? match.against : [],
    };
  }

  function payload() {
    return {
      platform: 'web',
      redirectUrl: redirectUrl(),
      shows: allRaw().map((r) => ({ ...enrich(r), me: meFor(r.id), resume: null, offSeason: !S.raw.includes(r) })),
      list: S.list.map((e) => ({ ...e, me: meFor(e.id) })),
      season: S.season,
      updatedAt: S.updatedAt,
      settings: { userName: settings.get('userName'), clientId: settings.get('clientId') },
      auth: { loggedIn: !!settings.get('token'), name: settings.get('viewerName') || '' },
      taste: S.taste ? summarizeTaste(S.taste) : null,
      errors: S.errors,
      drm: false,
    };
  }

  /* ---------- loading ---------- */
  function useUser(u) {
    S.listMap = u.listMap;
    S.list = u.list || [];
    S.taste = u.taste;
  }

  function loadFromCache() {
    const c = cache.get('seasons')[`${S.season.season}-${S.season.year}`];
    if (c) {
      S.raw = c.shows;
      S.updatedAt = c.ts;
    }
    const u = cache.get('user');
    if (u && u.name === (settings.get('userName') || '').trim()) useUser(u);
    S.extra = cache.get('extra')?.shows || [];
  }

  async function loadExtra(force) {
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
    if (c && c.ids.join(',') === want.join(',') && !force && Date.now() - c.ts < 30 * 60e3) {
      S.extra = c.shows;
      return;
    }
    try {
      S.extra = await AL.fetchByIds(want);
      cache.set('extra', { ts: Date.now(), ids: want, shows: S.extra });
    } catch (e) {
      S.errors.extra = `Could not load your other watching shows: ${e.message}`;
      S.extra = c ? c.shows : [];
    }
  }

  const compactList = (entries) =>
    entries.map((e) => ({
      id: e.media.id,
      title: e.media.title?.english || e.media.title?.romaji || 'Untitled',
      romaji: e.media.title?.romaji || '',
      cover: e.media.coverImage?.medium || null,
      color: e.media.coverImage?.color || null,
      format: e.media.format,
      episodes: e.media.episodes,
      siteUrl: e.media.siteUrl,
      score: e.score,
    }));

  async function syncUser(force) {
    const name = (settings.get('userName') || '').trim();
    if (!name) return useUser({ listMap: {}, list: [], taste: null });
    const u = cache.get('user');
    if (u && u.name === name && !force && Date.now() - u.ts < 6 * 3600e3) return useUser(u);
    try {
      const entries = await AL.fetchUserList(name);
      const fresh = { name, ts: Date.now(), listMap: listMapFrom(entries), list: compactList(entries), taste: buildTaste(entries) };
      cache.set('user', fresh);
      useUser(fresh);
    } catch (e) {
      S.errors.user = `Could not read the AniList list for "${name}": ${e.message}`;
      useUser(u && u.name === name ? u : { listMap: {}, list: [], taste: null });
    }
  }

  // Same rule as the Mac app: anything already synced follows AniList (so Mac and iPhone agree).
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

  async function refresh({ season, year, force, user } = {}) {
    if (season && year) S.season = { season, year };
    const key = `${S.season.season}-${S.season.year}`;
    const seasons = cache.get('seasons');
    const c = seasons[key];
    S.errors = {};
    const loadSeason = async () => {
      if (c && !force && Date.now() - c.ts < 30 * 60e3) {
        S.raw = c.shows;
        S.updatedAt = c.ts;
        return;
      }
      try {
        const shows = await AL.fetchSeason(S.season.season, S.season.year);
        // Keep at most three seasons cached: phone storage for a web app is small.
        const keep = Object.entries(seasons).sort((a, b) => b[1].ts - a[1].ts).slice(0, 2);
        cache.set('seasons', { ...Object.fromEntries(keep), [key]: { ts: Date.now(), shows } });
        S.raw = shows;
        S.updatedAt = Date.now();
      } catch (e) {
        S.errors.season = `Could not load the season from AniList: ${e.message}`;
        S.raw = c ? c.shows : [];
        S.updatedAt = c ? c.ts : 0;
      }
    };
    await Promise.all([loadSeason(), syncUser(force && user !== false)]);
    syncProgressFromList();
    await loadExtra(force);
    return payload();
  }

  /* ---------- tracking + AniList ---------- */
  async function pushToAniList(id, patch, next) {
    const token = settings.get('token');
    let status = null;
    if (next.status === 'COMPLETED') status = 'COMPLETED';
    else if ('status' in patch) status = { WATCHING: 'CURRENT', PLANNING: 'PLANNING', DROPPED: 'DROPPED', PAUSED: 'PAUSED' }[next.status] || null;
    else if ('progress' in patch && next.progress > 0) status = S.listMap[id]?.status === 'REPEATING' ? null : 'CURRENT';
    const progress = 'progress' in patch ? next.progress : null;
    if (progress == null && !status) return { pushed: false, reason: 'local-only' };
    if (!token) return { pushed: false, reason: 'not-logged-in' };
    try {
      await AL.saveEntry(token, { mediaId: id, progress, status });
      const old = S.listMap[id] || { score: 0, progress: 0 };
      S.listMap[id] = { ...old, status: status || old.status || 'CURRENT', progress: progress ?? old.progress };
      return { pushed: true };
    } catch (e) {
      if (e.status === 401 || /invalid token/i.test(e.message)) {
        settings.patch({ token: '', viewerName: '' });
        return { pushed: false, error: 'Your AniList login expired. Log in again in Settings.' };
      }
      return { pushed: false, error: e.message };
    }
  }

  async function setTrack(id, patch) {
    id = Number(id);
    const items = tracking.get('items');
    const raw = allRaw().find((r) => r.id === id);
    const next = { ...(items[id] || {}) };
    if ('status' in patch) {
      if (patch.status) next.status = patch.status;
      else delete next.status;
    }
    if ('progress' in patch) {
      next.progress = Math.max(0, Math.floor(Number(patch.progress) || 0));
      if (next.progress > 0 && (!next.status || ['PLANNING', 'PAUSED'].includes(next.status))) next.status = 'WATCHING';
    }
    const total = raw?.episodes || S.list.find((e) => e.id === id)?.episodes || null;
    if (total && next.progress != null) {
      if (next.progress >= total) {
        next.progress = total;
        next.status = 'COMPLETED';
      } else if (next.status === 'COMPLETED') next.status = 'WATCHING';
    }
    if (next.status == null && next.progress == null) delete items[id];
    else items[id] = next;
    const push = await pushToAniList(id, patch, next);
    if (items[id]) {
      if (push.pushed) delete items[id].dirty;
      else if (push.reason !== 'local-only') items[id].dirty = true;
    }
    tracking.set('items', items);
    return { me: meFor(id), ...push };
  }

  /* ---------- login: AniList sends us back to this page with #access_token=… ---------- */
  async function finishLoginFromHash() {
    const m = /[#&]access_token=([^&]+)/.exec(location.hash);
    if (!m) return null;
    history.replaceState(null, '', location.pathname + location.search); // keep the token out of the address bar
    return useToken(decodeURIComponent(m[1]));
  }
  async function useToken(token) {
    try {
      const viewer = await AL.fetchViewer(token);
      settings.patch({ token, viewerName: viewer.name });
      if (!String(settings.get('userName') || '').trim()) settings.set('userName', viewer.name);
      cache.set('user', null);
      return `Logged in as ${viewer.name}`;
    } catch (e) {
      return `AniList rejected the login: ${e.message}`;
    }
  }

  /* ---------- calendar: Safari offers "Add to Calendar" for .ics files ---------- */
  function upcoming() {
    const now = Date.now() / 1000;
    return allRaw()
      .filter((r) => r.nextAiringEpisode && ['WATCHING', 'PLANNING'].includes(meFor(r.id).status))
      .map((r) => ({ id: r.id, title: r.title.english || r.title.romaji, ep: r.nextAiringEpisode.episode, at: r.nextAiringEpisode.airingAt, mins: r.duration || 24 }))
      .filter((x) => x.at > now - 3600)
      .sort((a, b) => a.at - b.at);
  }

  function exportCalendar() {
    const items = upcoming();
    if (!items.length) return { ok: false, error: 'Nothing to export yet. Set a show to Watching or Planning first.' };
    const stamp = (t) => new Date(t * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const text = (t) => String(t).replace(/([,;\\])/g, '\\$1');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AniTrack//EN'];
    for (const x of items) {
      lines.push('BEGIN:VEVENT', `UID:anitrack-${x.id}-${x.ep}@anitrack`, `DTSTAMP:${stamp(Date.now() / 1000)}`, `DTSTART:${stamp(x.at)}`, `DTEND:${stamp(x.at + x.mins * 60)}`, `SUMMARY:${text(x.title)} - Episode ${x.ep}`, 'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text(x.title)} episode ${x.ep} is out`, 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    const a = document.createElement('a');
    a.href = `data:text/calendar;charset=utf-8,${encodeURIComponent(`${lines.join('\r\n')}\r\n`)}`;
    a.download = 'anitrack-airing.ics';
    document.body.append(a);
    a.click();
    a.remove();
    return { ok: true, count: items.length };
  }

  /* ---------- the api ---------- */
  let booted = false;
  window.api = {
    platform: 'web',
    async init() {
      const loginMsg = await finishLoginFromHash();
      if (loginMsg) setTimeout(() => emit('toast', loginMsg), 300);
      loadFromCache();
      if (!booted) {
        booted = true;
        setTimeout(() => refresh({ force: !!loginMsg }).then((p) => emit('data', p)).catch(console.error), 30);
        // Coming back to the app after a while: refresh quietly.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && Date.now() - S.updatedAt > 15 * 60e3) refresh({}).then((p) => emit('data', p)).catch(() => {});
        });
      }
      return { ...payload(), loading: S.raw.length === 0 };
    },
    refresh: (opts) => refresh(opts || {}),
    setTrack,
    async saveSettings(patch) {
      const before = String(settings.get('userName') || '').trim();
      const allowed = {};
      if (typeof patch.userName === 'string') allowed.userName = patch.userName.trim();
      if (typeof patch.clientId === 'string') allowed.clientId = patch.clientId.trim();
      settings.patch(allowed);
      if (allowed.userName !== undefined && allowed.userName !== before) {
        cache.set('user', null);
        return refresh({ force: true });
      }
      return payload();
    },
    async login() {
      const clientId = String(settings.get('clientId') || '').trim();
      if (!/^\d+$/.test(clientId)) return { ok: false, error: 'Enter your AniList client ID in Settings first (it is a number).' };
      location.href = `https://anilist.co/api/v2/oauth/authorize?client_id=${clientId}&response_type=token`;
      return new Promise(() => {}); // the page is leaving
    },
    // Fallback when the redirect lands in Safari instead of the Home Screen app: AniList's "pin" page shows the token to copy.
    async loginWithToken(token) {
      const msg = await useToken(String(token || '').trim());
      const ok = !!settings.get('token') && msg.startsWith('Logged');
      return { ok, msg, data: ok ? await refresh({ force: true }) : payload() };
    },
    async logout() {
      settings.patch({ token: '', viewerName: '' });
      return payload();
    },
    async watch(id) {
      id = Number(id);
      const raw = allRaw().find((r) => r.id === id);
      const listed = S.list.find((e) => e.id === id);
      const show = raw ? enrich(raw) : null;
      const title = show ? show.title : listed?.title || '';
      const url = show?.crUrl || `https://www.crunchyroll.com/search?q=${encodeURIComponent(title)}`;
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

  // Hourly refresh while the app stays open.
  setInterval(() => refresh({}).then((p) => emit('data', p)).catch(() => {}), 3600e3);
})();
