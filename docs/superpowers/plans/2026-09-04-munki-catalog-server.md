# Munki-Backed Catalog Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `munki-catalog-server/`, a new sibling service (next to `catalog-server/` and `client-mac/`, neither of which is touched) that replaces the custom SQLite package catalog with a Munki repo as the source of truth — supporting both stored `.pkg` files and metadata-only external-URL packages — while keeping Santa sync, DNS domain-blocking, device/install tracking, and the admin console.

**Architecture:** A Fastify app (same shape as `catalog-server`) with one new module, `src/munki-repo.js`, that shells out to the real `munkiimport`/`makecatalogs` binaries and reads/writes plain `pkginfo`/manifest plist files — no fork of Munki, no SQLite `packages` table. Everything else (Santa sync, DNS filter, IP whitelist, admin views) is a straight port, rewired to read from `munki-repo.js` instead of SQL.

**Tech Stack:** Node.js (CommonJS), Fastify 4, `@fastify/view` + EJS, `better-sqlite3`, `plist` (new dependency, for reading/writing Munki's plist files), `dns2`. Tests use Node's built-in `node:test` + `node:assert` (no new test framework — matches this repo's current lack of one).

**Spec:** `docs/superpowers/specs/2026-09-04-munki-catalog-server-design.md`

## Global Constraints

- Must run on macOS — `munkiimport`/`makecatalogs` are macOS-only binaries (spec, "Constraint: must run on macOS").
- Never modify `catalog-server/` or `client-mac/` — this is a parallel build (spec, Goal).
- One shared manifest, `site_default` — no per-device manifests (spec, Non-goals).
- Approval = self-serve (`optional_installs`), never force-installed (`managed_installs`) (spec, "Approval = manifest membership").
- `installer_item_hash` is mandatory on every package, uploaded or external — Santa's allow-list is built from it (spec, "Santa sync").
- New service gets its own SQLite file, no shared writes with `catalog-server`'s `catalog.db` (spec, "Data separation during the trial").
- No automatic install-check for external-URL packages beyond Munki's version comparison — documented simplification, not a bug to "fix" mid-plan (spec, "Known simplifications").

---

## Precondition (not a task — verify before starting)

Confirm the real Munki tools are present, since `munki-repo.js` shells out to them:

```bash
ls /usr/local/munki/munkiimport /usr/local/munki/makecatalogs /usr/local/munki/managedsoftwareupdate
```

If missing: `brew install --cask munki` (needs `sudo`, run in a real terminal — see `catalog-server`'s own README-equivalent trial notes for why).

---

### Task 1: Scaffold the service + ported database

**Files:**
- Create: `munki-catalog-server/package.json`
- Create: `munki-catalog-server/src/db.js`
- Create: `munki-catalog-server/.gitignore`
- Test: `munki-catalog-server/test/db.test.js`

**Interfaces:**
- Produces: `db.js` exports a `better-sqlite3` `Database` instance (`module.exports = db`), with tables `devices`, `install_events`, `santa_devices`, `santa_events`, `blocked_hashes`, `blocked_domains`. **Deviation from spec:** `install_events.package_id INTEGER` (which referenced the old `packages` table) becomes `install_events.package_name TEXT NOT NULL` — there is no integer package id in the Munki-backed world, packages are identified by their Munki `name` string. Every later task that touches `install_events` uses `package_name`.

- [ ] **Step 1: Create the package directory and `package.json`**

```json
{
  "name": "munki-catalog-server",
  "version": "0.1.0",
  "private": true,
  "description": "Munki-backed Software Center catalog + admin console",
  "type": "commonjs",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js",
    "dns-filter": "node src/dns-filter-server.js",
    "test": "node --test test/"
  },
  "dependencies": {
    "@fastify/formbody": "^7.4.0",
    "@fastify/multipart": "^8.3.0",
    "@fastify/view": "^9.1.0",
    "better-sqlite3": "^13.0.3",
    "dns2": "^3.1.1",
    "ejs": "^3.1.10",
    "fastify": "^4.28.1",
    "plist": "^5.0.0"
  }
}
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
data/
munki_repo/
```

(`munki_repo/` is generated at runtime by `ensureRepoScaffold()` in Task 2 — it's local state, not source, same reasoning as `catalog-server/data/catalog.db` not being committed.)

- [ ] **Step 3: Write `src/db.js`**

```js
const path = require('node:path');
const Database = require('better-sqlite3');

// Separate SQLite file from catalog-server's — no shared writes with the
// old system during the parallel-build/testing period (design spec,
// "Data separation during the trial").
const dbPath = path.join(__dirname, '..', 'data', 'catalog.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_uuid TEXT NOT NULL UNIQUE,
    hostname TEXT NOT NULL DEFAULT '',
    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- package_id (catalog-server) -> package_name: there is no integer
  -- package id anymore, Munki identifies packages by their `name` string.
  CREATE TABLE IF NOT EXISTS install_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_uuid TEXT NOT NULL,
    package_name TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

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

  CREATE TABLE IF NOT EXISTS blocked_hashes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256 TEXT NOT NULL UNIQUE,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS blocked_domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL UNIQUE,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

module.exports = db;
```

- [ ] **Step 4: Install dependencies**

```bash
cd munki-catalog-server && npm install
```

- [ ] **Step 5: Write the failing test**

```js
// munki-catalog-server/test/db.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('db.js creates all expected tables', () => {
  delete require.cache[require.resolve('../src/db')];
  const db = require('../src/db');
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, [
    'blocked_domains',
    'blocked_hashes',
    'devices',
    'install_events',
    'santa_devices',
    'santa_events',
  ]);
  // install_events uses package_name, not package_id
  const cols = db.prepare(`PRAGMA table_info(install_events)`).all().map((c) => c.name);
  assert.ok(cols.includes('package_name'));
  assert.ok(!cols.includes('package_id'));
});
```

- [ ] **Step 6: Run the test, expect it to pass immediately (db.js already correct)**

```bash
cd munki-catalog-server && npm test
```
Expected: PASS (this is a straight-line module, the "failing" state was "file doesn't exist yet").

- [ ] **Step 7: Commit**

```bash
git add munki-catalog-server/package.json munki-catalog-server/package-lock.json munki-catalog-server/.gitignore munki-catalog-server/src/db.js munki-catalog-server/test/db.test.js
git commit -m "Scaffold munki-catalog-server with ported SQLite schema"
```

---

### Task 2: `munki-repo.js` — repo scaffold + read path (list/get packages)

**Files:**
- Create: `munki-catalog-server/src/munki-repo.js`
- Test: `munki-catalog-server/test/munki-repo-read.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (standalone module).
- Produces (used by Tasks 3, 4, 5, 7):
  - `ensureRepoScaffold(): void` — creates repo subfolders + empty `site_default` manifest if missing.
  - `listPackages(): Array<PackageInfo>` — `PackageInfo = { id, name, displayName, version, category, description, developer, storageMode: 'file'|'external', sourceUrl: string|null, sha256, requires: string[], approved: boolean }`.
  - `getPackage(id: string): PackageInfo|null`
  - `idForRelPath(relPath: string): string` / `relPathForId(id: string): string` — base64url encode/decode of the `pkgsinfo`-relative path (without `.plist`), used as the admin route `:id`.

- [ ] **Step 1: Write the failing test**

```js
// munki-catalog-server/test/munki-repo-read.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd munki-catalog-server && npm test
```
Expected: FAIL with `Cannot find module '../src/munki-repo'`

- [ ] **Step 3: Write `src/munki-repo.js` (read path only)**

```js
const fs = require('node:fs');
const path = require('node:path');
const plist = require('plist');

function getRepoPath() {
  return process.env.MUNKI_REPO_PATH || path.join(__dirname, '..', 'munki_repo');
}

function getMunkiBinDir() {
  return process.env.MUNKI_BIN_DIR || '/usr/local/munki';
}

const MANIFEST_NAME = 'site_default';

function getPkgsinfoDir() {
  return path.join(getRepoPath(), 'pkgsinfo');
}

function getManifestPath() {
  return path.join(getRepoPath(), 'manifests', MANIFEST_NAME);
}

function ensureRepoScaffold() {
  const repo = getRepoPath();
  for (const dir of ['catalogs', 'manifests', 'pkgs', 'pkgsinfo', 'icons', 'client_resources']) {
    fs.mkdirSync(path.join(repo, dir), { recursive: true });
  }
  const manifestPath = getManifestPath();
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(
      manifestPath,
      plist.build({
        catalogs: [],
        included_manifests: [],
        managed_installs: [],
        managed_uninstalls: [],
        optional_installs: [],
      })
    );
  }
}

function idForRelPath(relPath) {
  return Buffer.from(relPath).toString('base64url');
}

function relPathForId(id) {
  return Buffer.from(id, 'base64url').toString('utf8');
}

function readManifest() {
  const manifestPath = getManifestPath();
  if (!fs.existsSync(manifestPath)) {
    return { catalogs: [], included_manifests: [], managed_installs: [], managed_uninstalls: [], optional_installs: [] };
  }
  return plist.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function writeManifest(manifest) {
  fs.writeFileSync(getManifestPath(), plist.build(manifest));
}

function listPkgsinfoFiles() {
  const results = [];
  const root = getPkgsinfoDir();
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.plist')) results.push(full);
    }
  }
  walk(root);
  return results;
}

function toPackageInfo(fullPath, manifest) {
  const relNoExt = path
    .relative(getPkgsinfoDir(), fullPath)
    .replace(/\.plist$/, '')
    .split(path.sep)
    .join('/');
  const data = plist.parse(fs.readFileSync(fullPath, 'utf8'));
  return {
    id: idForRelPath(relNoExt),
    name: data.name,
    displayName: data.display_name || data.name,
    version: data.version,
    category: data.category || 'Other',
    description: data.description || '',
    developer: data.developer || '',
    storageMode: data.PackageCompleteURL ? 'external' : 'file',
    sourceUrl: data.PackageCompleteURL || null,
    sha256: data.installer_item_hash || '',
    requires: data.requires || [],
    approved: (manifest.optional_installs || []).includes(data.name),
  };
}

function listPackages() {
  const manifest = readManifest();
  return listPkgsinfoFiles()
    .map((f) => toPackageInfo(f, manifest))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getPackage(id) {
  const relPath = relPathForId(id);
  const fullPath = path.join(getPkgsinfoDir(), `${relPath}.plist`);
  if (!fs.existsSync(fullPath)) return null;
  return toPackageInfo(fullPath, readManifest());
}

module.exports = {
  getRepoPath,
  getMunkiBinDir,
  ensureRepoScaffold,
  idForRelPath,
  relPathForId,
  readManifest,
  writeManifest,
  listPackages,
  getPackage,
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd munki-catalog-server && npm test
```
Expected: PASS (all 3 tests)

- [ ] **Step 5: Commit**

```bash
git add munki-catalog-server/src/munki-repo.js munki-catalog-server/test/munki-repo-read.test.js
git commit -m "Add munki-repo.js read path: list/get packages from pkgsinfo"
```

---

### Task 3: `munki-repo.js` — write path (`importFile`, `importExternal`)

**Files:**
- Modify: `munki-catalog-server/src/munki-repo.js`
- Test: `munki-catalog-server/test/munki-repo-import.test.js`

**Interfaces:**
- Consumes: `getRepoPath()`, `getMunkiBinDir()`, `ensureRepoScaffold()`, `idForRelPath()` from Task 2.
- Produces (used by Task 5):
  - `importFile({ filePath, name, displayName, version, category, description, developer, requires }): string` (returns the new package's `id`). Shells out to the real `munkiimport` binary — **this test needs a real `.pkg` built with `pkgbuild`, and needs `/usr/local/munki/munkiimport` present** (see Precondition).
  - `importExternal({ name, displayName, version, category, description, developer, sourceUrl, sha256, sizeBytes, requires }): string` (returns the new package's `id`). Pure Node, no shell-out — writes the pkginfo plist directly.

- [ ] **Step 1: Write the failing test**

```js
// munki-catalog-server/test/munki-repo-import.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd munki-catalog-server && npm test
```
Expected: FAIL with `munkiRepo.importFile is not a function`

- [ ] **Step 3: Add `importFile` and `importExternal` to `src/munki-repo.js`**

Add these requires at the top of the file:
```js
const { execFileSync } = require('node:child_process');
```

Add after `getPackage`:
```js
function sanitize(value) {
  return String(value).trim().replace(/[^a-zA-Z0-9._-]/g, '-');
}

function ensureCatalogInManifest(category) {
  const manifest = readManifest();
  if (!manifest.catalogs.includes(category)) {
    manifest.catalogs.push(category);
    writeManifest(manifest);
  }
}

function importFile({ filePath, name, displayName, version, category, description, developer, requires }) {
  ensureRepoScaffold();
  const cat = sanitize(category || 'Other');
  const args = [
    '--nointeractive',
    '--repo-url', `file://${getRepoPath()}`,
    '--subdirectory', cat,
    '--category', cat,
    '--name', name,
    '--displayname', displayName || name,
    '--description', description || '',
    '--developer', developer || '',
    filePath,
  ];
  const output = execFileSync(path.join(getMunkiBinDir(), 'munkiimport'), args, { encoding: 'utf8' });
  const match = output.match(/Saved pkginfo to pkgsinfo\/(.+)\.\s*$/m);
  if (!match) throw new Error(`munkiimport did not report a saved pkginfo:\n${output}`);
  const relPathWithExt = match[1];
  const fullPath = path.join(getPkgsinfoDir(), relPathWithExt);

  if (requires && requires.length) {
    const data = plist.parse(fs.readFileSync(fullPath, 'utf8'));
    data.requires = requires;
    fs.writeFileSync(fullPath, plist.build(data));
  }

  ensureCatalogInManifest(cat);
  return idForRelPath(relPathWithExt.replace(/\.plist$/, ''));
}

function importExternal({ name, displayName, version, category, description, developer, sourceUrl, sha256, sizeBytes, requires }) {
  ensureRepoScaffold();
  const cat = sanitize(category || 'Other');
  const fileBase = `${sanitize(name)}-${sanitize(version)}`;
  const dir = path.join(getPkgsinfoDir(), cat);
  fs.mkdirSync(dir, { recursive: true });
  const fullPath = path.join(dir, `${fileBase}.plist`);

  const data = {
    name,
    display_name: displayName || name,
    version,
    description: description || '',
    developer: developer || '',
    category: cat,
    catalogs: [cat],
    installer_item_location: `external/${fileBase}.pkg`,
    installer_item_hash: String(sha256).toLowerCase(),
    installer_item_size: Math.ceil(Number(sizeBytes) / 1024),
    PackageCompleteURL: sourceUrl,
  };
  if (requires && requires.length) data.requires = requires;

  fs.writeFileSync(fullPath, plist.build(data));
  ensureCatalogInManifest(cat);
  return idForRelPath(`${cat}/${fileBase}`);
}
```

Add `importFile` and `importExternal` to the `module.exports` object.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd munki-catalog-server && npm test
```
Expected: PASS (all tests, including the previous task's)

- [ ] **Step 5: Commit**

```bash
git add munki-catalog-server/src/munki-repo.js munki-catalog-server/test/munki-repo-import.test.js
git commit -m "Add munki-repo.js write path: importFile (munkiimport) and importExternal (metadata-only)"
```

---

### Task 4: `munki-repo.js` — approve/revoke (manifest membership + makecatalogs)

**Files:**
- Modify: `munki-catalog-server/src/munki-repo.js`
- Test: `munki-catalog-server/test/munki-repo-approve.test.js`

**Interfaces:**
- Consumes: `readManifest`, `writeManifest`, `getPackage`, `getMunkiBinDir`, `getRepoPath` from Tasks 2–3.
- Produces (used by Tasks 5, 7): `approve(id: string): void`, `revoke(id: string): void`. Both call the real `makecatalogs` binary.

- [ ] **Step 1: Write the failing test**

```js
// munki-catalog-server/test/munki-repo-approve.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd munki-catalog-server && npm test
```
Expected: FAIL with `munkiRepo.approve is not a function`

- [ ] **Step 3: Add `approve`/`revoke` to `src/munki-repo.js`**

```js
function runMakeCatalogs() {
  execFileSync(path.join(getMunkiBinDir(), 'makecatalogs'), [getRepoPath()], { stdio: 'pipe' });
}

function approve(id) {
  const pkg = getPackage(id);
  if (!pkg) throw new Error(`package not found: ${id}`);
  const manifest = readManifest();
  if (!manifest.optional_installs.includes(pkg.name)) {
    manifest.optional_installs.push(pkg.name);
    writeManifest(manifest);
  }
  runMakeCatalogs();
}

function revoke(id) {
  const pkg = getPackage(id);
  if (!pkg) throw new Error(`package not found: ${id}`);
  const manifest = readManifest();
  manifest.optional_installs = manifest.optional_installs.filter((n) => n !== pkg.name);
  writeManifest(manifest);
  runMakeCatalogs();
}
```

Add `approve` and `revoke` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd munki-catalog-server && npm test
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add munki-catalog-server/src/munki-repo.js munki-catalog-server/test/munki-repo-approve.test.js
git commit -m "Add munki-repo.js approve/revoke: manifest membership + makecatalogs"
```

---

### Task 5: `ip-whitelist.js` port + `server.js` bootstrap + package admin routes/views

**Files:**
- Create: `munki-catalog-server/src/ip-whitelist.js` (straight copy)
- Create: `munki-catalog-server/src/server.js`
- Create: `munki-catalog-server/views/_layout_top.ejs`, `_layout_bottom.ejs`
- Create: `munki-catalog-server/views/packages.ejs` (adapted: storage mode + requires columns)
- Create: `munki-catalog-server/views/package-new.ejs` (adapted: two storage modes + requires field)
- Test: `munki-catalog-server/test/server-packages.test.js`

**Interfaces:**
- Consumes: `munkiRepo.listPackages/getPackage/importFile/importExternal/approve/revoke` (Tasks 2–4).
- Produces: a running Fastify app on `process.env.PORT || 3100`, routes `GET/POST /admin/packages*`.

- [ ] **Step 1: Copy `ip-whitelist.js` unchanged**

```bash
cp catalog-server/src/ip-whitelist.js munki-catalog-server/src/ip-whitelist.js
```

- [ ] **Step 2: Write `views/_layout_top.ejs`** (copy of `catalog-server`'s, nav trimmed to what this service has so far — devices/santa/blocklist/domains links are added back in Tasks 6–7)

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Munki Catalog Admin</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f6f8; color: #1a1a2e; margin: 0; }
  header { background: #1a1a2e; color: #fff; padding: 14px 24px; display: flex; align-items: center; gap: 20px; }
  header .brand { font-weight: 700; font-size: 15px; }
  header nav a { color: #cbd5e1; text-decoration: none; font-size: 13px; margin-right: 16px; }
  header nav a:hover { color: #fff; }
  main { max-width: 960px; margin: 24px auto; padding: 0 16px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  th, td { text-align: left; padding: 10px 12px; font-size: 13px; border-bottom: 1px solid #eef0f2; }
  th { background: #f8fafc; text-transform: uppercase; font-size: 10.5px; letter-spacing: .5px; color: #6b7280; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10.5px; font-weight: 700; }
  .badge.yes { background: #dcfce7; color: #166534; }
  .badge.no { background: #fee2e2; color: #991b1b; }
  .btn { display: inline-block; padding: 5px 10px; border-radius: 6px; font-size: 11.5px; font-weight: 600; border: none; cursor: pointer; text-decoration: none; }
  .btn.approve { background: #059669; color: #fff; }
  .btn.revoke { background: #dc2626; color: #fff; }
  .btn.primary { background: #2563eb; color: #fff; }
  .card { background: #fff; border-radius: 10px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .stats { display: flex; gap: 12px; margin-bottom: 20px; }
  .stat { flex: 1; background: #fff; border-radius: 10px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .stat .n { font-size: 22px; font-weight: 800; }
  .stat .l { font-size: 11px; color: #6b7280; }
  form.upload label { display: block; font-size: 12px; font-weight: 600; margin: 10px 0 4px; }
  form.upload input, form.upload textarea, form.upload select { width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; }
  .mode-toggle { display: flex; gap: 8px; margin: 10px 0; }
  .mode-toggle label { display: flex; align-items: center; gap: 4px; font-weight: 400; }
</style>
</head>
<body>
<header>
  <div class="brand">🛒 Munki Catalog — Admin</div>
  <nav>
    <a href="/admin">Dashboard</a>
    <a href="/admin/packages">Packages</a>
    <a href="/admin/devices">Devices</a>
    <a href="/admin/santa">Santa</a>
    <a href="/admin/blocklist">Blocklist</a>
    <a href="/admin/domains">Domains</a>
  </nav>
</header>
<main>
```

- [ ] **Step 3: Write `views/_layout_bottom.ejs`**

```html
</main>
</body>
</html>
```

- [ ] **Step 4: Write `views/packages.ejs`**

```html
<%- include('_layout_top') %>

<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
  <h3 style="margin:0;font-size:15px;">Packages</h3>
  <a class="btn primary" href="/admin/packages/new">+ Add package</a>
</div>

<table>
  <tr><th>App</th><th>Version</th><th>Category</th><th>Storage</th><th>Requires</th><th>Approved</th><th>SHA-256</th><th></th></tr>
  <% if (packages.length === 0) { %>
    <tr><td colspan="8" style="color:#9ca3af;">No packages yet.</td></tr>
  <% } %>
  <% packages.forEach(function(p) { %>
    <tr>
      <td><strong><%= p.name %></strong><br><span style="color:#6b7280;font-size:11.5px;"><%= p.description %></span></td>
      <td><%= p.version %></td>
      <td><%= p.category %></td>
      <td><%= p.storageMode === 'external' ? 'External URL' : 'File' %></td>
      <td><%= p.requires.length ? p.requires.join(', ') : '—' %></td>
      <td><span class="badge <%= p.approved ? 'yes' : 'no' %>"><%= p.approved ? 'Approved' : 'Pending' %></span></td>
      <td style="font-family:monospace;font-size:10px;color:#6b7280;"><%= p.sha256.slice(0, 12) %>…</td>
      <td>
        <% if (p.approved) { %>
          <form method="post" action="/admin/packages/<%= p.id %>/revoke" style="display:inline;">
            <button class="btn revoke" type="submit">Revoke</button>
          </form>
        <% } else { %>
          <form method="post" action="/admin/packages/<%= p.id %>/approve" style="display:inline;">
            <button class="btn approve" type="submit">Approve</button>
          </form>
        <% } %>
      </td>
    </tr>
  <% }) %>
</table>

<%- include('_layout_bottom') %>
```

- [ ] **Step 5: Write `views/package-new.ejs`**

```html
<%- include('_layout_top') %>

<div class="card">
  <h3 style="margin-top:0;font-size:15px;">Add a package</h3>
  <p style="font-size:12px;color:#6b7280;">Store the actual installer, or point at where the vendor already hosts it (metadata-only — no file kept on this server). It lands as <strong>Pending</strong> until explicitly approved.</p>

  <form class="upload" method="post" action="/admin/packages" enctype="multipart/form-data" onsubmit="return true;">
    <div class="mode-toggle">
      <label><input type="radio" name="mode" value="file" checked onclick="toggleMode('file')"> Upload file</label>
      <label><input type="radio" name="mode" value="external" onclick="toggleMode('external')"> External URL</label>
    </div>

    <label>App name</label>
    <input type="text" name="name" placeholder="Docker Desktop" required>

    <label>Display name</label>
    <input type="text" name="display_name" placeholder="Docker Desktop">

    <label>Version</label>
    <input type="text" name="version" placeholder="4.34.0" required>

    <label>Category</label>
    <input type="text" name="category" placeholder="Developer Tools">

    <label>Developer</label>
    <input type="text" name="developer" placeholder="Docker Inc">

    <label>Description</label>
    <textarea name="description" rows="2" placeholder="What it's for, in one line"></textarea>

    <label>Requires (comma-separated package names, optional — e.g. a shared library this app needs first)</label>
    <input type="text" name="requires" placeholder="SomeSharedLibrary">

    <div id="file-fields">
      <label>Installer file (.pkg / .dmg)</label>
      <input type="file" name="file">
    </div>

    <div id="external-fields" style="display:none;">
      <label>Source URL</label>
      <input type="text" name="source_url" placeholder="https://vendor.example.com/App-1.0.pkg">

      <label>SHA-256 (64 hex characters)</label>
      <input type="text" name="sha256" placeholder="64-character hex hash" pattern="[0-9a-fA-F]{64}">

      <label>File size (bytes)</label>
      <input type="text" name="size_bytes" placeholder="52428800">
    </div>

    <div style="margin-top:16px;">
      <button class="btn primary" type="submit">Add package</button>
    </div>
  </form>
</div>

<script>
function toggleMode(mode) {
  document.getElementById('file-fields').style.display = mode === 'file' ? 'block' : 'none';
  document.getElementById('external-fields').style.display = mode === 'external' ? 'block' : 'none';
  document.querySelector('input[name="file"]').required = mode === 'file';
  document.querySelector('input[name="source_url"]').required = mode === 'external';
  document.querySelector('input[name="sha256"]').required = mode === 'external';
  document.querySelector('input[name="size_bytes"]').required = mode === 'external';
}
</script>

<%- include('_layout_bottom') %>
```

- [ ] **Step 6: Write `src/server.js` (bootstrap + package routes only — devices/santa/blocklist/domains added in Tasks 6–7)**

```js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const Fastify = require('fastify');
const view = require('@fastify/view');
const multipart = require('@fastify/multipart');
const formbody = require('@fastify/formbody');
const ejs = require('ejs');
const db = require('./db');
const munkiRepo = require('./munki-repo');
const { isWhitelisted } = require('./ip-whitelist');

const PORT = process.env.PORT || 3100;
const HOST = process.env.HOST || '127.0.0.1';

munkiRepo.ensureRepoScaffold();

const app = Fastify({ logger: true, trustProxy: true });

app.register(view, {
  engine: { ejs },
  root: path.join(__dirname, '..', 'views'),
});
app.register(formbody);
app.register(multipart, {
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

if (process.env.FORCE_HTTPS === '1') {
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers['x-forwarded-proto'] === 'https') return;
    app.log.warn(`blocked plain-http request to ${req.raw.url}`);
    reply.code(403).send('Forbidden: HTTPS required.');
  });
}

app.addHook('onRequest', async (req, reply) => {
  if (!req.raw.url.startsWith('/admin')) return;
  if (isWhitelisted(req.ip)) return;
  app.log.warn(`blocked admin access from ${req.ip}`);
  reply.code(403).send('Forbidden: this IP is not whitelisted for admin access.');
});

app.get('/admin/packages', async (_req, reply) => {
  const packages = munkiRepo.listPackages();
  return reply.view('packages.ejs', { packages });
});

app.get('/admin/packages/new', async (_req, reply) => {
  return reply.view('package-new.ejs', {});
});

app.post('/admin/packages', async (req, reply) => {
  const parts = req.parts();
  const fields = {};
  let tmpFilePath = null;

  for await (const part of parts) {
    if (part.type === 'file') {
      if (!part.filename) continue;
      const ext = path.extname(part.filename) || '.pkg';
      tmpFilePath = path.join(os.tmpdir(), `upload-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
      const writeStream = fs.createWriteStream(tmpFilePath);
      for await (const chunk of part.file) writeStream.write(chunk);
      await new Promise((resolve, reject) => {
        writeStream.end((err) => (err ? reject(err) : resolve()));
      });
    } else {
      fields[part.fieldname] = part.value;
    }
  }

  const requires = fields.requires
    ? fields.requires.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  if (fields.mode === 'external') {
    if (!fields.name || !fields.version || !fields.source_url || !fields.sha256 || !fields.size_bytes) {
      return reply.code(400).send({ error: 'name, version, source_url, sha256, and size_bytes are required for external packages' });
    }
    munkiRepo.importExternal({
      name: fields.name,
      displayName: fields.display_name,
      version: fields.version,
      category: fields.category,
      description: fields.description,
      developer: fields.developer,
      sourceUrl: fields.source_url,
      sha256: fields.sha256,
      sizeBytes: fields.size_bytes,
      requires,
    });
  } else {
    if (!tmpFilePath || !fields.name || !fields.version) {
      if (tmpFilePath) fs.unlinkSync(tmpFilePath);
      return reply.code(400).send({ error: 'name, version, and a file are required' });
    }
    munkiRepo.importFile({
      filePath: tmpFilePath,
      name: fields.name,
      displayName: fields.display_name,
      version: fields.version,
      category: fields.category,
      description: fields.description,
      developer: fields.developer,
      requires,
    });
    fs.unlinkSync(tmpFilePath);
  }

  return reply.redirect('/admin/packages');
});

app.post('/admin/packages/:id/approve', async (req, reply) => {
  munkiRepo.approve(req.params.id);
  return reply.redirect('/admin/packages');
});

app.post('/admin/packages/:id/revoke', async (req, reply) => {
  munkiRepo.revoke(req.params.id);
  return reply.redirect('/admin/packages');
});

app.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Munki catalog server listening at ${address}`);
});

module.exports = app;
```

- [ ] **Step 7: Write the test (starts the app with `.inject()`, no real network port)**

```js
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
    payload: {
      mode: 'external',
      name: 'ServerTestApp',
      version: '1.0',
      category: 'Testing',
      source_url: 'https://vendor.example.com/ServerTestApp-1.0.pkg',
      sha256: 'c'.repeat(64),
      size_bytes: '1000',
    },
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
```

- [ ] **Step 8: Run test, fix and re-run until it passes**

```bash
cd munki-catalog-server && npm test
```
Expected: PASS. (If Fastify's `app.listen` inside `server.js` throws in the test process because `PORT=0` collides with a prior run, wrap `app.listen` — leave it as-is; `node:test` runs this file in its own process so a real bind on an ephemeral port is fine.)

- [ ] **Step 9: Commit**

```bash
git add munki-catalog-server/src/ip-whitelist.js munki-catalog-server/src/server.js munki-catalog-server/views/_layout_top.ejs munki-catalog-server/views/_layout_bottom.ejs munki-catalog-server/views/packages.ejs munki-catalog-server/views/package-new.ejs munki-catalog-server/test/server-packages.test.js
git commit -m "Add server.js bootstrap + package admin routes (upload/external modes, approve/revoke)"
```

---

### Task 6: Dashboard, devices, blocklist, domains — ported unchanged

**Files:**
- Create: `munki-catalog-server/views/dashboard.ejs`, `devices.ejs`, `blocklist.ejs`, `domains.ejs`
- Modify: `munki-catalog-server/src/server.js` (add routes)
- Test: `munki-catalog-server/test/server-blocklist-domains.test.js`

**Interfaces:**
- Consumes: `db` (Task 1), `munkiRepo.listPackages` (Task 2).
- Produces: `GET /admin`, `GET /admin/devices`, `GET/POST /admin/blocklist`, `POST /admin/blocklist/:id/remove`, `GET/POST /admin/domains`, `POST /admin/domains/:id/remove`.

- [ ] **Step 1: Copy the four view files unchanged**

```bash
cp catalog-server/views/devices.ejs munki-catalog-server/views/devices.ejs
cp catalog-server/views/blocklist.ejs munki-catalog-server/views/blocklist.ejs
cp catalog-server/views/domains.ejs munki-catalog-server/views/domains.ejs
```

- [ ] **Step 2: Write `views/dashboard.ejs` (adapted — `recentEvents` no longer joins a `packages` table)**

```html
<%- include('_layout_top') %>

<div class="stats">
  <div class="stat"><div class="n"><%= counts.packages %></div><div class="l">Packages in repo</div></div>
  <div class="stat"><div class="n"><%= counts.approved %></div><div class="l">Approved (visible to employees)</div></div>
  <div class="stat"><div class="n"><%= counts.devices %></div><div class="l">Enrolled devices</div></div>
</div>

<div class="card">
  <h3 style="margin-top:0;font-size:14px;">Recent install events</h3>
  <table>
    <tr><th>Device</th><th>Package</th><th>Status</th><th>When</th></tr>
    <% if (recentEvents.length === 0) { %>
      <tr><td colspan="4" style="color:#9ca3af;">No install events reported yet.</td></tr>
    <% } %>
    <% recentEvents.forEach(function(e) { %>
      <tr>
        <td><%= e.device_uuid %></td>
        <td><%= e.package_name %></td>
        <td><%= e.status %></td>
        <td><%= e.created_at %></td>
      </tr>
    <% }) %>
  </table>
</div>

<%- include('_layout_bottom') %>
```

- [ ] **Step 3: Add routes to `src/server.js`** (insert above `app.listen`, after the package routes from Task 5)

```js
app.get('/admin', async (_req, reply) => {
  const packages = munkiRepo.listPackages();
  const counts = {
    packages: packages.length,
    approved: packages.filter((p) => p.approved).length,
    devices: db.prepare(`SELECT COUNT(*) c FROM devices`).get().c,
  };
  const recentEvents = db
    .prepare(`SELECT * FROM install_events ORDER BY created_at DESC LIMIT 20`)
    .all();
  return reply.view('dashboard.ejs', { counts, recentEvents });
});

app.get('/admin/devices', async (_req, reply) => {
  const devices = db.prepare(`SELECT * FROM devices ORDER BY last_seen DESC`).all();
  return reply.view('devices.ejs', { devices });
});

app.get('/admin/blocklist', async (_req, reply) => {
  const blocked = db.prepare(`SELECT * FROM blocked_hashes ORDER BY created_at DESC`).all();
  return reply.view('blocklist.ejs', { blocked });
});

app.post('/admin/blocklist', async (req, reply) => {
  const { sha256, reason } = req.body || {};
  const normalized = (sha256 || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    return reply.code(400).send({ error: 'sha256 must be a 64-character hex string' });
  }
  db.prepare(
    `INSERT INTO blocked_hashes (sha256, reason) VALUES (?, ?)
     ON CONFLICT(sha256) DO UPDATE SET reason = excluded.reason`
  ).run(normalized, reason || '');
  return reply.redirect('/admin/blocklist');
});

app.post('/admin/blocklist/:id/remove', async (req, reply) => {
  db.prepare(`DELETE FROM blocked_hashes WHERE id = ?`).run(req.params.id);
  return reply.redirect('/admin/blocklist');
});

app.get('/admin/domains', async (_req, reply) => {
  const domains = db.prepare(`SELECT * FROM blocked_domains ORDER BY created_at DESC`).all();
  return reply.view('domains.ejs', { domains });
});

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

function extractHostname(input) {
  const trimmed = (input || '').trim();
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    try {
      return new URL(`http://${trimmed}`).hostname.toLowerCase();
    } catch {
      return trimmed.toLowerCase();
    }
  }
}

app.post('/admin/domains', async (req, reply) => {
  const { domain, reason } = req.body || {};
  const normalized = extractHostname(domain).replace(/\.$/, '');
  if (!DOMAIN_RE.test(normalized)) {
    return reply.code(400).send({ error: 'not a valid domain name' });
  }
  db.prepare(
    `INSERT INTO blocked_domains (domain, reason) VALUES (?, ?)
     ON CONFLICT(domain) DO UPDATE SET reason = excluded.reason`
  ).run(normalized, reason || '');
  return reply.redirect('/admin/domains');
});

app.post('/admin/domains/:id/remove', async (req, reply) => {
  db.prepare(`DELETE FROM blocked_domains WHERE id = ?`).run(req.params.id);
  return reply.redirect('/admin/domains');
});
```

- [ ] **Step 4: Write the test**

```js
// munki-catalog-server/test/server-blocklist-domains.test.js
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
    payload: { sha256: 'd'.repeat(64), reason: 'bad binary' },
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(addHash.statusCode, 302);

  const blocklistPage = await app.inject({ method: 'GET', url: '/admin/blocklist' });
  assert.match(blocklistPage.body, /bad binary/);

  const addDomain = await app.inject({
    method: 'POST',
    url: '/admin/domains',
    payload: { domain: 'https://malware.example.com/path', reason: 'phishing' },
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(addDomain.statusCode, 302);

  const domainsPage = await app.inject({ method: 'GET', url: '/admin/domains' });
  assert.match(domainsPage.body, /malware\.example\.com/);

  const dashboard = await app.inject({ method: 'GET', url: '/admin' });
  assert.equal(dashboard.statusCode, 200);

  await app.close();
});
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd munki-catalog-server && npm test
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add munki-catalog-server/views/dashboard.ejs munki-catalog-server/views/devices.ejs munki-catalog-server/views/blocklist.ejs munki-catalog-server/views/domains.ejs munki-catalog-server/src/server.js munki-catalog-server/test/server-blocklist-domains.test.js
git commit -m "Port dashboard, devices, blocklist, and domains admin pages"
```

---

### Task 7: Santa sync — ported to read from `munki-repo.js`

**Files:**
- Create: `munki-catalog-server/src/santa-sync.js`
- Create: `munki-catalog-server/views/santa.ejs` (copy, unchanged)
- Modify: `munki-catalog-server/src/server.js` (register santa-sync, add `/admin/santa` route)
- Test: `munki-catalog-server/test/santa-sync.test.js`

**Interfaces:**
- Consumes: `munkiRepo.listPackages()` (Task 2), `db` (Task 1).
- Produces: `POST /preflight/:machine_id`, `POST /eventupload/:machine_id`, `POST /ruledownload/:machine_id`, `POST /postflight/:machine_id`.

- [ ] **Step 1: Copy `santa.ejs` unchanged**

```bash
cp catalog-server/views/santa.ejs munki-catalog-server/views/santa.ejs
```

- [ ] **Step 2: Write `src/santa-sync.js`**

```js
// Ported from catalog-server/src/santa-sync.js. Only ruledownload's data
// source changed: pkgsinfo (via munki-repo.js) instead of the packages
// SQL table. Same known simplification as the original: installer_item_hash
// is the .pkg's hash, not the installed binary's — real follow-up work,
// not addressed here (design spec, "Santa sync").
const db = require('./db');
const munkiRepo = require('./munki-repo');

const SANTA_CLIENT_MODE = process.env.SANTA_CLIENT_MODE === 'LOCKDOWN' ? 'LOCKDOWN' : 'MONITOR';

async function santaSyncRoutes(app) {
  app.post('/preflight/:machine_id', async (req, reply) => {
    const { machine_id } = req.params;
    const body = req.body || {};
    db.prepare(
      `INSERT INTO santa_devices (machine_id, hostname, serial_num, santa_version, client_mode)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(machine_id) DO UPDATE SET
         hostname = excluded.hostname,
         serial_num = excluded.serial_num,
         santa_version = excluded.santa_version,
         client_mode = excluded.client_mode,
         last_seen = datetime('now')`
    ).run(machine_id, body.hostname || '', body.serial_num || '', body.santa_version || '', body.client_mode || '');

    reply.send({
      client_mode: SANTA_CLIENT_MODE,
      sync_type: body.request_clean_sync ? 'CLEAN' : 'NORMAL',
      batch_size: 100,
      full_sync_interval: 600,
      enable_bundles: false,
      enable_transitive_rules: false,
    });
  });

  app.post('/eventupload/:machine_id', async (req, reply) => {
    const { machine_id } = req.params;
    const events = (req.body && req.body.events) || [];
    const insert = db.prepare(
      `INSERT INTO santa_events (machine_id, file_sha256, file_path, file_name, decision, executing_user)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertMany = db.transaction((rows) => {
      for (const e of rows) {
        insert.run(machine_id, e.file_sha256 || '', e.file_path || '', e.file_name || '', e.decision || '', e.executing_user || '');
      }
    });
    insertMany(events);
    reply.send({});
  });

  app.post('/ruledownload/:machine_id', async (req, reply) => {
    const packages = munkiRepo.listPackages().filter((p) => p.sha256);
    const approved = packages.filter((p) => p.approved);
    const notApproved = packages.filter((p) => !p.approved);
    const blocked = db.prepare(`SELECT sha256, reason FROM blocked_hashes`).all();
    const rules = [
      ...approved.map((pkg) => ({
        identifier: pkg.sha256,
        rule_type: 'BINARY',
        policy: 'ALLOWLIST',
      })),
      ...notApproved.map((pkg) => ({
        identifier: pkg.sha256,
        rule_type: 'BINARY',
        policy: 'REMOVE',
      })),
      ...blocked.map((b) => ({
        identifier: b.sha256,
        rule_type: 'BINARY',
        policy: 'BLOCKLIST',
        custom_msg: b.reason || undefined,
      })),
    ];
    reply.send({ rules });
  });

  app.post('/postflight/:machine_id', async (_req, reply) => {
    reply.send({});
  });
}

module.exports = santaSyncRoutes;
```

- [ ] **Step 3: Register it and add the `/admin/santa` route in `src/server.js`**

Add near the top, right after the `app` is created and view/formbody/multipart are registered (before the `FORCE_HTTPS` hook, matching `catalog-server`'s ordering):
```js
app.register(require('./santa-sync'));
```

Add alongside the other `/admin/*` GET routes:
```js
app.get('/admin/santa', async (_req, reply) => {
  const santaDevices = db.prepare(`SELECT * FROM santa_devices ORDER BY last_seen DESC`).all();
  const santaEvents = db.prepare(`SELECT * FROM santa_events ORDER BY created_at DESC LIMIT 50`).all();
  return reply.view('santa.ejs', { santaDevices, santaEvents });
});
```

- [ ] **Step 4: Write the test**

```js
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
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd munki-catalog-server && npm test
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add munki-catalog-server/src/santa-sync.js munki-catalog-server/views/santa.ejs munki-catalog-server/src/server.js munki-catalog-server/test/santa-sync.test.js
git commit -m "Port Santa sync: ruledownload now reads pkgsinfo via munki-repo.js"
```

---

### Task 8: DNS domain-blocking (`dns-filter-server.js`) — ported unchanged

**Files:**
- Create: `munki-catalog-server/src/dns-filter-server.js` (copy, unchanged)
- Test: `munki-catalog-server/test/dns-filter.test.js`

**Interfaces:**
- Consumes: `db` (Task 1) — reads `blocked_domains` directly, same as `catalog-server`'s version.
- Produces: a standalone process bound to UDP port `process.env.DNS_FILTER_PORT || 53`.

- [ ] **Step 1: Copy the file unchanged**

```bash
cp catalog-server/src/dns-filter-server.js munki-catalog-server/src/dns-filter-server.js
```

(Its `require('./db')` resolves to `munki-catalog-server/src/db.js` automatically since it's a relative path — no edit needed.)

- [ ] **Step 2: Write a test that exercises the blocking logic directly (no root/port-53 bind needed for the test)**

```js
// munki-catalog-server/test/dns-filter.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('blocked_domains rows make isBlocked-equivalent logic return true', () => {
  process.env.MUNKI_REPO_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'munki-repo-dns-test-'));
  delete require.cache[require.resolve('../src/db')];
  const db = require('../src/db');

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
```

- [ ] **Step 3: Run test to verify it passes**

```bash
cd munki-catalog-server && npm test
```
Expected: PASS

- [ ] **Step 4: Manual verification (not part of automated tests — needs `sudo` and a real port bind, same as `catalog-server`'s DNS filter)**

```bash
sudo node munki-catalog-server/src/dns-filter-server.js
# in another terminal:
dig @127.0.0.1 malware.example.com
# expect NXDOMAIN once a matching row exists in munki-catalog-server/data/catalog.db
```

- [ ] **Step 5: Commit**

```bash
git add munki-catalog-server/src/dns-filter-server.js munki-catalog-server/test/dns-filter.test.js
git commit -m "Port DNS domain-blocking sinkhole, unchanged behavior"
```

---

### Task 9: Postflight script + device/install-event endpoints

**Files:**
- Create: `munki-catalog-server/scripts/postflight`
- Modify: `munki-catalog-server/src/server.js` (add `/api/devices/checkin`, `/api/install-events`)
- Test: `munki-catalog-server/test/server-api.test.js`

**Interfaces:**
- Consumes: `db` (Task 1).
- Produces: `POST /api/devices/checkin`, `POST /api/install-events` — called by the postflight script on every enrolled Mac, not by any browser.

- [ ] **Step 1: Add the two routes to `src/server.js`** (near the top, right after `app.register(require('./santa-sync'))`, matching `catalog-server`'s original placement of these two client-facing routes)

```js
app.post('/api/devices/checkin', async (req, reply) => {
  const { device_uuid, hostname } = req.body || {};
  if (!device_uuid) return reply.code(400).send({ error: 'device_uuid required' });
  db.prepare(
    `INSERT INTO devices (device_uuid, hostname) VALUES (?, ?)
     ON CONFLICT(device_uuid) DO UPDATE SET hostname = excluded.hostname, last_seen = datetime('now')`
  ).run(device_uuid, hostname || '');
  reply.send({ ok: true });
});

app.post('/api/install-events', async (req, reply) => {
  const { device_uuid, package_name, status } = req.body || {};
  if (!device_uuid || !package_name || !status) {
    return reply.code(400).send({ error: 'device_uuid, package_name, status required' });
  }
  db.prepare(
    `INSERT INTO install_events (device_uuid, package_name, status) VALUES (?, ?, ?)`
  ).run(device_uuid, package_name, status);
  reply.send({ ok: true });
});
```

- [ ] **Step 2: Write the test**

```js
// munki-catalog-server/test/server-api.test.js
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
```

- [ ] **Step 3: Run test to verify it passes**

```bash
cd munki-catalog-server && npm test
```
Expected: PASS

- [ ] **Step 4: Write `scripts/postflight`**

```bash
#!/bin/bash
# Munki postflight script — reports device check-in and install results
# back to munki-catalog-server's admin dashboard (design spec, "Device
# and install-event tracking"). Munki runs any executable file it finds
# at /usr/local/munki/postflight after every managedsoftwareupdate run.
#
# Install:
#   sudo cp scripts/postflight /usr/local/munki/postflight
#   sudo chmod +x /usr/local/munki/postflight
set -uo pipefail

CATALOG_SERVER_URL="${CATALOG_SERVER_URL:-http://127.0.0.1:3100}"
DEVICE_UUID=$(/usr/sbin/ioreg -d2 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/{print $4}')
HOSTNAME=$(/usr/sbin/scutil --get ComputerName 2>/dev/null || hostname)
REPORT="/Library/Managed Installs/ManagedInstallReport.plist"

curl -s -X POST "$CATALOG_SERVER_URL/api/devices/checkin" \
  -H "Content-Type: application/json" \
  -d "{\"device_uuid\":\"$DEVICE_UUID\",\"hostname\":\"$HOSTNAME\"}" >/dev/null 2>&1 || true

if [ -f "$REPORT" ]; then
  /usr/bin/plutil -convert json -o - "$REPORT" 2>/dev/null | /usr/bin/python3 -c '
import json, sys, subprocess

data = json.load(sys.stdin)
device_uuid = "'"$DEVICE_UUID"'"
url = "'"$CATALOG_SERVER_URL"'" + "/api/install-events"

def report(name, status):
    subprocess.run(
        ["curl", "-s", "-X", "POST", url,
         "-H", "Content-Type: application/json",
         "-d", json.dumps({"device_uuid": device_uuid, "package_name": name, "status": status})],
        check=False,
    )

for name in data.get("InstalledItems", []):
    report(name, "installed")
for name in data.get("ItemsToRemove", []):
    report(name, "removed")
' || true
fi

exit 0
```

- [ ] **Step 5: Make it executable and commit**

```bash
chmod +x munki-catalog-server/scripts/postflight
git add munki-catalog-server/src/server.js munki-catalog-server/scripts/postflight munki-catalog-server/test/server-api.test.js
git commit -m "Add device checkin/install-event API routes and Munki postflight script"
```

---

### Task 10: End-to-end smoke test + README

**Files:**
- Create: `munki-catalog-server/README.md`
- Test: manual, run once by hand (see steps below — this is the whole-system check, not another `node:test` file)

**Interfaces:**
- Consumes: everything built in Tasks 1–9.
- Produces: confidence the whole chain works — admin upload → approve → Munki client sees it → Santa allow-lists it.

- [ ] **Step 1: Write `README.md`**

```markdown
# munki-catalog-server

A Munki-backed replacement for `catalog-server` + `client-mac`. See
`../docs/superpowers/specs/2026-09-04-munki-catalog-server-design.md`
for the full design.

## Run it

```bash
npm install
MUNKI_REPO_PATH="$HOME/munki_repo" PORT=3100 npm start
```

Runs on port 3100 by default so it can run alongside `catalog-server`
(port 3000) during the parallel-testing period.

## Point a Mac's Munki client at this repo

```bash
sudo defaults write /Library/Preferences/ManagedInstalls SoftwareRepoURL "file://$HOME/munki_repo"
sudo defaults write /Library/Preferences/ManagedInstalls ClientIdentifier "site_default"
```

## Point Santa at this server

Configure Santa's sync URL (via its config profile or
`com.northpolesec.santa`/`com.google.santa` preferences, depending on
which Santa build is installed) to `http://<this-host>:3100/`.

## Install the postflight script (device/install-event tracking)

```bash
sudo cp scripts/postflight /usr/local/munki/postflight
sudo chmod +x /usr/local/munki/postflight
```

## Admin console

http://127.0.0.1:3100/admin (subject to `ADMIN_IP_WHITELIST`, same
default-deny-except-localhost behavior as `catalog-server`).
```

- [ ] **Step 2: Run the full automated suite one more time**

```bash
cd munki-catalog-server && npm test
```
Expected: PASS (all tasks' tests)

- [ ] **Step 3: Manual end-to-end smoke test**

```bash
# 1. Start the service against a fresh repo
export MUNKI_REPO_PATH="$HOME/munki-catalog-server-smoke-test"
rm -rf "$MUNKI_REPO_PATH"
PORT=3100 node munki-catalog-server/src/server.js &

# 2. Build a real test package
WORK=/tmp/smoke-test-pkg
rm -rf "$WORK"; mkdir -p "$WORK/payload/Applications/SmokeTestApp"
echo "hello" > "$WORK/payload/Applications/SmokeTestApp/readme.txt"
pkgbuild --root "$WORK/payload" --identifier com.example.smoketestapp --version 1.0 \
  --install-location / "$WORK/SmokeTestApp-1.0.pkg"

# 3. Upload it through the real admin form (multipart), then approve it —
#    replace <id> with the id shown at http://127.0.0.1:3100/admin/packages
curl -F "mode=file" -F "name=SmokeTestApp" -F "version=1.0" -F "category=Testing" \
  -F "file=@$WORK/SmokeTestApp-1.0.pkg" http://127.0.0.1:3100/admin/packages
open http://127.0.0.1:3100/admin/packages   # click Approve

# 4. Point the real Munki client at this repo and confirm it sees the item
sudo defaults write /Library/Preferences/ManagedInstalls SoftwareRepoURL "file://$MUNKI_REPO_PATH"
sudo defaults write /Library/Preferences/ManagedInstalls ClientIdentifier "site_default"
sudo /usr/local/munki/managedsoftwareupdate --checkonly
sudo plutil -p "/Library/Managed Installs/InstallInfo.plist"
# expect SmokeTestApp under optional_installs, "installed" => 0

# 5. Confirm Santa's ruledownload allow-lists it
curl -s -X POST http://127.0.0.1:3100/ruledownload/SMOKE-TEST-MACHINE | python3 -m json.tool
# expect a rule with policy ALLOWLIST for SmokeTestApp's sha256

# 6. Stop the server
kill %1
```

- [ ] **Step 4: Commit**

```bash
git add munki-catalog-server/README.md
git commit -m "Add munki-catalog-server README and end-to-end smoke test notes"
```
