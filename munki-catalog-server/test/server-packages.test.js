// munki-catalog-server/test/server-packages.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function buildTestPkg() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'test-pkg-'));
  const payloadDir = path.join(work, 'payload', 'Applications', 'MunkiServerTestApp');
  fs.mkdirSync(payloadDir, { recursive: true });
  fs.writeFileSync(path.join(payloadDir, 'readme.txt'), 'server test');
  const pkgPath = path.join(work, 'App-1.0.pkg');
  execFileSync('pkgbuild', [
    '--root', path.join(work, 'payload'),
    '--identifier', 'com.example.munkiservertestapp',
    '--version', '1.0',
    '--install-location', '/',
    pkgPath,
  ]);
  return pkgPath;
}

test('POST /admin/packages (external mode) then approve shows it as approved', async () => {
  process.env.MUNKI_REPO_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'munki-repo-server-test-'));
  process.env.PORT = '0'; // let Fastify not actually bind a fixed port during inject-based tests
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../src/munki-repo')];
  delete require.cache[require.resolve('../src/server')];
  const app = require('../src/server');
  await app.ready();

  const createRes = await app.inject({
    method: 'POST',
    url: '/admin/packages',
    // light-my-request JSON.stringifies any object payload regardless of
    // content-type, so a real x-www-form-urlencoded body has to be built
    // as a string here rather than passed as a plain object.
    payload: new URLSearchParams({
      mode: 'external',
      name: 'ServerTestApp',
      version: '1.0',
      category: 'Testing',
      source_url: 'https://vendor.example.com/ServerTestApp-1.0.pkg',
      sha256: 'c'.repeat(64),
      size_bytes: '1000',
    }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(createRes.statusCode, 302);

  const munkiRepo = require('../src/munki-repo');
  const [pkg] = munkiRepo.listPackages().filter((p) => p.name === 'ServerTestApp');
  assert.ok(pkg, 'package should be listed');
  assert.equal(pkg.approved, false);

  const approveRes = await app.inject({ method: 'POST', url: `/admin/packages/${pkg.id}/approve` });
  assert.equal(approveRes.statusCode, 302);

  const approved = munkiRepo.getPackage(pkg.id);
  assert.equal(approved.approved, true);

  await app.close();
});
