'use strict';
// Crunchyroll watch history -> AniList. Reads the history list crunchyroll.com itself shows, signed in
// with the Crunchyroll login of AniTrack's own Crunchyroll window, so episodes watched anywhere (the
// iPhone app, a TV, the website) reach your AniList list. Nothing is changed on Crunchyroll.
//
// The endpoints are Crunchyroll's own, not a public API (the same ones tolosa/anime-watch-sync,
// ruflas/crunchyexporter-cli and crunchy-labs/crunchyroll-rs use), so they can change without notice.
// Requests go through the Mac app's Chromium network stack with that window's cookies, so to
// Crunchyroll they look like its own website.
const M = require('../extension/match');

const BASE = 'https://www.crunchyroll.com';
const API_HOST = 'https://beta-api.crunchyroll.com';
// The public client id of Crunchyroll's web player (no secret), used when the site's own one has not
// been seen yet. Overridden by the Authorization header the website sends, when AniTrack sees it.
const WEB_CLIENT = `Basic ${Buffer.from('noaihdevm_6iyg0a8l0q:').toString('base64')}`;
const FIRST_LOOKBACK = 14 * 86400e3; // the first sync only looks at the last two weeks
const OVERLAP = 3600e3; // later syncs look an hour further back than the newest episode seen
const MAX_PAGES = 10;

class CrError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // 'signed-out' | 'challenge' | 'http' | 'shape'
  }
}

/* ---------- reading history items (pure) ---------- */
// One history entry -> { series, season, episode, at, watched } or null for things that are not episodes.
function parseItem(item, threshold) {
  const panel = item?.panel;
  const meta = panel?.episode_metadata;
  if (!meta || !meta.series_title) return null;
  const episode = Number(meta.episode_number);
  if (!Number.isInteger(episode) || episode < 1) return null; // specials, recaps (12.5) and movies
  const duration = Number(meta.duration_ms) || Number(panel.duration_ms) || 0;
  const playhead = Number(item.playhead) || 0;
  const watched = item.fully_watched === true || (duration > 0 && (playhead * 1000) / duration >= threshold);
  const at = Date.parse(item.date_played || '') || 0;
  return { series: String(meta.series_title).trim(), season: Number(meta.season_number) || null, episode, at, watched, seriesId: meta.series_id || null };
}

// What to mark: the furthest watched episode of each Crunchyroll season since `since`, matched to an
// entry on your list. `entries` and `links` are as in extension/match.js; a link of { ignore: true }
// leaves a season alone. Returns { marks: [{ mediaId, title, ep, from }], unmatched: [{ key, series, season, episode }], newest }.
function plan(items, entries, links, { threshold = 0.9, since = 0 } = {}) {
  const groups = new Map();
  let newest = 0;
  for (const raw of items) {
    const h = parseItem(raw, threshold);
    if (!h) continue;
    newest = Math.max(newest, h.at);
    if (!h.watched || h.at < since) continue;
    const key = M.linkKey(h);
    const g = groups.get(key);
    if (!g || h.episode > g.episode) groups.set(key, h);
  }
  const marks = [];
  const unmatched = [];
  for (const [key, h] of groups) {
    if (links[key]?.ignore) continue;
    const pick = M.pickEntry(h, entries, links);
    if (!pick.entry) {
      unmatched.push({ key, series: h.series, season: h.season, episode: h.episode, why: pick.why });
      continue;
    }
    const ep = h.episode - (pick.offset || 0);
    const next = M.nextSave(pick.entry, ep);
    if (next.save) marks.push({ mediaId: pick.entry.mediaId, title: pick.entry.title, ep, from: pick.entry.progress, key });
  }
  return { marks, unmatched, newest };
}

/* ---------- talking to Crunchyroll ---------- */
// `fetch` is the Crunchyroll window's session fetch (cookies included); `state` keeps the device id
// between runs: { get(), patch(obj) }.
function createCrClient({ fetch, state, now = Date.now, base = BASE }) {
  let token = null; // { access, accountId, expires }

  async function call(url, init) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new CrError(`Could not reach Crunchyroll: ${e.message}`, 'http');
    }
    if (res.headers?.get?.('cf-mitigated') === 'challenge') throw new CrError('Crunchyroll asked for a browser check.', 'challenge');
    return res;
  }

  // Crunchyroll serves the same API on its API host and on the website; the API host first, as in
  // ruflas/crunchyexporter-cli. A test (or a custom `base`) uses only that one.
  const hosts = base === BASE ? [API_HOST, BASE] : [base];
  // Crunchyroll's reply, short, for the Status line: "401 invalid_grant".
  const why = async (res) => {
    const b = await res.json().catch(() => null);
    const code = b?.error || b?.code || b?.message || '';
    return `${res.status}${code ? ` ${String(code).slice(0, 60)}` : ''}`;
  };

  async function signInAt(host, deviceId) {
    // The same request ruflas/crunchyexporter-cli makes: the web player's client and a desktop device.
    const body = new URLSearchParams({ grant_type: 'etp_rt_cookie', scope: 'offline_access', device_id: deviceId, device_name: 'Chrome on Windows', device_type: 'com.crunchyroll.desktop.windows' });
    const res = await call(`${host}/auth/v1/token`, {
      method: 'POST',
      headers: { Authorization: WEB_CLIENT, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
    if (!res.ok) return { error: await why(res), status: res.status };
    const data = await res.json().catch(() => null);
    if (!data?.access_token) return { error: `${res.status} no token in the reply`, status: res.status };
    let accountId = data.account_id;
    if (!accountId) {
      const me = await call(`${host}/accounts/v1/me`, { headers: { Authorization: `Bearer ${data.access_token}`, Accept: 'application/json' } });
      accountId = me.ok ? (await me.json().catch(() => null))?.account_id : null;
      if (!accountId) return { error: `account ${me.status}`, status: me.status };
    }
    return { token: { host, access: data.access_token, accountId, expires: now() + (Number(data.expires_in) || 300) * 1000 - 60e3 } };
  }

  async function signIn() {
    let deviceId = (state.get() || {}).deviceId;
    if (!deviceId) {
      deviceId = require('crypto').randomUUID();
      state.patch({ deviceId });
    }
    const tries = [];
    for (const host of hosts) {
      const r = await signInAt(host, deviceId);
      if (r.token) return (token = r.token);
      tries.push({ host, ...r });
    }
    const detail = tries.map((t) => `${new URL(t.host).hostname}: ${t.error}`).join('; ');
    const refused = tries.every((t) => t.status === 400 || t.status === 401);
    throw new CrError(refused ? `Crunchyroll refused AniTrack's sign-in (${detail}).` : `Crunchyroll sign-in failed (${detail}).`, refused ? 'signed-out' : tries.some((t) => t.status === 403) ? 'challenge' : 'http');
  }

  // Newest first, stopping once entries are older than `since`.
  async function history(since) {
    const items = [];
    if (!token || token.expires < now()) await signIn();
    const host = token.host;
    let url = `${host}/content/v2/${encodeURIComponent(token.accountId)}/watch-history?page_size=100&locale=en-US`;
    for (let page = 0; url && page < MAX_PAGES; page += 1) {
      let res = await call(url, { headers: { Authorization: `Bearer ${token.access}`, Accept: 'application/json' } });
      if (res.status === 401) {
        await signIn(); // expired: once
        res = await call(url, { headers: { Authorization: `Bearer ${token.access}`, Accept: 'application/json' } });
      }
      if (!res.ok) throw new CrError(`Crunchyroll history failed (${await why(res)}).`, res.status === 401 ? 'signed-out' : 'http');
      const body = await res.json().catch(() => null);
      if (!Array.isArray(body?.data)) throw new CrError('Crunchyroll answered the history request in an unexpected way.', 'shape');
      items.push(...body.data);
      const oldest = Math.min(...body.data.map((x) => Date.parse(x.date_played || '') || Infinity));
      const next = body.meta?.next_page;
      if (!body.data.length || !next || oldest < since) break;
      url = /^https?:\/\//.test(next) ? next : `${host}${next.startsWith('/') ? '' : '/'}${next}`;
      if (!url.startsWith(`${host}/`)) break; // never send the token anywhere else
    }
    return items;
  }

  return { history, signIn };
}

// One sync: reads history since the last one and returns the plan (the caller saves the marks).
async function syncOnce({ client, state, entries, threshold, now = Date.now }) {
  const st = state.get() || {};
  const since = st.newest ? st.newest - OVERLAP : now() - FIRST_LOOKBACK;
  const items = await client.history(since);
  const result = plan(items, entries, st.links || {}, { threshold, since });
  return { ...result, since };
}

module.exports = { parseItem, plan, createCrClient, syncOnce, CrError, WEB_CLIENT, FIRST_LOOKBACK, OVERLAP };
