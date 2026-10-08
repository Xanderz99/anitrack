'use strict';
const fs = require('fs');
const path = require('path');

// Tiny JSON file store. Writes are atomic (temp file + rename).
class Store {
  constructor(dir, name, defaults) {
    this.file = path.join(dir, `${name}.json`);
    this.data = JSON.parse(JSON.stringify(defaults)); // deep copy: callers mutate nested objects in place
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      /* first run or unreadable file: start from defaults */
    }
  }
  get(key) {
    return this.data[key];
  }
  set(key, value) {
    this.data[key] = value;
    this.save();
  }
  patch(obj) {
    Object.assign(this.data, obj);
    this.save();
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (e) {
      console.error('Could not save', this.file, e.message);
    }
  }
}

module.exports = { Store };
