// munki-catalog-server/test/db.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('db.js creates all expected tables', () => {
  delete require.cache[require.resolve('../src/db')];
  const db = require('../src/db');
  // Filter out sqlite_* system tables (sqlite_sequence is created by SQLite
  // when AUTOINCREMENT is used; it's not part of our schema)
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, [
    'blocked_domains',
    'blocked_hashes',
    'devices',
    'install_events',
    'santa_devices',
    'santa_events',
  ]);
  // install_events uses package_name, not package_id
  const cols = db.prepare(`PRAGMA table_info(install_events)`).all().map((c) => c.name);
  assert.ok(cols.includes('package_name'));
  assert.ok(!cols.includes('package_id'));
});
