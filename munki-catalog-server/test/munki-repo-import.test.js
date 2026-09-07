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
  const payloadDir = path.join(work, 'payload', 'Applications', 'MunkiPlanTestApp');
  fs.mkdirSync(payloadDir, { recursive: true });
  fs.writeFileSync(path.join(payloadDir, 'readme.txt'), 'test package for munki-repo import tests');
  const pkgPath = path.join(work, 'MunkiPlanTestApp-1.0.pkg');
  execFileSync('pkgbuild', [
    '--root', path.join(work, 'payload'),
    '--identifier', 'com.example.munkiplantestapp',
    '--version', '1.0',
    '--install-location', '/',
    pkgPath,
  ]);
  return pkgPath;
}

test('importFile shells out to munkiimport and returns a resolvable id', () => {
  const munkiRepo = freshRepoEnv();
  munkiRepo.ensureRepoScaffold();
  const pkgPath = buildTestPkg();

  const id = munkiRepo.importFile({
    filePath: pkgPath,
    name: 'MunkiPlanTestApp',
    displayName: 'Munki Plan Test App',
    version: '1.0',
    category: 'Testing',
    description: 'imported by munki-repo-import.test.js',
    developer: 'Plan Test',
    requires: [],
  });

  const pkg = munkiRepo.getPackage(id);
  assert.equal(pkg.name, 'MunkiPlanTestApp');
  assert.equal(pkg.storageMode, 'file');
  assert.match(pkg.sha256, /^[0-9a-f]{64}$/);
});

test('importFile writes the requires array when provided', () => {
  const munkiRepo = freshRepoEnv();
  munkiRepo.ensureRepoScaffold();
  const pkgPath = buildTestPkg();

  const id = munkiRepo.importFile({
    filePath: pkgPath,
    name: 'MunkiPlanTestApp2',
    version: '1.0',
    category: 'Testing',
    requires: ['SomeLibrary'],
  });

  const pkg = munkiRepo.getPackage(id);
  assert.deepEqual(pkg.requires, ['SomeLibrary']);
});

test('importExternal writes a pkginfo with PackageCompleteURL, no shell-out', () => {
  const munkiRepo = freshRepoEnv();
  munkiRepo.ensureRepoScaffold();

  const id = munkiRepo.importExternal({
    name: 'ExternalApp',
    displayName: 'External App',
    version: '2.0',
    category: 'Testing',
    description: 'metadata-only test',
    developer: 'Vendor Inc',
    sourceUrl: 'https://vendor.example.com/ExternalApp-2.0.pkg',
    sha256: 'b'.repeat(64),
    sizeBytes: 1048576,
    requires: [],
  });

  const pkg = munkiRepo.getPackage(id);
  assert.equal(pkg.name, 'ExternalApp');
  assert.equal(pkg.storageMode, 'external');
  assert.equal(pkg.sourceUrl, 'https://vendor.example.com/ExternalApp-2.0.pkg');
  assert.equal(pkg.sha256, 'b'.repeat(64));
  // no actual file should be created under pkgs/ for an external package
  assert.ok(!fs.existsSync(path.join(munkiRepo.getRepoPath(), 'pkgs', 'testing')));
});
