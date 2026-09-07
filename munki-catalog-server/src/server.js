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
app.register(require('./santa-sync'));

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
  const fields = {};
  let tmpFilePath = null;

  // The upload form always declares enctype="multipart/form-data", but
  // external-mode submissions carry no file — accept plain urlencoded
  // bodies too rather than forcing every request through the multipart
  // parser (which throws on a non-multipart content-type).
  if (req.isMultipart()) {
    const parts = req.parts();
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
  } else {
    Object.assign(fields, req.body || {});
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
    try {
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
    } catch (err) {
      req.log.error(err, 'munkiimport failed on uploaded file');
      fs.unlinkSync(tmpFilePath);
      return reply.code(400).send({ error: 'invalid package: could not import the uploaded file' });
    }
    fs.unlinkSync(tmpFilePath);
  }

  return reply.redirect('/admin/packages');
});

app.post('/admin/packages/:id/approve', async (req, reply) => {
  try {
    munkiRepo.approve(req.params.id);
  } catch (err) {
    req.log.error(err, 'approve failed');
    if (err.message && err.message.startsWith('package not found:')) {
      return reply.code(404).send({ error: 'package not found' });
    }
    return reply.code(500).send({ error: 'failed to update approval state' });
  }
  return reply.redirect('/admin/packages');
});

app.post('/admin/packages/:id/revoke', async (req, reply) => {
  try {
    munkiRepo.revoke(req.params.id);
  } catch (err) {
    req.log.error(err, 'revoke failed');
    if (err.message && err.message.startsWith('package not found:')) {
      return reply.code(404).send({ error: 'package not found' });
    }
    return reply.code(500).send({ error: 'failed to update approval state' });
  }
  return reply.redirect('/admin/packages');
});

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

app.get('/admin/santa', async (_req, reply) => {
  const santaDevices = db.prepare(`SELECT * FROM santa_devices ORDER BY last_seen DESC`).all();
  const santaEvents = db.prepare(`SELECT * FROM santa_events ORDER BY created_at DESC LIMIT 50`).all();
  return reply.view('santa.ejs', { santaDevices, santaEvents });
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

app.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Munki catalog server listening at ${address}`);
});

module.exports = app;
