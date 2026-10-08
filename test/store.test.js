'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'anitrack-'));

test('starts from defaults and persists changes', () => {
  const dir = tmp();
  const a = new Store(dir, 'settings', { notify: true, userName: 'x' });
  assert.strictEqual(a.get('notify'), true);
  a.set('userName', 'someone');
  a.patch({ notify: false });
  const b = new Store(dir, 'settings', { notify: true, userName: 'x', added: 1 });
  assert.strictEqual(b.get('userName'), 'someone');
  assert.strictEqual(b.get('notify'), false);
  assert.strictEqual(b.get('added'), 1, 'new defaults appear for old files');
  assert.ok(!fs.existsSync(path.join(dir, 'settings.json.tmp')), 'no temp file left behind');
});

test('a corrupt file falls back to defaults', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'cache.json'), '{"seasons": ');
  const s = new Store(dir, 'cache', { seasons: {} });
  assert.deepStrictEqual(s.get('seasons'), {});
});

test('defaults are not shared between instances', () => {
  const defaults = { items: {} };
  const a = new Store(tmp(), 'tracking', defaults);
  a.get('items')[1] = { status: 'WATCHING' }; // the app mutates nested objects in place
  assert.deepStrictEqual(defaults.items, {});
});
