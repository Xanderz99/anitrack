'use strict';
// Updates the Mac app from its GitHub release (tag mac-latest), without the App Store or Apple's
// updater (which needs a paid developer signature). Checks which commit the release was built from,
// downloads the zip for this kind of Mac, checks it against the digest GitHub publishes, unpacks it,
// and swaps it in for the running app when you quit or press Restart. Your data lives outside the app
// (in ~/Library/Application Support/AniTrack), so it is untouched.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RELEASE_API = 'https://api.github.com/repos/Xanderz99/anitrack/releases/tags/mac-latest';
const DOWNLOAD_HOSTS = /^https:\/\/(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//;
const assetName = (arch) => `AniTrack-mac-${arch === 'arm64' ? 'apple-silicon' : 'intel'}.zip`;

// Is there a build newer than this one? `release` is GitHub's release JSON.
// -> { status: 'current' } | { status: 'available', sha, asset: { url, size, digest } } | { status: 'error', error }
function readRelease(release, currentSha, arch) {
  const sha = release?.target_commitish;
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return { status: 'error', error: 'The release has no build number.' };
  if (currentSha && sha.toLowerCase().startsWith(String(currentSha).toLowerCase())) return { status: 'current', sha };
  const a = (release.assets || []).find((x) => x.name === assetName(arch));
  if (!a || !DOWNLOAD_HOSTS.test(a.browser_download_url || '')) return { status: 'error', error: `The release has no ${assetName(arch)}.` };
  return { status: 'available', sha, asset: { url: a.browser_download_url, size: a.size || 0, digest: a.digest || null } };
}

// Checks a downloaded zip against the release's size and sha256 digest (when GitHub gives one).
function verify(buf, asset) {
  if (asset.size && buf.length !== asset.size) return `The download is ${buf.length} bytes, expected ${asset.size}.`;
  const m = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
  if (m && crypto.createHash('sha256').update(buf).digest('hex') !== m[1].toLowerCase()) return 'The download does not match its published fingerprint.';
  return null;
}

// The shell script that swaps the new app in once AniTrack has quit, then optionally reopens it.
// If anything fails half way, the old app is put back.
function swapScript({ pid, oldApp, newApp, relaunch }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
while kill -0 ${Number(pid)} 2>/dev/null; do sleep 0.3; done
OLD=${q(oldApp)}
NEW=${q(newApp)}
rm -rf "$OLD.previous"
if mv "$OLD" "$OLD.previous" && mv "$NEW" "$OLD"; then
  rm -rf "$OLD.previous"
else
  [ -d "$OLD" ] || mv "$OLD.previous" "$OLD"
fi
xattr -cr "$OLD" 2>/dev/null || true
${relaunch ? 'open "$OLD"' : ''}
exit 0
`;
}

// `fetch` follows redirects; `run(cmd, args)` runs a program and resolves when it exits successfully;
// `spawnDetached(file)` starts the swap script so it outlives the app.
function createUpdater({ fetch, currentSha, arch, appPath, workDir, run, spawnDetached, pid = process.pid, onChange = () => {} }) {
  const state = { status: 'idle', sha: currentSha || null, latest: null, error: null, checkedAt: null };
  let ready = null; // { newApp }
  let busy = null;
  const set = (o) => {
    Object.assign(state, o);
    onChange({ ...state });
  };

  // Where the running app is and whether it can be replaced in place.
  function canReplace() {
    if (!appPath || !appPath.endsWith('.app')) return 'This copy of AniTrack is not an installed app.';
    if (appPath.includes('/AppTranslocation/')) return 'Move AniTrack to your Applications folder first, then reopen it.';
    try {
      fs.accessSync(path.dirname(appPath), fs.constants.W_OK);
      fs.accessSync(appPath, fs.constants.W_OK);
    } catch {
      return 'AniTrack cannot replace itself in this folder.';
    }
    return null;
  }

  async function check() {
    if (busy) return busy;
    busy = (async () => {
      if (ready) return { ...state };
      set({ status: 'checking', error: null });
      let release;
      try {
        const res = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
        if (res.status === 404) return set({ status: 'current', checkedAt: Date.now() }); // being republished
        if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
        release = await res.json();
      } catch (e) {
        return set({ status: 'error', error: `Could not check for updates: ${e.message}`, checkedAt: Date.now() });
      }
      const r = readRelease(release, currentSha, arch);
      if (r.status !== 'available') return set({ status: r.status, latest: r.sha || null, error: r.error || null, checkedAt: Date.now() });
      const blocked = canReplace();
      if (blocked) return set({ status: 'manual', latest: r.sha, error: blocked, checkedAt: Date.now() });
      set({ status: 'downloading', latest: r.sha });
      try {
        const res = await fetch(r.asset.url);
        if (!res.ok) throw new Error(`download failed (${res.status})`);
        const buf = Buffer.from(await res.arrayBuffer());
        const bad = verify(buf, r.asset);
        if (bad) throw new Error(bad);
        const dir = path.join(workDir, `update-${r.sha.slice(0, 12)}`);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        const zip = path.join(dir, 'AniTrack.zip');
        fs.writeFileSync(zip, buf);
        await run('/usr/bin/ditto', ['-x', '-k', zip, dir]);
        const newApp = path.join(dir, 'AniTrack.app');
        if (!fs.existsSync(path.join(newApp, 'Contents', 'Info.plist'))) throw new Error('the download did not contain AniTrack.app');
        fs.rmSync(zip, { force: true });
        ready = { newApp };
        set({ status: 'ready', error: null, checkedAt: Date.now() });
      } catch (e) {
        set({ status: 'error', error: `Could not download the update: ${e.message}`, checkedAt: Date.now() });
      }
    })().finally(() => {
      busy = null;
    });
    await busy;
    return { ...state };
  }

  // Starts the swap; the caller quits the app straight after. Returns false if nothing is ready.
  function install({ relaunch }) {
    if (!ready || state.status === 'installing') return false;
    const script = path.join(workDir, 'install-update.sh');
    fs.writeFileSync(script, swapScript({ pid, oldApp: appPath, newApp: ready.newApp, relaunch }), { mode: 0o755 });
    spawnDetached(script);
    set({ status: 'installing' });
    return true;
  }

  return { check, install, state: () => ({ ...state }) };
}

module.exports = { createUpdater, readRelease, verify, swapScript, assetName, RELEASE_API };
