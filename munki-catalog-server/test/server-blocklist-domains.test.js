const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('blocklist and domains admin routes work end to end', async () => {
  process.env.MUNKI_REPO_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'munki-repo-bd-test-'));
  process.env.PORT = '0'; // avoid EADDRINUSE if node:test runs files concurrently
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../src/munki-repo')];
  delete require.cache[require.resolve('../src/server')];
  const app = require('../src/server');
  await app.ready();

  const addHash = await app.inject({
    method: 'POST',
    url: '/admin/blocklist',
    payload: new URLSearchParams({
      sha256: 'd'.repeat(64),
      reason: 'bad binary',
    }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(addHash.statusCode, 302);

  const blocklistPage = await app.inject({ method: 'GET', url: '/admin/blocklist' });
  assert.match(blocklistPage.body, /bad binary/);

  const addDomain = await app.inject({
    method: 'POST',
    url: '/admin/domains',
    payload: new URLSearchParams({
      domain: 'https://malware.example.com/path',
      reason: 'phishing',
    }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(addDomain.statusCode, 302);

  const domainsPage = await app.inject({ method: 'GET', url: '/admin/domains' });
  assert.match(domainsPage.body, /malware\.example\.com/);

  const dashboard = await app.inject({ method: 'GET', url: '/admin' });
  assert.equal(dashboard.statusCode, 200);

  await app.close();
});
