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
