'use strict';
// Browser version of the Mac app's main process (src/main.js). It runs inside the page and exposes
// the same window.api the Mac renderer uses, so renderer/app.js works unchanged on the iPhone.
(() => {
  const AL = require('./anilist');
  const { createCore, buildIcs } = require('./core');
  const { makeDubMatcher } = require('./dubs');

  /* ---------- storage (localStorage, one key per store) ---------- */
  class Store {
    constructor(name, defaults) {
      this.key = `anitrack:${name}`;
      this.data = JSON.parse(JSON.stringify(defaults)); // deep copy: callers mutate nested objects in place
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
  const getToken = () => settings.get('token') || null;
  const clearToken = () => settings.patch({ token: '', viewerName: '' });
  const core = createCore({ AL, settings, tracking, cache, dubMatch: makeDubMatcher(null), getToken, clearToken });

  const listeners = { data: [], toast: [], player: [] };
  const emit = (ch, d) => (listeners[ch] || []).forEach((cb) => cb(d));
  const redirectUrl = () => location.origin + location.pathname;

  function payload() {
    return {
      ...core.basePayload(),
      platform: 'web',
      redirectUrl: redirectUrl(),
      settings: { userName: settings.get('userName'), clientId: settings.get('clientId') },
      auth: { loggedIn: !!getToken(), name: settings.get('viewerName') || '' },
      drm: false,
    };
  }

  async function refresh(opts) {
    await core.refresh(opts || {});
    return payload();
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
  window.api = {
    platform: 'web',
    async init() {
      const loginMsg = await finishLoginFromHash();
      if (loginMsg) setTimeout(() => emit('toast', loginMsg), 300);
      core.loadFromCache();
      if (!booted) {
        booted = true;
        setTimeout(() => refresh({ force: !!loginMsg }).then((p) => emit('data', p)).catch(console.error), 30);
        // Coming back to the app after a while: refresh quietly.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && Date.now() - core.S.updatedAt > 15 * 60e3) refresh({}).then((p) => emit('data', p)).catch(() => {});
        });
      }
      return { ...payload(), loading: core.S.raw.length === 0 };
    },
    refresh,
    setTrack: core.setTrack,
    async saveSettings(patch) {
      const before = String(settings.get('userName') || '').trim();
      const allowed = {};
      if (typeof patch.userName === 'string') allowed.userName = patch.userName.trim();
      if (typeof patch.clientId === 'string') allowed.clientId = patch.clientId.trim();
      settings.patch(allowed);
      if (allowed.userName !== undefined && allowed.userName !== before) {
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
      const ok = !!getToken() && msg.startsWith('Logged');
      return { ok, msg, data: ok ? await refresh({ force: true }) : payload() };
    },
    async logout() {
      clearToken();
      return payload();
    },
    async watch(id) {
      id = Number(id);
      const raw = core.findRaw(id);
      const listed = core.S.list.find((e) => e.id === id);
      const show = raw ? core.enrich(raw) : null;
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
