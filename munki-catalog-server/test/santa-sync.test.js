// munki-catalog-server/test/santa-sync.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function buildTestPkg() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'test-pkg-'));
  const payloadDir = path.join(work, 'payload', 'Applications', 'SantaTestApp');
  fs.mkdirSync(payloadDir, { recursive: true });
  fs.writeFileSync(path.join(payloadDir, 'readme.txt'), 'santa sync test');
  const pkgPath = path.join(work, 'App-1.0.pkg');
  execFileSync('pkgbuild', [
    '--root', path.join(work, 'payload'),
    '--identifier', 'com.example.santatestapp',
    '--version', '1.0',
    '--install-location', '/',
    pkgPath,
  ]);
  return pkgPath;
}

test('ruledownload emits ALLOWLIST for an approved package and REMOVE for a pending one', async () => {
  process.env.MUNKI_REPO_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'munki-repo-santa-test-'));
  process.env.PORT = '0'; // avoid EADDRINUSE if node:test runs files concurrently
  delete require.cache[require.resolve('../src/db')];
  delete require.cache[require.resolve('../src/munki-repo')];
  delete require.cache[require.resolve('../src/server')];
  const app = require('../src/server');
  await app.ready();
  const munkiRepo = require('../src/munki-repo');

  const approvedId = munkiRepo.importFile({
    filePath: buildTestPkg(),
    name: 'SantaTestApp',
    version: '1.0',
    category: 'Testing',
  });
  munkiRepo.approve(approvedId);
  const approvedHash = munkiRepo.getPackage(approvedId).sha256;

  munkiRepo.importExternal({
    name: 'PendingApp',
    version: '1.0',
    category: 'Testing',
    sourceUrl: 'https://vendor.example.com/PendingApp-1.0.pkg',
    sha256: 'e'.repeat(64),
    sizeBytes: 1000,
  });

  const res = await app.inject({ method: 'POST', url: '/ruledownload/TESTMACHINE1' });
  assert.equal(res.statusCode, 200);
  const { rules } = JSON.parse(res.body);

  const allow = rules.find((r) => r.identifier === approvedHash);
  assert.equal(allow.policy, 'ALLOWLIST');

  const remove = rules.find((r) => r.identifier === 'e'.repeat(64));
  assert.equal(remove.policy, 'REMOVE');

  await app.close();
});
