const path = require('node:path');
const Database = require('better-sqlite3');

// NOTE: the plan (Tech Stack tab) calls for Postgres so ~100 concurrent
// devices don't hit SQLite's single-writer lock. This uses SQLite for now
// because no Postgres instance is available in this dev environment.
// Every query below is plain SQL with no SQLite-only syntax, so swapping
// the driver later is a small, contained change, not a rewrite.
const dbPath = path.join(__dirname, '..', 'data', 'catalog.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Other',
    icon TEXT NOT NULL DEFAULT '📦',
    filename TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    approved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_uuid TEXT NOT NULL UNIQUE,
    hostname TEXT NOT NULL DEFAULT '',
    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS install_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_uuid TEXT NOT NULL,
    package_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

module.exports = db;
