const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('device checkin and install events are recorded', async () => {
  process.env.MUNKI_REPO_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'munki-repo-api-test-'));
  process.env.PORT = '0'; // avoid EADDRINUSE if node:test runs files concurrently
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../src/munki-repo')];
  delete require.cache[require.resolve('../src/server')];
  const app = require('../src/server');
  await app.ready();

  const checkin = await app.inject({
    method: 'POST',
    url: '/api/devices/checkin',
    payload: { device_uuid: 'TESTUUID-1', hostname: 'test-mac' },
  });
  assert.equal(checkin.statusCode, 200);

  const event = await app.inject({
    method: 'POST',
    url: '/api/install-events',
    payload: { device_uuid: 'TESTUUID-1', package_name: 'SomeApp', status: 'installed' },
  });
  assert.equal(event.statusCode, 200);

  const db = require('../src/db');
  const device = db.prepare(`SELECT * FROM devices WHERE device_uuid = ?`).get('TESTUUID-1');
  assert.equal(device.hostname, 'test-mac');
  const evt = db.prepare(`SELECT * FROM install_events WHERE device_uuid = ?`).get('TESTUUID-1');
  assert.equal(evt.package_name, 'SomeApp');
  assert.equal(evt.status, 'installed');

  await app.close();
});
