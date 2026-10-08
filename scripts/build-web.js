'use strict';
// Builds the iPhone / web version into docs/ (served by GitHub Pages). No dependencies, just Node.
// The shared AniList + taste + dub + core code is wrapped in a tiny require() so it runs in the browser.
//   node scripts/build-web.js           rebuild docs/
//   node scripts/build-web.js --check   exit 1 if docs/ is out of date with the sources
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'docs');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function build() {
  const files = {};
  const mods = { config: 'src/config.js', anilist: 'src/anilist.js', taste: 'src/taste.js', dubs: 'src/dubs.js', core: 'src/core.js' };
  let js = `'use strict';\n(() => {\nconst __m = {};\nconst __f = {\n  fs: (module) => { module.exports = { readFileSync() { throw new Error('no fs'); } }; },\n`;
  for (const [name, file] of Object.entries(mods)) js += `  ${name}: (module, exports, require) => {\n${read(file)}\n  },\n`;
  js += `};\nconst require = (n) => { n = n.replace(/^\\.\\//, ''); if (!__m[n]) { const module = { exports: {} }; __m[n] = module; __f[n](module, module.exports, require); } return __m[n].exports; };\nwindow.__require = require;\n})();\n`;
  js += `((require) => {\n${read('web/core.js')}\n})(window.__require);\n`;
  js += read('renderer/app.js') + '\n';
  js += `if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});\n`;
  files['app.js'] = js;
  files['styles.css'] = read('renderer/styles.css') + read('web/mobile.css');
  files['boot.js'] = read('renderer/boot.js');
  for (const f of ['manifest.webmanifest']) files[f] = fs.readFileSync(path.join(root, 'web', f));
  // Each release references its files by a hash of their contents (app.js?v=…), so a phone can never
  // mix a cached old file with a new page, and the service worker's cache name changes with them.
  const hash = (s) => require('crypto').createHash('sha256').update(s).digest('hex').slice(0, 10);
  const v = {};
  for (const f of ['boot.js', 'app.js', 'styles.css']) v[f] = hash(files[f]);
  files['index.html'] = read('web/index.html')
    .replace('href="styles.css"', `href="styles.css?v=${v['styles.css']}"`)
    .replace('src="boot.js"', `src="boot.js?v=${v['boot.js']}"`)
    .replace('src="app.js"', `src="app.js?v=${v['app.js']}"`);
  for (const f of ['styles.css', 'boot.js', 'app.js']) if (!files['index.html'].includes(`${f}?v=`)) throw new Error(`web/index.html no longer links ${f}`);
  files['sw.js'] = read('web/sw.js').replace("'anitrack-__BUILD__'", `'anitrack-${hash(Object.values(v).join(''))}'`);
  if (files['sw.js'].includes("'anitrack-__BUILD__'")) throw new Error('web/sw.js cache name placeholder not found');
  for (const f of fs.readdirSync(path.join(root, 'web', 'icons'))) files[`icons/${f}`] = fs.readFileSync(path.join(root, 'web', 'icons', f));
  files['.nojekyll'] = '';
  return files;
}

const files = build();
if (process.argv.includes('--check')) {
  const stale = Object.entries(files).filter(([f, body]) => {
    try {
      return !fs.readFileSync(path.join(out, f)).equals(Buffer.from(body));
    } catch {
      return true;
    }
  });
  if (stale.length) {
    console.error(`docs/ is out of date (${stale.map(([f]) => f).join(', ')}). Run: npm run build:web`);
    process.exit(1);
  }
  console.log('docs/ is up to date');
} else {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'icons'), { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(out, f), body);
  console.log('Built', out);
}
