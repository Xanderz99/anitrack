'use strict';
const fs = require('fs');
const path = require('path');
const electron = require('electron');
const { app, BrowserWindow, WebContentsView, Tray, Menu, nativeImage, dialog, ipcMain, shell, Notification, safeStorage, session } = electron;
// Only present in the Widevine-enabled Electron build (castlabs); undefined in stock Electron.
const { components } = electron;

const { Store } = require('./store');
const { powerSaveBlocker } = electron;
const AL = require('./anilist');
const { buildTaste, scoreShow, summarizeTaste, listMapFrom, seasonFor } = require('./taste');
const { makeDubMatcher } = require('./dubs');

let settings;
let tracking;
let cache;
let mainWin = null;
let dubMatch = () => null;

// Everything the UI shows is derived from this.
const S = { raw: [], extra: [], list: [], listMap: {}, taste: null, season: seasonFor(new Date()), updatedAt: 0, errors: {} };
const players = new Map(); // webContents id -> { showId, key, marked }

const allRaw = () => [...S.raw, ...S.extra]; // this season plus shows you watch from earlier seasons
const L2ME = { CURRENT: 'WATCHING', REPEATING: 'WATCHING', PLANNING: 'PLANNING', COMPLETED: 'COMPLETED', PAUSED: 'PAUSED', DROPPED: 'DROPPED' };
const send = (channel, data) => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, data);
};

/* ---------- token (kept encrypted with the macOS Keychain when available) ---------- */
function setToken(token) {
  const v = safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(token).toString('base64')}` : `raw:${token}`;
  settings.set('token', v);
}
function getToken() {
  const v = settings.get('token');
  if (!v) return null;
  try {
    return v.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')) : v.slice(4);
  } catch {
    return null;
  }
}

/* ---------- turning raw AniList data into what the UI needs ---------- */
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
  const title = r.title.english || r.title.romaji;
  const cr = (r.externalLinks || []).find((l) => l.type === 'STREAMING' && /crunchyroll/i.test(l.site));
  const prequels = (r.relations?.edges || [])
    .filter((e) => e.relationType === 'PREQUEL' && e.node.type === 'ANIME')
    .map((e) => e.node.id);
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
    description: String(r.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 260),
    match: match ? match.pct : null,
    why: match ? match.why : [],
    against: match ? match.against : [],
  };
}

function resumeFor(id) {
  const r = tracking.get('resume')[id];
  return r ? { ep: r.ep ?? null, time: r.time, duration: r.duration, done: !!r.done } : null;
}

const baseUrl = (u) => String(u || '').split(/[?#]/)[0];

function payload() {
  return {
    shows: allRaw().map((r) => ({ ...enrich(r), me: meFor(r.id), resume: resumeFor(r.id), offSeason: !S.raw.includes(r) })),
    list: S.list.map((e) => ({ ...e, me: meFor(e.id) })),
    season: S.season,
    updatedAt: S.updatedAt,
    settings: { userName: settings.get('userName'), clientId: settings.get('clientId'), notify: settings.get('notify'), autoMarkPct: settings.get('autoMarkPct') },
    auth: { loggedIn: !!getToken(), name: settings.get('viewerName') || '' },
    taste: S.taste ? summarizeTaste(S.taste) : null,
    errors: S.errors,
    drm: !!components,
  };
}

/* ---------- loading data ---------- */
function loadFromCache() {
  const key = `${S.season.season}-${S.season.year}`;
  const c = cache.get('seasons')[key];
  if (c) {
    S.raw = c.shows;
    S.updatedAt = c.ts;
  }
  const u = cache.get('user');
  if (u && u.name === (settings.get('userName') || '').trim()) {
    S.listMap = u.listMap;
    S.list = u.list || [];
    S.taste = u.taste;
  }
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

function compactList(entries) {
  return entries.map((e) => ({
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
}

async function syncUser(force) {
  const name = (settings.get('userName') || '').trim();
  if (!name) {
    S.listMap = {};
    S.list = [];
    S.taste = null;
    return;
  }
  const u = cache.get('user');
  if (u && u.name === name && !force && Date.now() - u.ts < 6 * 3600e3) {
    S.listMap = u.listMap;
    S.list = u.list || [];
    S.taste = u.taste;
    return;
  }
  try {
    const entries = await AL.fetchUserList(name);
    S.listMap = listMapFrom(entries);
    S.list = compactList(entries);
    S.taste = buildTaste(entries);
    cache.set('user', { name, ts: Date.now(), listMap: S.listMap, list: S.list, taste: S.taste });
  } catch (e) {
    S.errors.user = `Could not read the AniList list for "${name}": ${e.message}`;
    if (u && u.name === name) {
      S.listMap = u.listMap;
      S.list = u.list || [];
      S.taste = u.taste;
    } else {
      S.listMap = {};
      S.list = [];
      S.taste = null;
    }
  }
}

// If you watched further on another device, AniList's number wins over a lower local one.
function syncProgressFromList() {
  const items = tracking.get('items');
  let changed = false;
  for (const [id, it] of Object.entries(items)) {
    const l = S.listMap[id];
    if (!l) continue;
    if (!it.dirty && it.status !== 'SKIP' && L2ME[l.status] && it.status !== L2ME[l.status]) {
      it.status = L2ME[l.status]; // changed on AniList itself (website, phone): the remote value wins
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
      seasons[key] = { ts: Date.now(), shows };
      cache.set('seasons', seasons);
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
  updateTray();
  return payload();
}

/* ---------- tracking + AniList sync ---------- */
async function pushToAniList(id, patch, next, raw) {
  const token = getToken();
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
    return { pushed: false, error: e.message };
  }
}

async function setTrack(id, patch) {
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
    } else if (next.status === 'COMPLETED') {
      next.status = 'WATCHING';
    }
  }
  if (next.status == null && next.progress == null) delete items[id];
  else items[id] = next;
  tracking.set('items', items);
  const push = await pushToAniList(id, patch, next, raw);
  if (push.pushed) delete items[id]?.dirty;
  else if (push.reason !== 'local-only' && items[id] && ('progress' in patch || (patch.status && patch.status !== 'SKIP'))) items[id].dirty = true;
  tracking.set('items', items);
  return { me: meFor(id), ...push };
}

/* ---------- AniList login (implicit grant in a small window) ---------- */
function loginAniList() {
  const clientId = String(settings.get('clientId') || '').trim();
  if (!/^\d+$/.test(clientId)) {
    return Promise.resolve({ ok: false, error: 'Enter your AniList client ID in Settings first (it is a number).' });
  }
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 520,
      height: 720,
      parent: mainWin || undefined,
      modal: !!mainWin,
      title: 'Log in to AniList',
      webPreferences: { partition: 'persist:anilist' },
    });
    let done = false;
    const urlOf = (d, u) => (d && d.url) || u || '';
    const finish = async (url) => {
      if (done) return;
      const m = /[#?&]access_token=([^&]+)/.exec(url || '');
      if (!m) return;
      done = true;
      const token = decodeURIComponent(m[1]);
      setImmediate(() => !win.isDestroyed() && win.destroy());
      try {
        const viewer = await AL.fetchViewer(token);
        setToken(token);
        settings.set('viewerName', viewer.name);
        if (!String(settings.get('userName') || '').trim()) settings.set('userName', viewer.name);
        resolve({ ok: true, name: viewer.name });
      } catch (e) {
        resolve({ ok: false, error: `AniList rejected the login: ${e.message}` });
      }
    };
    const wc = win.webContents;
    wc.on('will-redirect', (d, u) => {
      const url = urlOf(d, u);
      if (/access_token=/.test(url)) {
        d.preventDefault?.();
        finish(url);
      }
    });
    wc.on('will-navigate', (d, u) => {
      const url = urlOf(d, u);
      if (/access_token=/.test(url)) {
        d.preventDefault?.();
        finish(url);
      }
    });
    wc.on('did-navigate', (d, u) => finish(urlOf(d, u)));
    wc.on('did-redirect-navigation', (d, u) => finish(urlOf(d, u)));
    wc.on('did-fail-load', (d, _code, _desc, u) => finish((d && d.validatedURL) || u));
    win.on('closed', () => {
      if (!done) {
        done = true;
        resolve({ ok: false, error: 'The login window was closed before finishing.' });
      }
    });
    win.loadURL(`https://anilist.co/api/v2/oauth/authorize?client_id=${clientId}&response_type=token`);
  });
}

/* ---------- Crunchyroll, embedded in the main window ---------- */
const SIDEBAR_W = 200;
const BAR_H = 54;
let playerView = null; // WebContentsView sitting over the content area
let playerFull = false;
let blockerId = null;

function cleanUserAgent() {
  return app.userAgentFallback.replace(/\s*Electron\/\S+/, '').replace(new RegExp(`\\s*${app.getName()}/\\S+`, 'i'), '');
}

function parseEpisode(title) {
  const m = /\bE(\d{1,3})\b/.exec(title) || /\b(?:Episode|Ep\.?)\s*(\d{1,3})\b/i.exec(title);
  return m ? Number(m[1]) : null;
}

function layoutPlayer() {
  if (!playerView || !mainWin || mainWin.isDestroyed()) return;
  const [w, h] = mainWin.getContentSize();
  playerView.setBounds(
    playerFull ? { x: 0, y: 0, width: w, height: h } : { x: SIDEBAR_W, y: BAR_H, width: Math.max(0, w - SIDEBAR_W), height: Math.max(0, h - BAR_H) }
  );
}

function closePlayer() {
  if (!playerView) return;
  const view = playerView;
  playerView = null;
  if (playerFull && mainWin && !mainWin.isDestroyed()) mainWin.setFullScreen(false);
  playerFull = false;
  if (blockerId != null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
  players.delete(view.webContents.id);
  try {
    mainWin?.contentView.removeChildView(view);
  } catch {
    /* window already gone */
  }
  try {
    view.webContents.close({ waitForBeforeUnload: false });
  } catch {
    /* already closed */
  }
  send('player', null);
  send('data', payload()); // refreshes the Resume label
}

async function openPlayer(id) {
  if (!mainWin || mainWin.isDestroyed()) return { ok: false, error: 'The main window is not open.' };
  let raw = allRaw().find((r) => r.id === id);
  if (!raw) {
    // A show from your list that is not in the loaded season: look it up on demand.
    try {
      [raw] = await AL.fetchByIds([id]);
    } catch (e) {
      return { ok: false, error: `Could not look that show up on AniList: ${e.message}` };
    }
    if (!raw) return { ok: false, error: 'Could not find that show on AniList.' };
    S.extra.push(raw);
  }
  const show = enrich(raw);
  let url = show.crUrl || `https://www.crunchyroll.com/search?q=${encodeURIComponent(show.title)}`;
  const ctx = { showId: id, key: null, marked: false, lastSave: 0, consumed: false, resumeUrl: null, resumeTime: 0 };
  const saved = tracking.get('resume')[id];
  if (saved && !saved.done && /^https:\/\/([\w-]+\.)*crunchyroll\.com\//.test(saved.url || '')) {
    url = saved.url; // pick up the episode you were in the middle of
    ctx.resumeUrl = saved.url;
    ctx.resumeTime = saved.time;
  }
  if (playerView) closePlayer();
  const ses = session.fromPartition('persist:crunchyroll');
  ses.setUserAgent(cleanUserAgent());
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(['fullscreen', 'clipboard-sanitized-write'].includes(permission)));
  playerView = new WebContentsView({
    webPreferences: {
      partition: 'persist:crunchyroll',
      preload: path.join(__dirname, 'player-preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegrationInSubFrames: true,
    },
  });
  playerView.setBackgroundColor('#000000');
  const wc = playerView.webContents;
  players.set(wc.id, ctx);
  mainWin.contentView.addChildView(playerView);
  layoutPlayer();
  wc.setWindowOpenHandler(({ url: target }) => {
    if (/^https:\/\/([\w-]+\.)*crunchyroll\.com\//.test(target)) {
      wc.loadURL(target); // stay inside the app instead of spawning windows
    } else if (/^https:\/\//.test(target)) {
      shell.openExternal(target);
    }
    return { action: 'deny' };
  });
  wc.on('enter-html-full-screen', () => {
    playerFull = true;
    if (!mainWin.isFullScreen()) mainWin.setFullScreen(true);
    layoutPlayer();
  });
  wc.on('leave-html-full-screen', () => {
    playerFull = false;
    if (mainWin.isFullScreen()) mainWin.setFullScreen(false);
    layoutPlayer();
  });
  if (blockerId == null) blockerId = powerSaveBlocker.start('prevent-display-sleep'); // screen stays on while watching
  wc.loadURL(url);
  send('player', { id, title: show.title });
  return { ok: true, drm: !!components };
}

ipcMain.on('player:tick', async (event, p) => {
  const ctx = players.get(event.sender.id);
  if (!ctx || !p || !(p.duration > 120)) return; // ignore ads and short clips
  const top = event.sender.getURL();
  if (!/\/watch\//.test(top)) return;
  if (ctx.key !== top) {
    ctx.key = top;
    ctx.marked = false;
  }
  const pct = Number(settings.get('autoMarkPct')) || 0.9;
  const nowMs = Date.now();
  if (nowMs - ctx.lastSave > 15000) {
    ctx.lastSave = nowMs;
    const resume = tracking.get('resume');
    resume[ctx.showId] = {
      url: top,
      time: Math.floor(p.currentTime),
      duration: Math.floor(p.duration),
      ep: parseEpisode(event.sender.getTitle()),
      done: p.currentTime / p.duration >= pct, // counted as watched: next time start fresh
      ts: nowMs,
    };
    tracking.set('resume', resume);
  }
  if (ctx.marked || p.currentTime / p.duration < pct) return;
  ctx.marked = true;
  {
    const resume = tracking.get('resume');
    if (resume[ctx.showId]) {
      resume[ctx.showId].done = true;
      tracking.set('resume', resume);
    }
  }
  const raw = allRaw().find((r) => r.id === ctx.showId);
  const title = raw ? raw.title.english || raw.title.romaji : 'this show';
  const progress = meFor(ctx.showId).progress;
  const parsed = parseEpisode(event.sender.getTitle());
  const ep = parsed ?? progress + 1;
  if (ep <= progress) return; // rewatching something already counted
  const result = await setTrack(ctx.showId, { progress: ep, ...(meFor(ctx.showId).status ? {} : { status: 'WATCHING' }) });
  const synced = result.pushed ? 'and synced to AniList' : result.error ? `(AniList: ${result.error})` : '(saved locally, log in to sync)';
  send('toast', `${title}: episode ${ep} marked watched ${synced}`);
  send('data', payload());
  if (Notification.isSupported()) new Notification({ title: 'Episode marked watched', body: `${title} · episode ${ep} ${synced}`, silent: true }).show();
});

// The player asks once per page load where it should start. Crunchyroll usually resumes by itself;
// this only seeks forward when our saved position is further along than where the player landed.
ipcMain.handle('player:resume-time', (event) => {
  const ctx = players.get(event.sender.id);
  if (!ctx || ctx.consumed || !ctx.resumeTime) return null;
  if (baseUrl(event.sender.getURL()) !== baseUrl(ctx.resumeUrl)) return null;
  ctx.consumed = true;
  return ctx.resumeTime;
});

/* ---------- menu bar countdown + calendar export ---------- */
let tray = null;

function upcoming() {
  const now = Date.now() / 1000;
  return allRaw()
    .filter((r) => r.nextAiringEpisode && ['WATCHING', 'PLANNING'].includes(meFor(r.id).status))
    .map((r) => ({ id: r.id, title: r.title.english || r.title.romaji, ep: r.nextAiringEpisode.episode, at: r.nextAiringEpisode.airingAt, mins: r.duration || 24 }))
    .filter((x) => x.at > now - 3600)
    .sort((a, b) => a.at - b.at);
}

const shortText = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
function until(at) {
  const s = Math.max(0, at - Date.now() / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) createMainWindow();
  else {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  }
}

function updateTray() {
  if (!tray) return;
  const up = upcoming();
  if (process.platform === 'darwin') tray.setTitle(up.length ? `${shortText(up[0].title, 18)} ${until(up[0].at)}` : 'AniTrack');
  const items = up.slice(0, 6).map((x) => ({ label: `${shortText(x.title, 34)} · ep ${x.ep} · ${until(x.at)}`, click: showMain }));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(items.length ? items : [{ label: 'No tracked episodes coming up', enabled: false }]),
      { type: 'separator' },
      { label: 'Open AniTrack', click: showMain },
      { label: 'Quit', role: 'quit' },
    ])
  );
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createEmpty()); // text-only item in the macOS menu bar
    tray.setToolTip('AniTrack');
    tray.on('click', showMain);
    updateTray();
  } catch (e) {
    console.warn('Menu bar item unavailable:', e.message);
    tray = null;
  }
}

async function exportCalendar() {
  const items = upcoming();
  if (!items.length) return { ok: false, error: 'Nothing to export yet. Set a show to Watching or Planning first.' };
  const res = await dialog.showSaveDialog(mainWin, {
    title: 'Save airing calendar',
    defaultPath: path.join(app.getPath('downloads'), 'anitrack-airing.ics'),
    filters: [{ name: 'Calendar', extensions: ['ics'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  const stamp = (t) => new Date(t * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const text = (t) => String(t).replace(/([,;\\])/g, '\\$1');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AniTrack//EN'];
  for (const x of items) {
    lines.push('BEGIN:VEVENT', `UID:anitrack-${x.id}-${x.ep}@anitrack`, `DTSTAMP:${stamp(Date.now() / 1000)}`, `DTSTART:${stamp(x.at)}`, `DTEND:${stamp(x.at + x.mins * 60)}`, `SUMMARY:${text(x.title)} - Episode ${x.ep}`, 'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text(x.title)} episode ${x.ep} is out`, 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  fs.writeFileSync(res.filePath, `${lines.join('\r\n')}\r\n`);
  return { ok: true, count: items.length };
}

/* ---------- air-time notifications ---------- */
function checkAirings() {
  if (!settings.get('notify')) return;
  const notified = tracking.get('notified') || {};
  const now = Date.now();
  let changed = false;
  let needRefresh = false;
  for (const r of allRaw()) {
    const n = r.nextAiringEpisode;
    if (!n || n.airingAt * 1000 > now) continue;
    if (!['WATCHING', 'PLANNING'].includes(meFor(r.id).status)) continue;
    const key = `${r.id}:${n.episode}`;
    if (notified[key]) continue;
    notified[key] = now;
    changed = true;
    needRefresh = true;
    if (now - n.airingAt * 1000 < 6 * 3600e3 && Notification.isSupported()) {
      const e = enrich(r);
      const note = new Notification({
        title: `${e.title}: episode ${n.episode} is out`,
        body: e.dub === 'announced' ? 'Subtitled episode is live on Crunchyroll. The English dub usually follows later.' : 'Live on Crunchyroll.',
      });
      note.on('click', () => {
        showMain();
        openPlayer(r.id);
      });
      note.show();
    }
  }
  if (changed) {
    for (const [k, t] of Object.entries(notified)) if (now - t > 30 * 86400e3) delete notified[k];
    tracking.set('notified', notified);
  }
  if (needRefresh) refresh({ force: true, user: false }).then((p) => send('data', p)).catch(() => {});
}

/* ---------- IPC ---------- */
function registerIpc() {
  ipcMain.handle('app:init', () => {
    loadFromCache();
    setTimeout(() => refresh({}).then((p) => send('data', p)).catch(console.error), 50);
    return { ...payload(), loading: S.raw.length === 0 };
  });
  ipcMain.handle('app:refresh', (_e, opts) => refresh(opts || {}));
  ipcMain.handle('track:set', (_e, id, patch) => setTrack(Number(id), patch || {}));
  ipcMain.handle('settings:save', async (_e, patch) => {
    const before = String(settings.get('userName') || '').trim();
    const allowed = {};
    if (typeof patch.userName === 'string') allowed.userName = patch.userName.trim();
    if (typeof patch.clientId === 'string') allowed.clientId = patch.clientId.trim();
    if (typeof patch.notify === 'boolean') allowed.notify = patch.notify;
    if ([0.8, 0.9, 0.95].includes(Number(patch.autoMarkPct))) allowed.autoMarkPct = Number(patch.autoMarkPct);
    settings.patch(allowed);
    if (allowed.userName !== undefined && allowed.userName !== before) {
      cache.set('user', null);
      return refresh({ force: true });
    }
    return payload();
  });
  ipcMain.handle('anilist:login', async () => {
    const result = await loginAniList();
    if (result.ok) {
      cache.set('user', null);
      return { ...result, data: await refresh({ force: true }) };
    }
    return result;
  });
  ipcMain.handle('anilist:logout', () => {
    settings.patch({ token: '', viewerName: '' });
    return payload();
  });
  ipcMain.handle('watch:open', (_e, id) => openPlayer(Number(id)));
  ipcMain.handle('player:close', () => closePlayer());
  ipcMain.handle('calendar:export', () => exportCalendar());
  ipcMain.handle('player:external', () => {
    if (playerView) {
      const u = playerView.webContents.getURL();
      if (/^https:\/\//.test(u)) shell.openExternal(u);
    }
  });
  ipcMain.handle('open:external', (_e, url) => {
    if (/^https:\/\//.test(String(url))) shell.openExternal(url);
  });
}

function createMainWindow() {
  const b = settings.get('bounds') || {};
  mainWin = new BrowserWindow({
    width: b.width >= 880 ? b.width : 1240,
    height: b.height >= 560 ? b.height : 820,
    ...(Number.isFinite(b.x) && Number.isFinite(b.y) ? { x: b.x, y: b.y } : {}),
    minWidth: 880,
    minHeight: 560,
    title: 'AniTrack',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  mainWin.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      if (/^https:\/\//.test(url)) shell.openExternal(url);
    }
  });
  mainWin.on('resize', layoutPlayer);
  mainWin.on('enter-full-screen', layoutPlayer);
  mainWin.on('leave-full-screen', layoutPlayer);
  mainWin.on('close', () => {
    if (!mainWin.isFullScreen() && !mainWin.isMinimized()) settings.set('bounds', mainWin.getBounds());
  });
  mainWin.on('closed', () => {
    if (playerView) players.delete(playerView.webContents.id);
    playerView = null;
    mainWin = null;
  });
}

app.whenReady().then(async () => {
  if (components && components.whenReady) {
    try {
      await components.whenReady(); // downloads/installs the Widevine CDM on first run
    } catch (e) {
      console.warn('Widevine component is not ready:', e && e.message);
    }
  }
  const dir = app.getPath('userData');
  settings = new Store(dir, 'settings', { userName: 'Xanderz99', clientId: '', token: '', viewerName: '', notify: true, autoMarkPct: 0.9 });
  tracking = new Store(dir, 'tracking', { items: {}, notified: {}, resume: {} });
  cache = new Store(dir, 'cache', { seasons: {}, user: null, extra: null });
  dubMatch = makeDubMatcher(path.join(dir, 'dubs.json'));
  registerIpc();
  createMainWindow();
  createTray();
  setInterval(updateTray, 30e3);
  setInterval(checkAirings, 60e3);
  setInterval(() => refresh({}).then((p) => send('data', p)).catch(() => {}), 3600e3);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
