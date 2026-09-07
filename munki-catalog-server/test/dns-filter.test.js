const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('blocked_domains rows make isBlocked-equivalent logic return true', () => {
  process.env.MUNKI_REPO_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'munki-repo-dns-test-'));
  delete require.cache[require.resolve('../src/db')];
  const db = require('../src/db');

  // Clean up any existing row to avoid UNIQUE constraint violations when tests run in sequence
  db.prepare(`DELETE FROM blocked_domains WHERE domain = ?`).run('malware.example.com');
  db.prepare(`INSERT INTO blocked_domains (domain, reason) VALUES (?, ?)`).run('malware.example.com', 'test');

  // dns-filter-server.js binds a real UDP socket at require-time via
  // server.listen(), which this test intentionally avoids requiring
  // directly (needs sudo for port 53 and isn't something CI should bind).
  // Instead this test proves the DB-level contract dns-filter-server.js
  // depends on: a row in blocked_domains for the exact domain, and that a
  // subdomain query should also match via suffix comparison — the same
  // rule dns-filter-server.js's isBlocked() implements.
  const blocked = db.prepare(`SELECT domain FROM blocked_domains`).all();
  const isBlocked = (name) => {
    const normalized = name.toLowerCase().replace(/\.$/, '');
    return blocked.some((b) => normalized === b.domain || normalized.endsWith(`.${b.domain}`));
  };

  assert.equal(isBlocked('malware.example.com'), true);
  assert.equal(isBlocked('sub.malware.example.com'), true);
  assert.equal(isBlocked('safe.example.com'), false);
});
