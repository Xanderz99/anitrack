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
const { createCore, buildIcs } = require('./core');
const config = require('./config');
const { makeDubMatcher } = require('./dubs');

let settings;
let tracking;
let cache;
let core; // shared data + sync engine (src/core.js), created once the stores exist
let mainWin = null;

const players = new Map(); // webContents id -> { showId, key, marked }
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
    clearToken(); // the Keychain can no longer read it (new Mac, restored backup): log in again
    return null;
  }
}
// Also forgets the AniList website session in the login window, so the next login can be someone else.
function clearToken() {
  settings.patch({ token: '', viewerName: '', viewerId: null, viewerAvatar: '' });
  session.fromPartition('persist:anilist').clearStorageData().catch(() => {});
}
// Your own client (Settings > Advanced) wins over the one built into the app.
const clientId = () => String(settings.get('clientId') || '').trim() || String(config.anilistClientId || '');

/* ---------- what the UI gets ---------- */
function resumeFor(id) {
  const r = core.tracking.get('resume')[id];
  return r ? { ep: r.ep ?? null, time: r.time, duration: r.duration, done: !!r.done } : null;
}

const baseUrl = (u) => String(u || '').split(/[?#]/)[0];

function payload() {
  return {
    ...core.basePayload({ resumeFor }),
    settings: { userName: settings.get('userName'), clientId: settings.get('clientId'), notify: settings.get('notify'), autoMarkPct: settings.get('autoMarkPct') },
    auth: { loggedIn: !!getToken(), name: settings.get('viewerName') || '', avatar: settings.get('viewerAvatar') || '', canLogin: /^\d+$/.test(clientId()), builtInClient: !!config.anilistClientId },
    firstRun: !getToken() && !String(settings.get('userName') || '').trim() && !settings.get('welcomed'),
    drm: !!components,
  };
}

async function refresh(opts) {
  await core.refresh(opts);
  updateTray();
  return payload();
}

/* ---------- AniList login (implicit grant in a small window) ---------- */
function loginAniList() {
  const id = clientId();
  if (!/^\d+$/.test(id)) {
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
        core.setViewer(viewer);
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
    win.loadURL(`https://anilist.co/api/v2/oauth/authorize?client_id=${id}&response_type=token`);
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
  let raw = core.findRaw(id);
  if (!raw) {
    // A show from your list that is not in the loaded season: look it up on demand.
    try {
      [raw] = await AL.fetchByIds([id]);
    } catch (e) {
      return { ok: false, error: `Could not look that show up on AniList: ${e.message}` };
    }
    if (!raw) return { ok: false, error: 'Could not find that show on AniList.' };
    core.S.extra.push(raw);
  }
  const show = core.enrich(raw);
  // Not on Crunchyroll but on another service: that opens in the browser (only Crunchyroll plays in the app).
  if (!show.crUrl && show.streams[0]) {
    shell.openExternal(show.streams[0].url);
    return { ok: true, external: true, drm: true };
  }
  let url = show.crUrl || `https://www.crunchyroll.com/search?q=${encodeURIComponent(show.title)}`;
  const ctx = { showId: id, key: null, marked: false, lastSave: 0, consumed: false, resumeUrl: null, resumeTime: 0 };
  const saved = core.tracking.get('resume')[id];
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
    const resume = core.tracking.get('resume');
    resume[ctx.showId] = {
      url: top,
      time: Math.floor(p.currentTime),
      duration: Math.floor(p.duration),
      ep: parseEpisode(event.sender.getTitle()),
      done: p.currentTime / p.duration >= pct, // counted as watched: next time start fresh
      ts: nowMs,
    };
    core.tracking.set('resume', resume);
  }
  if (ctx.marked || p.currentTime / p.duration < pct) return;
  ctx.marked = true;
  {
    const resume = core.tracking.get('resume');
    if (resume[ctx.showId]) {
      resume[ctx.showId].done = true;
      core.tracking.set('resume', resume);
    }
  }
  const raw = core.findRaw(ctx.showId);
  const title = raw ? raw.title.english || raw.title.romaji : 'this show';
  const progress = core.meFor(ctx.showId).progress;
  const parsed = parseEpisode(event.sender.getTitle());
  const ep = parsed ?? progress + 1;
  if (ep <= progress) return; // rewatching something already counted
  const result = await core.setTrack(ctx.showId, { progress: ep, ...(core.meFor(ctx.showId).status ? {} : { status: 'WATCHING' }) });
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

const upcoming = () => core.upcoming();

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
  fs.writeFileSync(res.filePath, buildIcs(items));
  return { ok: true, count: items.length };
}

/* ---------- air-time notifications ---------- */
function checkAirings() {
  if (!settings.get('notify')) return;
  const notified = tracking.get('notified') || {};
  const now = Date.now();
  let changed = false;
  let needRefresh = false;
  for (const r of core.allRaw()) {
    const n = r.nextAiringEpisode;
    if (!n || n.airingAt * 1000 > now) continue;
    if (!['WATCHING', 'PLANNING'].includes(core.meFor(r.id).status)) continue;
    const key = `${r.id}:${n.episode}`;
    if (notified[key]) continue;
    notified[key] = now;
    changed = true;
    needRefresh = true;
    if (now - n.airingAt * 1000 < 6 * 3600e3 && Notification.isSupported()) {
      const e = core.enrich(r);
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
    core.loadFromCache();
    setTimeout(() => refresh({}).then((p) => send('data', p)).catch(console.error), 50);
    return { ...payload(), loading: core.S.raw.length === 0 };
  });
  ipcMain.handle('app:refresh', (_e, opts) => refresh(opts || {}));
  ipcMain.handle('track:set', (_e, id, patch) => core.setTrack(Number(id), patch || {}));
  ipcMain.handle('track:rate', (_e, id, score) => core.rate(id, score));
  ipcMain.handle('track:remove', (_e, id) => core.removeFromList(id));
  ipcMain.handle('anime:details', async (_e, id) => {
    try {
      const show = await core.details(id);
      return show ? { show, resume: resumeFor(Number(id)) } : { error: 'Could not find that show on AniList.' };
    } catch (e) {
      return { error: `Could not load the show: ${e.message}` };
    }
  });
  ipcMain.handle('anime:search', async (_e, q) => {
    try {
      return { shows: await core.search(String(q || '')) };
    } catch (e) {
      return { shows: [], error: e.message };
    }
  });
  ipcMain.handle('settings:save', async (_e, patch) => {
    const before = String(settings.get('userName') || '').trim();
    const allowed = {};
    if (typeof patch.userName === 'string') allowed.userName = patch.userName.trim();
    if (typeof patch.clientId === 'string') allowed.clientId = patch.clientId.trim();
    if (typeof patch.notify === 'boolean') allowed.notify = patch.notify;
    if ([0.8, 0.9, 0.95].includes(Number(patch.autoMarkPct))) allowed.autoMarkPct = Number(patch.autoMarkPct);
    if (typeof patch.welcomed === 'boolean') allowed.welcomed = patch.welcomed;
    settings.patch(allowed);
    if (allowed.userName !== undefined && allowed.userName !== before) {
      return refresh({ force: true });
    }
    return payload();
  });
  ipcMain.handle('anilist:login', async () => {
    const result = await loginAniList();
    if (result.ok) {
      return { ...result, data: await refresh({ force: true }) };
    }
    return result;
  });
  ipcMain.handle('anilist:logout', async () => {
    clearToken();
    return refresh({});
  });
  ipcMain.handle('account:adopt-guest', async () => {
    const count = core.adoptGuest();
    return { count, data: await refresh({ force: true }) };
  });
  // Forgets everything on this Mac (logins, tracking, cache, the Crunchyroll session) and restarts.
  ipcMain.handle('device:reset', async () => {
    closePlayer();
    for (const st of [settings, tracking, cache]) st.reset();
    await Promise.all(['persist:anilist', 'persist:crunchyroll'].map((p) => session.fromPartition(p).clearStorageData().catch(() => {})));
    await session.defaultSession.clearStorageData({ storages: ['localstorage'] }).catch(() => {}); // the window's own UI preferences
    app.relaunch();
    app.exit(0);
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
  settings = new Store(dir, 'settings', { userName: '', clientId: '', token: '', viewerId: null, viewerName: '', viewerAvatar: '', welcomed: false, notify: true, autoMarkPct: 0.9 });
  tracking = new Store(dir, 'tracking', { accounts: {}, notified: {} });
  cache = new Store(dir, 'cache', { seasons: {}, user: null, extra: null });
  core = createCore({ AL, settings, tracking, cache, dubMatch: makeDubMatcher(path.join(dir, 'dubs.json')), getToken, clearToken });
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
