const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Fastify = require('fastify');
const view = require('@fastify/view');
const multipart = require('@fastify/multipart');
const formbody = require('@fastify/formbody');
const ejs = require('ejs');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const STORAGE_DIR = path.join(__dirname, '..', 'storage', 'packages');

const app = Fastify({ logger: true });

app.register(view, {
  engine: { ejs },
  root: path.join(__dirname, '..', 'views'),
});
// Plain HTML forms (Approve/Revoke buttons) POST as
// application/x-www-form-urlencoded — Fastify has no parser for that
// registered by default, which is exactly the 415 error this fixes.
app.register(formbody);
app.register(multipart, {
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB, installers can be large
});

// ---------- Client-facing API (macOS client app talks to these) ----------

// The catalog the Software Center app displays. Only approved packages —
// this list IS the enforcement of "nothing exists outside the catalog."
app.get('/api/catalog', async (_req, reply) => {
  const rows = db
    .prepare(
      `SELECT id, name, version, description, category, icon, sha256
       FROM packages WHERE approved = 1 ORDER BY name ASC`
    )
    .all();
  reply.send({ packages: rows });
});

app.get('/api/packages/:id/download', async (req, reply) => {
  const pkg = db
    .prepare(`SELECT * FROM packages WHERE id = ? AND approved = 1`)
    .get(req.params.id);
  if (!pkg) return reply.code(404).send({ error: 'not found or not approved' });
  const filePath = path.join(STORAGE_DIR, pkg.filename);
  if (!fs.existsSync(filePath)) return reply.code(410).send({ error: 'file missing on server' });
  reply.header('Content-Disposition', `attachment; filename="${pkg.filename}"`);
  return reply.send(fs.createReadStream(filePath));
});

// Client app version check, for the self-update flow described in the plan.
app.get('/api/version', async (_req, reply) => {
  reply.send({ latest: process.env.CLIENT_VERSION || '0.1.0' });
});

// Device check-in: upserts the device row so the admin console has a live
// inventory of which of the pilot's 5-10 Macs are actually enrolled.
app.post('/api/devices/checkin', async (req, reply) => {
  const { device_uuid, hostname } = req.body || {};
  if (!device_uuid) return reply.code(400).send({ error: 'device_uuid required' });
  db.prepare(
    `INSERT INTO devices (device_uuid, hostname) VALUES (?, ?)
     ON CONFLICT(device_uuid) DO UPDATE SET hostname = excluded.hostname, last_seen = datetime('now')`
  ).run(device_uuid, hostname || '');
  reply.send({ ok: true });
});

// Install/uninstall/failure events from the client, for the audit log.
app.post('/api/install-events', async (req, reply) => {
  const { device_uuid, package_id, status } = req.body || {};
  if (!device_uuid || !package_id || !status) {
    return reply.code(400).send({ error: 'device_uuid, package_id, status required' });
  }
  db.prepare(
    `INSERT INTO install_events (device_uuid, package_id, status) VALUES (?, ?, ?)`
  ).run(device_uuid, package_id, status);
  reply.send({ ok: true });
});

// ---------- Admin console (server-rendered, no framework needed) ----------
// NOTE: no auth wired up yet — this is a local dev scaffold. Before this
// touches even the 5-10 pilot machines, put this behind basic auth /
// the office network / a VPN, same as the plan's Phase 1 assumes.

app.get('/admin', async (_req, reply) => {
  const counts = {
    packages: db.prepare(`SELECT COUNT(*) c FROM packages`).get().c,
    approved: db.prepare(`SELECT COUNT(*) c FROM packages WHERE approved = 1`).get().c,
    devices: db.prepare(`SELECT COUNT(*) c FROM devices`).get().c,
  };
  const recentEvents = db
    .prepare(
      `SELECT ie.*, p.name as package_name
       FROM install_events ie LEFT JOIN packages p ON p.id = ie.package_id
       ORDER BY ie.created_at DESC LIMIT 20`
    )
    .all();
  return reply.view('dashboard.ejs', { counts, recentEvents });
});

app.get('/admin/packages', async (_req, reply) => {
  const packages = db.prepare(`SELECT * FROM packages ORDER BY created_at DESC`).all();
  return reply.view('packages.ejs', { packages });
});

app.get('/admin/packages/new', async (_req, reply) => {
  return reply.view('package-new.ejs', {});
});

app.post('/admin/packages', async (req, reply) => {
  const parts = req.parts();
  const fields = {};
  let savedFilename = null;
  let sha256 = null;

  for await (const part of parts) {
    if (part.type === 'file') {
      const hash = crypto.createHash('sha256');
      const ext = path.extname(part.filename) || '.pkg';
      savedFilename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
      const dest = path.join(STORAGE_DIR, savedFilename);
      const writeStream = fs.createWriteStream(dest);
      for await (const chunk of part.file) {
        hash.update(chunk);
        writeStream.write(chunk);
      }
      writeStream.end();
      sha256 = hash.digest('hex');
    } else {
      fields[part.fieldname] = part.value;
    }
  }

  if (!savedFilename || !fields.name || !fields.version) {
    return reply.code(400).send({ error: 'name, version, and a file are required' });
  }

  db.prepare(
    `INSERT INTO packages (name, version, description, category, icon, filename, sha256, approved)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(
    fields.name,
    fields.version,
    fields.description || '',
    fields.category || 'Other',
    fields.icon || '📦',
    savedFilename,
    sha256
  );

  return reply.redirect('/admin/packages');
});

app.post('/admin/packages/:id/approve', async (req, reply) => {
  db.prepare(`UPDATE packages SET approved = 1 WHERE id = ?`).run(req.params.id);
  return reply.redirect('/admin/packages');
});

app.post('/admin/packages/:id/revoke', async (req, reply) => {
  db.prepare(`UPDATE packages SET approved = 0 WHERE id = ?`).run(req.params.id);
  return reply.redirect('/admin/packages');
});

app.get('/admin/devices', async (_req, reply) => {
  const devices = db.prepare(`SELECT * FROM devices ORDER BY last_seen DESC`).all();
  return reply.view('devices.ejs', { devices });
});

app.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Software Center catalog server listening at ${address}`);
});
