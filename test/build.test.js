'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');

// docs/ is what GitHub Pages serves, so it has to be rebuilt whenever the shared code changes.
test('docs/ matches the sources (run npm run build:web if this fails)', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-web.js'), '--check'], { stdio: 'pipe' }));
});
