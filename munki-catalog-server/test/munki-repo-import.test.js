const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const plist = require('plist');

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

function readRawPkginfo(munkiRepo, id) {
  const relPath = munkiRepo.relPathForId(id);
  const fullPath = path.join(munkiRepo.getRepoPath(), 'pkgsinfo', `${relPath}.plist`);
  return plist.parse(fs.readFileSync(fullPath, 'utf8'));
}

test('importFile: the manifest catalog and the pkginfo catalog actually intersect', () => {
  const munkiRepo = freshRepoEnv();
  munkiRepo.ensureRepoScaffold();
  const pkgPath = buildTestPkg();

  const id = munkiRepo.importFile({
    filePath: pkgPath,
    name: 'MunkiPlanCatalogCheckApp',
    version: '1.0',
    category: 'Testing',
  });

  const rawPkginfo = readRawPkginfo(munkiRepo, id);
  const manifest = munkiRepo.readManifest();

  assert.ok(Array.isArray(rawPkginfo.catalogs) && rawPkginfo.catalogs.length > 0, 'pkginfo should declare catalogs');
  const intersects = rawPkginfo.catalogs.some((c) => manifest.catalogs.includes(c));
  assert.ok(
    intersects,
    `manifest catalogs (${JSON.stringify(manifest.catalogs)}) must intersect with pkginfo catalogs (${JSON.stringify(rawPkginfo.catalogs)}), or the package is never reachable by a client`
  );
});

test('importExternal: the manifest catalog and the pkginfo catalog actually intersect', () => {
  const munkiRepo = freshRepoEnv();
  munkiRepo.ensureRepoScaffold();

  const id = munkiRepo.importExternal({
    name: 'ExternalCatalogCheckApp',
    version: '1.0',
    category: 'Testing',
    sourceUrl: 'https://vendor.example.com/ExternalCatalogCheckApp-1.0.pkg',
    sha256: 'd'.repeat(64),
    sizeBytes: 1024,
  });

  const rawPkginfo = readRawPkginfo(munkiRepo, id);
  const manifest = munkiRepo.readManifest();

  assert.ok(Array.isArray(rawPkginfo.catalogs) && rawPkginfo.catalogs.length > 0, 'pkginfo should declare catalogs');
  const intersects = rawPkginfo.catalogs.some((c) => manifest.catalogs.includes(c));
  assert.ok(
    intersects,
    `manifest catalogs (${JSON.stringify(manifest.catalogs)}) must intersect with pkginfo catalogs (${JSON.stringify(rawPkginfo.catalogs)}), or the package is never reachable by a client`
  );
});

test('importFile and importExternal use the same fixed catalog name', () => {
  const munkiRepo = freshRepoEnv();
  munkiRepo.ensureRepoScaffold();

  const fileId = munkiRepo.importFile({
    filePath: buildTestPkg(),
    name: 'MunkiPlanSameCatalogFileApp',
    version: '1.0',
    category: 'Dev-Tools',
  });
  const externalId = munkiRepo.importExternal({
    name: 'SameCatalogExternalApp',
    version: '1.0',
    category: 'Other-Category',
    sourceUrl: 'https://vendor.example.com/SameCatalogExternalApp-1.0.pkg',
    sha256: 'e'.repeat(64),
    sizeBytes: 2048,
  });

  const fileCatalogs = readRawPkginfo(munkiRepo, fileId).catalogs;
  const externalCatalogs = readRawPkginfo(munkiRepo, externalId).catalogs;
  assert.deepEqual(fileCatalogs, externalCatalogs, 'both storage modes must agree on catalog naming');
});
