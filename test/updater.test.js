'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createUpdater, readRelease, verify, swapScript } = require('../src/updater');

const zipBytes = Buffer.from('pretend zip');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const release = (sha, extra = {}) => ({
  target_commitish: sha,
  assets: [
    { name: 'AniTrack-mac-apple-silicon.zip', browser_download_url: 'https://github.com/Xanderz99/anitrack/releases/download/mac-latest/AniTrack-mac-apple-silicon.zip', size: zipBytes.length, digest: `sha256:${sha256(zipBytes)}`, ...extra },
    { name: 'AniTrack-mac-intel.zip', browser_download_url: 'https://github.com/Xanderz99/anitrack/releases/download/mac-latest/AniTrack-mac-intel.zip', size: 5 },
  ],
});

test('a release from another commit is an update, for the right kind of Mac', () => {
  assert.deepStrictEqual(readRelease(release('abc1234def'), 'abc1234def', 'arm64'), { status: 'current', sha: 'abc1234def' });
  const r = readRelease(release('fff0000aaa'), 'abc1234def', 'arm64');
  assert.strictEqual(r.status, 'available');
  assert.match(r.asset.url, /apple-silicon/);
  assert.match(readRelease(release('fff0000aaa'), 'abc1234def', 'x64').asset.url, /intel/);
  assert.strictEqual(readRelease({ assets: [] }, 'abc', 'arm64').status, 'error');
  assert.strictEqual(readRelease(release('fff0000aaa', { browser_download_url: 'https://evil.example/x.zip' }), 'abc1234def', 'arm64').status, 'error', 'downloads only come from GitHub');
});

test('a download must match the published size and fingerprint', () => {
  const asset = { size: zipBytes.length, digest: `sha256:${sha256(zipBytes)}` };
  assert.strictEqual(verify(zipBytes, asset), null);
  assert.match(verify(Buffer.from('pretend zip!'), asset), /bytes/);
  assert.match(verify(Buffer.from('pretend zap'), asset), /fingerprint/);
  assert.strictEqual(verify(zipBytes, { size: 0, digest: null }), null, 'older releases without a digest still work');
});

// A temporary "Applications" folder with an installed AniTrack.app in it.
function installed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anitrack-upd-'));
  const appPath = path.join(root, 'Applications', 'AniTrack.app');
  fs.mkdirSync(path.join(appPath, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'old');
  return { root, appPath, workDir: path.join(root, 'updates') };
}
const fakeFetch = (rel, bytes = zipBytes) => async (url) =>
  url.includes('api.github.com') ? { ok: true, status: 200, json: async () => rel } : { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
// Stands in for ditto: "unzips" a new AniTrack.app next to the zip.
const fakeUnzip = async (_cmd, args) => {
  const dir = args.at(-1);
  fs.mkdirSync(path.join(dir, 'AniTrack.app', 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'AniTrack.app', 'Contents', 'Info.plist'), 'new');
};

test('check downloads, verifies and unpacks a newer build; install swaps it in after the app quits', async () => {
  const { appPath, workDir } = installed();
  const states = [];
  let spawned = null;
  const u = createUpdater({ fetch: fakeFetch(release('fff0000aaa')), currentSha: 'abc1234def', arch: 'arm64', appPath, workDir, run: fakeUnzip, spawnDetached: (f) => (spawned = f), pid: 999999, onChange: (s) => states.push(s.status) });
  const s = await u.check();
  assert.strictEqual(s.status, 'ready');
  assert.deepStrictEqual(states, ['checking', 'downloading', 'ready']);
  assert.strictEqual(u.install({ relaunch: false }), true);
  assert.strictEqual(u.state().status, 'installing');
  execFileSync('/bin/sh', [spawned]); // pid 999999 is not running, so it swaps at once
  assert.strictEqual(fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8'), 'new');
  assert.ok(!fs.existsSync(`${appPath}.previous`));
});

test('nothing is downloaded when up to date, or when the download is wrong', async () => {
  const { appPath, workDir } = installed();
  const up = createUpdater({ fetch: fakeFetch(release('abc1234def')), currentSha: 'abc1234def', arch: 'arm64', appPath, workDir, run: fakeUnzip, spawnDetached: () => {} });
  assert.strictEqual((await up.check()).status, 'current');
  assert.strictEqual(up.install({ relaunch: true }), false);
  const bad = createUpdater({ fetch: fakeFetch(release('fff0000aaa'), Buffer.from('pretend zap')), currentSha: 'abc1234def', arch: 'arm64', appPath, workDir, run: fakeUnzip, spawnDetached: () => {} });
  const s = await bad.check();
  assert.strictEqual(s.status, 'error');
  assert.match(s.error, /fingerprint/);
});

test('an app it cannot replace (not moved out of Downloads) points to the download page instead', async () => {
  const { workDir } = installed();
  const u = createUpdater({ fetch: fakeFetch(release('fff0000aaa')), currentSha: 'abc1234def', arch: 'arm64', appPath: '/private/var/folders/x/AppTranslocation/ABC/d/AniTrack.app', workDir, run: fakeUnzip, spawnDetached: () => {} });
  const s = await u.check();
  assert.strictEqual(s.status, 'manual');
  assert.match(s.error, /Applications/);
});

test('if the swap fails half way, the old app is put back', () => {
  const { root, appPath } = installed();
  const script = path.join(root, 'swap.sh');
  fs.writeFileSync(script, swapScript({ pid: 999999, oldApp: appPath, newApp: path.join(root, 'missing', 'AniTrack.app'), relaunch: false }));
  execFileSync('/bin/sh', [script]);
  assert.strictEqual(fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8'), 'old');
});
