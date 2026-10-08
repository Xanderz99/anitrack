'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// A single syntax error stops the whole app from starting on every device, so every file the app
// loads must parse. (Two broken pushes to main got past the other tests this way.)
const root = path.join(__dirname, '..');
const files = ['renderer/app.js', 'renderer/boot.js', 'web/core.js', 'web/sw.js', 'docs/app.js', 'docs/boot.js', 'docs/sw.js', 'src/main.js', 'src/preload.js', 'src/player-preload.js'];

for (const f of files) {
  test(`${f} parses`, () => {
    const file = path.join(root, f);
    assert.ok(fs.existsSync(file), `${f} is missing`);
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (e) {
      assert.fail(`${f} has a syntax error:\n${String(e.stderr).split('\n').slice(0, 5).join('\n')}`);
    }
  });
}
