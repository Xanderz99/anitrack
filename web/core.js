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

  const listeners = { data: [], toast: [], player: [] };
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
  // Returns a message for the UI, or { confirm } when the token arrived without this app asking for it
  // (a link someone else made could otherwise log you into their account).
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
      return { confirm: viewer.name, token };
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
      if (loginMsg && loginMsg.confirm) {
        const { confirm, token } = loginMsg;
        loginMsg = null;
        setTimeout(() => emit('toast', { msg: `Log in to AniTrack as ${confirm}?`, action: { label: 'Log in', fn: () => api.loginWithToken(token).then((r) => (emit('data', r.data), emit('toast', r.msg), setTimeout(guestOffer, 2500))) } }), 300);
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
      try {
        localStorage.setItem(PENDING_LOGIN, String(Date.now()));
      } catch {
        /* the confirm prompt covers this */
      }
      location.href = `https://anilist.co/api/v2/oauth/authorize?client_id=${id}&response_type=token`;
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

  window.api = api;

  // Hourly refresh while the app stays open.
  setInterval(() => refresh({}).then((p) => emit('data', p)).catch(() => {}), 3600e3);
})();
