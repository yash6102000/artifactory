const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function freshRepoEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'munki-repo-test-'));
  process.env.MUNKI_REPO_PATH = dir;
  delete require.cache[require.resolve('../src/munki-repo')];
  return require('../src/munki-repo');
}

function buildTestPkg() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'test-pkg-'));
  const payloadDir = path.join(work, 'payload', 'Applications', 'MunkiPlanApproveApp');
  fs.mkdirSync(payloadDir, { recursive: true });
  fs.writeFileSync(path.join(payloadDir, 'readme.txt'), 'approve test');
  const pkgPath = path.join(work, 'App-1.0.pkg');
  execFileSync('pkgbuild', [
    '--root', path.join(work, 'payload'),
    '--identifier', 'com.example.munkiplanapproveapp',
    '--version', '1.0',
    '--install-location', '/',
    pkgPath,
  ]);
  return pkgPath;
}

test('approve adds the package name to optional_installs and rebuilds catalogs', () => {
  const munkiRepo = freshRepoEnv();
  munkiRepo.ensureRepoScaffold();
  const id = munkiRepo.importFile({
    filePath: buildTestPkg(),
    name: 'MunkiPlanApproveApp',
    version: '1.0',
    category: 'Testing',
  });

  munkiRepo.approve(id);

  const manifest = munkiRepo.readManifest();
  assert.ok(manifest.optional_installs.includes('MunkiPlanApproveApp'));
  const catalogPath = path.join(munkiRepo.getRepoPath(), 'catalogs', 'testing');
  assert.ok(fs.existsSync(catalogPath), 'makecatalogs should have written catalogs/testing');

  const pkg = munkiRepo.getPackage(id);
  assert.equal(pkg.approved, true);
});

test('revoke removes the package name from optional_installs', () => {
  const munkiRepo = freshRepoEnv();
  munkiRepo.ensureRepoScaffold();
  const id = munkiRepo.importFile({
    filePath: buildTestPkg(),
    name: 'MunkiPlanRevokeApp',
    version: '1.0',
    category: 'Testing',
  });
  munkiRepo.approve(id);
  munkiRepo.revoke(id);

  const pkg = munkiRepo.getPackage(id);
  assert.equal(pkg.approved, false);
});
