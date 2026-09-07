const fs = require('node:fs');
const path = require('node:path');
const plist = require('plist');
const { execFileSync } = require('node:child_process');

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
  importFile,
  importExternal,
  approve,
  revoke,
};
