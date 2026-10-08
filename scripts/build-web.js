'use strict';
// Builds the iPhone / web version into web/dist (no dependencies, just Node).
// The shared AniList + taste + dub code is wrapped in a tiny require() so it runs in the browser.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'web', 'dist');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'icons'), { recursive: true });

const mods = { anilist: 'src/anilist.js', taste: 'src/taste.js', dubs: 'src/dubs.js' };
let js = `'use strict';\n(() => {\nconst __m = {};\nconst __f = {\n  fs: (module) => { module.exports = { readFileSync() { throw new Error('no fs'); } }; },\n`;
for (const [name, file] of Object.entries(mods)) js += `  ${name}: (module, exports, require) => {\n${read(file)}\n  },\n`;
js += `};\nconst require = (n) => { n = n.replace(/^\\.\\//, ''); if (!__m[n]) { const module = { exports: {} }; __m[n] = module; __f[n](module, module.exports, require); } return __m[n].exports; };\nwindow.__require = require;\n})();\n`;
js += read('web/core.js').replace("(() => {\n  const AL", "(() => {\n  const require = window.__require;\n  const AL") + '\n';
js += read('renderer/app.js') + '\n';
js += `if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});\n`;
fs.writeFileSync(path.join(out, 'app.js'), js);
fs.writeFileSync(path.join(out, 'styles.css'), read('renderer/styles.css') + read('web/mobile.css'));
for (const f of ['index.html', 'manifest.webmanifest', 'sw.js']) fs.copyFileSync(path.join(root, 'web', f), path.join(out, f));
for (const f of fs.readdirSync(path.join(root, 'web', 'icons'))) fs.copyFileSync(path.join(root, 'web', 'icons', f), path.join(out, 'icons', f));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log('Built', out);
