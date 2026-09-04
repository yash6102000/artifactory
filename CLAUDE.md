# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Phase 1 scaffold for an in-house "Software Center": a private app catalog
plus a macOS client, with Google/NorthPole Santa handling execution
enforcement. The full plan lives in `docs/inhouse-software-center-plan.html`
(also see `docs/inhouse-artifactory-plan.html` and
`docs/inhouse-software-center-full-rollout-aws.html`). There is no test
suite yet.

Two pieces:

- **`catalog-server/`** — Fastify + SQLite backend and server-rendered admin
  console. Fully working end to end.
- **`client-mac/`** — SwiftUI macOS client. Fetches the catalog and can
  download a package, but does **not** do a real privileged install (see
  `client-mac/Sources/SoftwareCenter/Services/InstallService.swift`).

## Commands

Server (from `catalog-server/`):

```
npm install                # first time only
npm start                  # run the server (PORT=3000, HOST=127.0.0.1 by default)
npm run dev                # same, with --watch
npm run dns-filter         # run the DNS sinkhole (needs sudo, binds port 53)
```

Client (from `client-mac/`):

```
swift build
./.build/debug/SoftwareCenter
```

Open `http://localhost:3000/admin/packages` to upload a `.pkg`/`.dmg`,
click Approve, then Refresh in the client app.

## Architecture

### Three server processes, one SQLite file

`catalog-server/src/db.js` opens `catalog-server/data/catalog.db` and owns
all schema (`packages`, `devices`, `install_events`, `santa_devices`,
`santa_events`, `blocked_hashes`, `blocked_domains`). Three independent
Node processes share this one file:

1. **`server.js`** — the Fastify app: client-facing `/api/*` routes, the
   `/admin/*` console, and the Santa sync protocol (mounted via
   `santa-sync.js`).
2. **`dns-filter-server.js`** — a separate UDP/DNS process (can't live
   inside Fastify since DNS is UDP:53, not HTTP). Reads `blocked_domains`
   directly and answers NXDOMAIN for anything blocked, else forwards
   upstream.
3. Santa itself, running on enrolled Macs, syncing against `server.js`.

The plan calls for Postgres at ~100-device scale; SQLite is a deliberate
stand-in (see the comment at the top of `db.js`) — every query is plain SQL
so the driver swap stays contained to `db.js`.

### The approval flow IS the enforcement

`/api/catalog` and `/api/packages/:id/download` only ever serve rows where
`packages.approved = 1`. There's no separate "enable" step — approving a
package in the admin console is what makes it appear to clients.

### Santa sync ties approval to execution allow-listing

`santa-sync.js` implements Santa's 4-stage sync protocol
(preflight/eventupload/ruledownload/postflight). `ruledownload` derives
ALLOWLIST rules directly from `packages.sha256` for every approved row, and
emits `REMOVE` for every non-approved row (so a revoke actually retracts the
rule, not just stops offering the file). `blocked_hashes` is a separate,
narrow BLOCKLIST path for a bad binary that never went through the upload
flow — not the main enforcement mechanism.

**Known simplification** (documented in `santa-sync.js`): `packages.sha256`
hashes the installer we store, not the installed binary Santa evaluates at
launch. Reconciling that (hash the installed binary at packaging time, or
switch to TEAMID/CERTIFICATE rules) is real follow-up work.

`SANTA_CLIENT_MODE` env var controls MONITOR vs LOCKDOWN — deliberately a
single explicit config value, not per-device or DB-driven, so flipping to
enforcement is a conscious action.

### Two independent access-control layers

- **`ip-whitelist.js`** gates `/admin/*` only (checked in an `onRequest`
  hook in `server.js`). Default-deny: only localhost unless
  `ADMIN_IP_WHITELIST` (comma-separated IPs/CIDRs) is set. There is no auth
  on top of this yet — the plan's next step.
- **`FORCE_HTTPS=1`** gates the whole app: rejects any request that didn't
  arrive via nginx with `X-Forwarded-Proto: https`. TLS terminates at nginx
  in front of this process, never here.

Both are off/permissive by default so local dev works without nginx or a
whitelist configured — don't tighten either without checking the env vars
first.

### macOS client

`CatalogService.swift` is the only place that talks to the server
(`baseURL` hardcoded to `http://localhost:3000` for this scaffold — becomes
a real internal hostname in Phase 1). `DeviceIdentity` is a
`UserDefaults`-persisted UUID standing in for the hardware UUID. Views live
under `Sources/SoftwareCenter/Views/`.

## Working in this repo

- The server has no auth on `/admin` beyond the IP whitelist — don't point
  a running instance at anything beyond localhost, and don't relax
  `ADMIN_IP_WHITELIST` handling without a reason.
- Anything explicitly called "stubbed" in the README or in a file's own
  comments (privileged install, Santa binary-hash reconciliation) is a known
  gap, not a bug — check the plan doc's Build Plan tab before "fixing" it.
