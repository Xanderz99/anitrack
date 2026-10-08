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
  const mods = { anilist: 'src/anilist.js', taste: 'src/taste.js', dubs: 'src/dubs.js', core: 'src/core.js' };
  let js = `'use strict';\n(() => {\nconst __m = {};\nconst __f = {\n  fs: (module) => { module.exports = { readFileSync() { throw new Error('no fs'); } }; },\n`;
  for (const [name, file] of Object.entries(mods)) js += `  ${name}: (module, exports, require) => {\n${read(file)}\n  },\n`;
  js += `};\nconst require = (n) => { n = n.replace(/^\\.\\//, ''); if (!__m[n]) { const module = { exports: {} }; __m[n] = module; __f[n](module, module.exports, require); } return __m[n].exports; };\nwindow.__require = require;\n})();\n`;
  js += `((require) => {\n${read('web/core.js')}\n})(window.__require);\n`;
  js += read('renderer/app.js') + '\n';
  js += `if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});\n`;
  files['app.js'] = js;
  files['styles.css'] = read('renderer/styles.css') + read('web/mobile.css');
  for (const f of ['index.html', 'manifest.webmanifest', 'sw.js']) files[f] = fs.readFileSync(path.join(root, 'web', f));
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
