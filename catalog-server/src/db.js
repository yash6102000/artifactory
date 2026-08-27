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

  -- Santa's own registration, separate from "devices" above: Santa identifies
  -- machines by machine_id (its serial number), not our client app's
  -- device_uuid — the two check in independently and aren't the same identity.
  CREATE TABLE IF NOT EXISTS santa_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id TEXT NOT NULL UNIQUE,
    hostname TEXT NOT NULL DEFAULT '',
    serial_num TEXT NOT NULL DEFAULT '',
    santa_version TEXT NOT NULL DEFAULT '',
    client_mode TEXT NOT NULL DEFAULT '',
    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Blocked/allowed exec events Santa clients report via eventupload — the
  -- audit trail the plan calls for ("no record to investigate if something
  -- does slip through").
  CREATE TABLE IF NOT EXISTS santa_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id TEXT NOT NULL,
    file_sha256 TEXT NOT NULL DEFAULT '',
    file_path TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL DEFAULT '',
    decision TEXT NOT NULL DEFAULT '',
    executing_user TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Explicit BLOCKLIST rules for a specific binary hash, independent of
  -- packages we host — e.g. a bad/malicious binary an exec event surfaced,
  -- not something that ever went through our upload/approve flow. This is
  -- a narrow exception list, not the enforcement mechanism itself: Santa's
  -- default-deny (nothing runs unless our catalog approved it) already
  -- covers everything else.
  CREATE TABLE IF NOT EXISTS blocked_hashes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256 TEXT NOT NULL UNIQUE,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Domains the DNS sinkhole (dns-filter-server.js) refuses to resolve for
  -- any Mac pointed at it. Separate concern from blocked_hashes (a binary
  -- that already ran vs. a site that shouldn't resolve at all).
  CREATE TABLE IF NOT EXISTS blocked_domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL UNIQUE,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

module.exports = db;
