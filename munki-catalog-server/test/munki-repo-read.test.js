const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshRepoEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'munki-repo-test-'));
  process.env.MUNKI_REPO_PATH = dir;
  delete require.cache[require.resolve('../src/munki-repo')];
  return require('../src/munki-repo');
}

test('ensureRepoScaffold creates folders and an empty manifest', () => {
  const munkiRepo = freshRepoEnv();
  munkiRepo.ensureRepoScaffold();
  const repo = process.env.MUNKI_REPO_PATH;
  for (const dir of ['catalogs', 'manifests', 'pkgs', 'pkgsinfo', 'icons', 'client_resources']) {
    assert.ok(fs.existsSync(path.join(repo, dir)), `${dir} should exist`);
  }
  assert.ok(fs.existsSync(path.join(repo, 'manifests', 'site_default')));
});

test('listPackages reads a hand-written pkginfo fixture', () => {
  const munkiRepo = freshRepoEnv();
  munkiRepo.ensureRepoScaffold();
  const repo = process.env.MUNKI_REPO_PATH;
  const plist = require('plist');
  const dir = path.join(repo, 'pkgsinfo', 'testing');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'FixtureApp-1.0.plist'),
    plist.build({
      name: 'FixtureApp',
      display_name: 'Fixture App',
      version: '1.0',
      category: 'testing',
      description: 'a fixture',
      developer: 'Test',
      installer_item_location: 'testing/FixtureApp-1.0.pkg',
      installer_item_hash: 'a'.repeat(64),
    })
  );

  const packages = munkiRepo.listPackages();
  assert.equal(packages.length, 1);
  assert.equal(packages[0].name, 'FixtureApp');
  assert.equal(packages[0].storageMode, 'file');
  assert.equal(packages[0].approved, false);

  const fetched = munkiRepo.getPackage(packages[0].id);
  assert.equal(fetched.name, 'FixtureApp');
});

test('listPackages marks a package approved when its name is in optional_installs', () => {
  const munkiRepo = freshRepoEnv();
  munkiRepo.ensureRepoScaffold();
  const repo = process.env.MUNKI_REPO_PATH;
  const plist = require('plist');
  fs.mkdirSync(path.join(repo, 'pkgsinfo', 'testing'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'pkgsinfo', 'testing', 'FixtureApp-1.0.plist'),
    plist.build({ name: 'FixtureApp', version: '1.0', category: 'testing', installer_item_location: 'x', installer_item_hash: 'a'.repeat(64) })
  );
  const manifestPath = path.join(repo, 'manifests', 'site_default');
  const manifest = plist.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.optional_installs.push('FixtureApp');
  fs.writeFileSync(manifestPath, plist.build(manifest));

  const [pkg] = munkiRepo.listPackages();
  assert.equal(pkg.approved, true);
});
