// Santa's sync protocol (google/santa docs/development/sync-protocol.md,
// northpolesec's fork is protocol-compatible): client-initiated, 4 stages
// per sync — preflight, eventupload, ruledownload, postflight — each POSTed
// to /<stage>/<machine_id>.
//
// This is the piece that ties "IT approved a package in our admin console"
// to "Santa on every enrolled Mac allows it to run": ruledownload derives
// ALLOWLIST rules straight from packages.sha256 for every approved package,
// so approving a package here is the only step needed to also allow it
// through Santa — no separate rule-authoring step.
//
// KNOWN SIMPLIFICATION: packages.sha256 is the hash of the .pkg installer we
// store, not the installed application binary Santa actually evaluates when
// it's later launched. For a real rollout the two need to be reconciled
// (e.g. hash the installed binary at packaging time, or use TEAMID/CERTIFICATE
// rules keyed on the vendor's signing identity instead of a binary hash).
// This wires the plumbing end to end first; that hashing nuance is real
// follow-up work, not addressed here.
const db = require('./db');

// Fixed for now — the plan's Phase 2 calls for Monitor mode during burn-in
// before any pilot Mac is ever flipped to Lockdown. Deliberately not
// per-request or DB-driven yet, so switching to Lockdown is a conscious,
// explicit config change (env var) rather than something that could
// silently vary per sync.
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
    // Single-page response — the pilot's rule count (approved packages +
    // explicit blocks) is nowhere near where cursor-based pagination would
    // matter.
    const approved = db.prepare(`SELECT sha256 FROM packages WHERE approved = 1`).all();
    // Revoking a package (admin/packages/:id/revoke) only stops it being
    // offered going forward unless we also tell Santa to drop the rule it
    // already pushed — otherwise a Mac that synced the ALLOWLIST rule
    // before revocation just keeps allowing that binary forever, since
    // Santa's local rule cache isn't reconciled against what's missing from
    // a ruledownload response, only against explicit REMOVE entries.
    const notApproved = db.prepare(`SELECT sha256 FROM packages WHERE approved = 0`).all();
    const blocked = db.prepare(`SELECT sha256, reason FROM blocked_hashes`).all();
    const rules = [
      ...approved.map((pkg) => ({
        identifier: pkg.sha256,
        rule_type: 'BINARY',
        policy: 'ALLOWLIST',
      })),
      // Harmless no-op for a package that was never approved in the first
      // place (nothing to remove); actually clears the stale rule for one
      // that was approved and got revoked since.
      ...notApproved.map((pkg) => ({
        identifier: pkg.sha256,
        rule_type: 'BINARY',
        policy: 'REMOVE',
      })),
      // Explicit blocks take precedence in Santa regardless of list order,
      // but a hash landing in both lists is an admin-console misuse (a
      // "blocked" hash that's also an approved package) — not something
      // this endpoint tries to resolve.
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
