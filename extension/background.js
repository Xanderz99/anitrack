'use strict';
// AniTrack for Crunchyroll: marks the episode you are watching on crunchyroll.com as watched on your
// AniList list once you are near the end of it. Talks only to AniList; keeps its login, settings and
// the shows you linked by hand in the browser's extension storage.
if (typeof importScripts === 'function' && !globalThis.AniTrackMatch) importScripts('match.js');
const M = globalThis.AniTrackMatch;

const API = 'https://graphql.anilist.co';
const WEB_URL = 'https://xanderz99.github.io/anitrack/';
const LIST_TTL = 10 * 60e3;
const MIN_LENGTH = 4 * 60; // seconds: shorter videos are previews or ads, never episodes
const DEFAULTS = { auto: true, pct: 0.85 };

const local = chrome.storage.local;
const session = chrome.storage.session || chrome.storage.local; // per-tab state; session storage where the browser has it
const get = async (area, key, d) => (await area.get(key))[key] ?? d;
const set = (area, key, v) => area.set({ [key]: v });

/* ---------- AniList ---------- */
async function gql(query, variables, token) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors?.length) {
    const err = new Error(body.errors?.[0]?.message || `AniList error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body.data;
}

const LIST_Q = `query($id:Int){ MediaListCollection(userId:$id, type:ANIME, status_in:[CURRENT,PLANNING,PAUSED,REPEATING]){
  lists{ entries{ status progress media{ id episodes format title{ english romaji } synonyms coverImage{ medium } } } } } }`;

async function loadList(force) {
  const token = await get(local, 'token');
  const viewer = await get(local, 'viewer');
  if (!token || !viewer) return [];
  const cached = await get(local, 'list');
  if (!force && cached && cached.viewer === viewer.id && Date.now() - cached.ts < LIST_TTL) return cached.entries;
  const data = await gql(LIST_Q, { id: viewer.id }, token);
  const seen = new Set();
  const entries = [];
  for (const l of data.MediaListCollection?.lists || [])
    for (const e of l.entries || []) {
      if (seen.has(e.media.id)) continue; // custom lists repeat entries
      seen.add(e.media.id);
      entries.push({
        mediaId: e.media.id,
        status: e.status,
        progress: e.progress || 0,
        episodes: e.media.episodes || null,
        title: e.media.title.english || e.media.title.romaji,
        cover: e.media.coverImage?.medium || null,
        titles: [e.media.title.english, e.media.title.romaji, ...(e.media.synonyms || [])].filter(Boolean),
      });
    }
  await set(local, 'list', { viewer: viewer.id, ts: Date.now(), entries });
  return entries;
}

async function save({ mediaId, progress, status }) {
  const token = await get(local, 'token');
  const data = await gql(
    'mutation($m:Int,$p:Int,$s:MediaListStatus){ SaveMediaListEntry(mediaId:$m, progress:$p, status:$s){ id status progress } }',
    { m: mediaId, p: progress, s: status },
    token
  );
  // Keep the cached list in step, so the next episode is matched against the new progress.
  const cached = await get(local, 'list');
  const e = cached?.entries.find((x) => x.mediaId === mediaId);
  if (e) {
    e.progress = progress;
    e.status = status;
    await set(local, 'list', cached);
  }
  return data.SaveMediaListEntry;
}

async function useToken(text) {
  const t = String(text || '').trim();
  const m = /access_token=([^&\s]+)/.exec(t);
  const token = m ? decodeURIComponent(m[1]) : t.replace(/\s+/g, '');
  if (!token) return { ok: false, error: 'No login code found.' };
  try {
    const { Viewer } = await gql('query { Viewer { id name } }', {}, token);
    await local.set({ token, viewer: { id: Viewer.id, name: Viewer.name }, linkUntil: 0 });
    await local.remove('list');
    return { ok: true, name: Viewer.name };
  } catch (e) {
    return { ok: false, error: `AniList did not accept that login: ${e.message}` };
  }
}

/* ---------- per tab ---------- */
const tabKey = (tabId) => `tab:${tabId}`;
const tabState = async (tabId) => (await get(session, tabKey(tabId))) || {};
const setTab = (tabId, v) => set(session, tabKey(tabId), v);
chrome.tabs.onRemoved.addListener((tabId) => session.remove(tabKey(tabId)));

async function settings() {
  return { ...DEFAULTS, ...(await get(local, 'settings', {})) };
}

// Finds the show and saves the episode. `manual` comes from the popup's Mark button. One at a time per
// tab: progress updates keep arriving while AniList answers.
const busy = new Set();
async function markTab(tabId, manual) {
  if (busy.has(tabId)) return { ok: false, error: 'busy' };
  busy.add(tabId);
  try {
    return await markTabNow(tabId, manual);
  } finally {
    busy.delete(tabId);
  }
}
async function markTabNow(tabId, manual) {
  const st = await tabState(tabId);
  const info = st.info;
  if (!info || info.partial) return { ok: false, error: 'No episode found on this page.' };
  const id = `${M.linkKey(info)}|${info.episode}`;
  if (st.marked === id && !manual) return { ok: false, error: 'Already marked.' };
  if (!(await get(local, 'token'))) return { ok: false, error: 'Connect your AniList account first.' };
  let entries = await loadList();
  const links = await get(local, 'links', {});
  let pick = M.pickEntry(info, entries, links);
  if (!pick.entry) {
    entries = await loadList(true); // maybe added to the list since the last look
    pick = M.pickEntry(info, entries, links);
  }
  await setTab(tabId, { ...st, marked: id });
  if (!pick.entry) {
    // Most of Netflix is not anime: a show that is not on your list is left alone without a word.
    const quiet = info.site === 'netflix' && !manual && pick.why === 'not on your list';
    if (!quiet) notify(tabId, { text: `Could not tell which show this is (${pick.why}). Pick it in the extension’s menu.` });
    return { ok: false, error: pick.why };
  }
  const ep = info.episode - (pick.offset || 0);
  const next = M.nextSave(pick.entry, ep);
  if (next.skip) {
    if (manual || next.skip !== 'already marked') notify(tabId, { text: `${pick.entry.title}: ${next.skip}.` });
    return { ok: false, error: next.skip };
  }
  const before = { mediaId: pick.entry.mediaId, progress: pick.entry.progress, status: pick.entry.status };
  try {
    await save(next.save);
  } catch (e) {
    if (e.status === 401 || /invalid token|unauthori/i.test(e.message)) {
      await local.remove(['token', 'viewer', 'list']);
      notify(tabId, { text: 'Your AniList login expired. Connect again in the AniTrack extension.' });
    } else {
      await setTab(tabId, { ...st, marked: null }); // try again at the next progress update
      notify(tabId, { text: `Could not update AniList: ${e.message}` });
    }
    return { ok: false, error: e.message };
  }
  chrome.action.setBadgeText({ tabId, text: '✓' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2e7d32' }).catch(() => {});
  const done = next.save.status === 'COMPLETED' ? ' · completed' : '';
  notify(tabId, { text: `Marked episode ${ep} of ${pick.entry.title} on AniList${done}`, undo: before });
  return { ok: true, title: pick.entry.title, ep };
}

function notify(tabId, msg) {
  chrome.tabs.sendMessage(tabId, { type: 'toast', ...msg }, { frameId: 0 }).catch(() => {});
}

/* ---------- messages ---------- */
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, (e) => reply({ ok: false, error: e.message }));
  return true; // reply comes later
});

async function handle(msg, sender) {
  const tabId = sender.tab?.id ?? msg.tabId;
  switch (msg.type) {
    // From crunchyroll.com
    case 'episode': {
      const st = await tabState(tabId);
      if (JSON.stringify(st.info) !== JSON.stringify(msg.info)) {
        await setTab(tabId, { info: msg.info, marked: st.marked });
        chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      }
      return { ok: true };
    }
    case 'progress': {
      const s = await settings();
      if (!s.auto || !(msg.d >= MIN_LENGTH) || msg.t / msg.d < s.pct) return { ok: true };
      return markTab(tabId, false);
    }
    case 'undo': {
      const u = msg.undo;
      await save({ mediaId: u.mediaId, progress: u.progress, status: u.status });
      chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      return { ok: true };
    }
    // From the AniTrack web app, after you pressed Connect in the popup
    case 'link:token': {
      if (!String(sender.url || '').startsWith(WEB_URL)) return { ok: false };
      if (!((await get(local, 'linkUntil', 0)) > Date.now())) return { ok: false, error: 'not asked' };
      return useToken(msg.token);
    }
    case 'link:wanted':
      return { wanted: String(sender.url || '').startsWith(WEB_URL) && (await get(local, 'linkUntil', 0)) > Date.now() };
    // From the popup
    case 'popup:state': {
      const viewer = await get(local, 'viewer');
      const st = msg.tabId != null ? await tabState(msg.tabId) : {};
      let entries = [];
      let error = null;
      try {
        entries = viewer ? await loadList() : [];
      } catch (e) {
        error = e.message;
      }
      const links = await get(local, 'links', {});
      const pick = st.info && !st.info.partial ? M.pickEntry(st.info, entries, links) : null;
      return {
        viewer,
        settings: await settings(),
        info: st.info || null,
        pick: pick && { mediaId: pick.entry?.mediaId || null, offset: pick.offset || 0, why: pick.why },
        entries: entries.map((e) => ({ mediaId: e.mediaId, title: e.title, progress: e.progress, episodes: e.episodes, status: e.status })),
        linked: st.info ? links[M.linkKey(st.info)] || null : null,
        error,
      };
    }
    case 'popup:mark':
      return markTab(msg.tabId, true);
    case 'popup:link': {
      const links = await get(local, 'links', {});
      const key = M.linkKey(msg.info);
      if (msg.mediaId) links[key] = { mediaId: Number(msg.mediaId), offset: Math.max(0, Math.floor(Number(msg.offset) || 0)) };
      else delete links[key];
      await set(local, 'links', links);
      return { ok: true };
    }
    case 'popup:settings':
      await set(local, 'settings', { ...(await settings()), ...msg.settings });
      return { ok: true };
    case 'popup:token':
      return useToken(msg.text);
    case 'popup:connect':
      await set(local, 'linkUntil', Date.now() + 10 * 60e3);
      await chrome.tabs.create({ url: WEB_URL });
      return { ok: true };
    case 'popup:logout':
      await local.remove(['token', 'viewer', 'list', 'linkUntil']);
      return { ok: true };
    default:
      return { ok: false, error: 'unknown message' };
  }
}

// For the tests (Node has no chrome.*).
if (typeof module === 'object' && module.exports) module.exports = { handle, markTab };
