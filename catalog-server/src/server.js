const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Fastify = require('fastify');
const view = require('@fastify/view');
const multipart = require('@fastify/multipart');
const formbody = require('@fastify/formbody');
const ejs = require('ejs');
const db = require('./db');
const { isWhitelisted } = require('./ip-whitelist');

const PORT = process.env.PORT || 3000;
// Local-only by default — nothing on the LAN can reach this at all, which is
// tighter than the /admin IP whitelist alone (that still left /api/* open to
// anyone on the network). Real deployment sets HOST=0.0.0.0 and puts nginx +
// TLS in front, per the plan; until then this should never be more open than
// this one machine.
const HOST = process.env.HOST || '127.0.0.1';
const STORAGE_DIR = path.join(__dirname, '..', 'storage', 'packages');

// trustProxy so req.ip reflects X-Forwarded-For from the nginx reverse proxy
// in front of this server (per the plan's Tech Stack tab) — without it every
// request would appear to come from nginx's own loopback address, and the
// admin whitelist below would be checking the wrong IP entirely.
const app = Fastify({ logger: true, trustProxy: true });

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

// This process itself only ever speaks plain HTTP (see the plan: TLS is
// terminated at nginx in front of this app, not here). When FORCE_HTTPS is
// set, every request that didn't arrive over TLS is blocked outright —
// "someone opens the http:// URL" gets a hard 403, not a redirect, so it
// fails the same way for a browser tab, curl, and the client app.
//
// nginx marks a request that reached it over TLS with X-Forwarded-Proto:
// https before forwarding it here; a request nginx received as plain http,
// or anyone hitting this port directly, arrives without that header (or
// with it set to "http") and gets blocked. Off by default so local dev
// without an nginx/cert in front of it still works.
if (process.env.FORCE_HTTPS === '1') {
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers['x-forwarded-proto'] === 'https') return;
    app.log.warn(`blocked plain-http request to ${req.raw.url}`);
    reply.code(403).send('Forbidden: HTTPS required.');
  });
}

// ---------- Santa sync protocol (Phase 2: enforcement) ----------
// This IS the wiring described in the plan's Phase 2 task "Wire admin-console
// approvals to Santa rules" — approving a package here makes it show up in
// ruledownload for every Mac that syncs against this server.
app.register(require('./santa-sync'));

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
// Blocked by default for anything not on ADMIN_IP_WHITELIST (see
// ip-whitelist.js) — the "office network / VPN" option from the plan's
// Phase 1 notes. Set ADMIN_IP_WHITELIST to the office's public IP or VPN
// CIDR before pointing this at real pilot machines.
app.addHook('onRequest', async (req, reply) => {
  if (!req.raw.url.startsWith('/admin')) return;
  if (isWhitelisted(req.ip)) return;
  app.log.warn(`blocked admin access from ${req.ip}`);
  reply.code(403).send('Forbidden: this IP is not whitelisted for admin access.');
});

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

app.get('/admin/santa', async (_req, reply) => {
  const santaDevices = db.prepare(`SELECT * FROM santa_devices ORDER BY last_seen DESC`).all();
  const santaEvents = db.prepare(`SELECT * FROM santa_events ORDER BY created_at DESC LIMIT 50`).all();
  return reply.view('santa.ejs', { santaDevices, santaEvents });
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

// People will naturally paste a full URL copied from their browser's address
// bar to block it (https://snipki.de, https://snipki.de/some/path) — pull
// the hostname out of that instead of making them strip it by hand.
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
  app.log.info(`Software Center catalog server listening at ${address}`);
});
