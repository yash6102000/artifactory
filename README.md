# Software Center

An in-house alternative to a commercial MDM/software-catalog product for
distributing approved Mac apps and enforcing that only approved apps run.
Full background and rollout plan: `docs/inhouse-software-center-plan.html`
(also see `docs/inhouse-artifactory-plan.html` and
`docs/inhouse-software-center-full-rollout-aws.html`).

The repo holds **two independent implementations** of the same idea, side
by side, plus a shared enforcement layer:

- **The custom stack** (`catalog-server/` + `client-mac/`) — a
  purpose-built backend and macOS client, built from scratch.
- **The Munki-backed stack** (`munki-catalog-server/`) — the same idea,
  built on top of [Munki](https://github.com/munki/munki), an established
  open-source macOS software deployment tool, instead of custom storage
  and a custom client.
- **Santa** (google/santa or NorthPole Security's fork) — the execution
  enforcement layer both stacks feed rules into. Not part of this repo's
  code; a separate tool each stack's admin server talks to over its sync
  protocol.

These two stacks do not depend on each other and can run side by side
(different ports) while you evaluate which one to keep.

## Index

| Where | What it is |
|---|---|
| [`catalog-server/`](catalog-server/) | Custom backend: Fastify + SQLite admin console and client API |
| [`client-mac/`](client-mac/) | Custom macOS client (SwiftUI) that talks to `catalog-server/` |
| [`munki-catalog-server/`](munki-catalog-server/) | Munki-backed backend: same admin console shape, backed by a real Munki repo instead of SQLite |
| [`munki-catalog-server/README.md`](munki-catalog-server/README.md) | Munki-stack-specific run/config commands |
| [`docs/superpowers/specs/2026-09-04-munki-catalog-server-design.md`](docs/superpowers/specs/2026-09-04-munki-catalog-server-design.md) | Why the Munki stack is built the way it is |
| [`docs/munki-setup.md`](docs/munki-setup.md) | Munki trial notes (installing Munki itself, the raw repo file format) |
| `docs/inhouse-software-center-plan.html` | The original rollout plan both stacks implement |
| [`start.sh`](start.sh) (this repo's root) | One command to start everything needed to test the Munki stack |

## How it works, in one paragraph

An admin uploads an app (or points at where the vendor already hosts it)
through a web admin console and approves it. Approval is the only gate:
once approved, the app becomes visible to enrolled Macs for self-serve
install (via `client-mac`'s custom UI for the custom stack, or Munki's own
Managed Software Center for the Munki stack). The same approval feeds
Santa: approving a package adds its hash to Santa's allow-list on every
enrolled Mac, so **only approved software can actually run** — uploading
a file is not enough, and revoking approval also revokes the Santa rule.
A separate DNS sinkhole process blocks specific domains network-wide,
independent of the package-approval flow.

## Quick start — Munki stack (recommended for testing right now)

One command starts everything this stack needs, from the repo root:

```bash
./start.sh
```

This starts `munki-catalog-server`'s admin console (`http://127.0.0.1:3100/admin`)
and its DNS domain filter (asks for your `sudo` password once, since DNS
needs a privileged port). It does **not** install or start Santa — Santa is
a system extension that needs a one-time manual install and approval; the
script tells you whether it's installed and reminds you to point its sync
URL at the running server if so.

Before your Mac's DNS actually gets filtered, you also need to point your
Mac's DNS settings at `127.0.0.1` (System Settings → Network → your
connection → DNS) — starting the filter process alone doesn't reroute your
traffic through it. See "DNS domain filter" below for the full picture.

Press `Ctrl+C` to stop everything `start.sh` started.

## The custom stack: `catalog-server/` + `client-mac/`

Terminal 1 — start the server:

```
cd catalog-server
npm install   # first time only
npm start
```

Terminal 2 — start the client:

```
cd client-mac
swift build
./.build/debug/SoftwareCenter
```

Then open `http://localhost:3000/admin/packages` and upload a real `.pkg`
or `.dmg`, click Approve, and hit Refresh in the client app — it'll show up.

### What's stubbed vs real (custom stack)

| Piece | Status |
|---|---|
| Catalog API, admin console, SQLite storage | Real, tested |
| Device check-in, install-event logging | Real, tested |
| Client app UI, fetching the catalog | Real, tested |
| Privileged install (admin rights) | **Stubbed** — downloads + opens the installer, macOS prompts for a password manually. Needs a signed XPC helper before this is the real, automated flow |
| Santa enforcement | Wired (see "Santa" below), but the plan's Phase 2 hardening (binary-hash reconciliation) is still open |
| Auth on the admin console | **None yet** — do not point this at anything beyond localhost until basic auth (or a VPN/office-network restriction) is added |
| Postgres | Plan calls for it at ~100-machine scale; this scaffold uses SQLite since no Postgres was available to set up here — see the comment at the top of `catalog-server/src/db.js` |

### Next real steps (custom stack)

1. Add basic auth to the `/admin` routes before this touches even the pilot Macs.
2. Build the privileged install helper (`SMAppService` + XPC) — needs the
   Apple Developer ID cert.
3. Sign and notarize the client app as a `.pkg` so it installs cleanly and
   Gatekeeper doesn't warn.
4. Swap SQLite for Postgres before enrolling real pilot devices.

## The Munki stack: `munki-catalog-server/`

A new, independent sibling service, parallel to `catalog-server/` and
`client-mac/` — not a replacement, and it doesn't modify either of them.
It builds the same idea (upload a package, approve it, enforce with Santa)
on top of [Munki](https://github.com/munki/munki) instead of a custom
SQLite `packages` table. Full design rationale (why Munki, why two storage
modes, why no fork of Munki) is in
[`docs/superpowers/specs/2026-09-04-munki-catalog-server-design.md`](docs/superpowers/specs/2026-09-04-munki-catalog-server-design.md).

### Prerequisite: install the real Munki tools

This service shells out to Munki's own `munkiimport` and `makecatalogs`
binaries — it does not reimplement them. Install Munki itself first, via
Homebrew (macOS only):

```bash
brew install --cask munki
```

The cask installs a real signed `.pkg` and needs `sudo`, so run it in a
real terminal (not from a script) so it can prompt for a password.
Verify it worked:

```bash
ls /usr/local/munki/munkiimport /usr/local/munki/makecatalogs
```

Both files should exist.

Optional but useful: [MunkiAdmin](https://github.com/hjuutilainen/munkiadmin)
is a GUI for browsing the Munki repo this service manages.

```bash
brew install --cask munkiadmin
```

### Run it

Either the one-line `./start.sh` from the repo root (see "Quick start"
above), or by hand:

```bash
cd munki-catalog-server
npm install                # first time only
npm test                   # sanity check: builds a real .pkg with pkgbuild
                            # and runs it through the real munkiimport
MUNKI_REPO_PATH="$HOME/munki_repo" PORT=3100 npm start
```

`npm start` alone also works — with no `MUNKI_REPO_PATH` set, the repo
defaults to `munki-catalog-server/munki_repo/` (see `getRepoPath()` in
`src/munki-repo.js`), and with no `PORT`/`HOST` set, the server listens on
`3100`/`127.0.0.1` (see the top of `src/server.js`). Port 3100 is
deliberately different from `catalog-server`'s 3000, so both services can
run side by side during evaluation.

Open the admin console at `http://127.0.0.1:3100/admin`. It inherits
`catalog-server`'s `ip-whitelist.js` unchanged: default-deny except
localhost, opened up via the comma-separated `ADMIN_IP_WHITELIST` env var.

### DNS domain filter

Blocking a domain in `/admin/domains` only adds it to a list — nothing is
actually blocked until two more things happen:

1. **Start the filter process** (needs `sudo`, since DNS is a privileged
   port):
   ```bash
   cd munki-catalog-server
   sudo npm run dns-filter
   ```
   (`start.sh` does this for you.)
2. **Point your Mac's DNS at it.** System Settings → Network → your active
   connection → DNS → add `127.0.0.1` as a DNS server. Until you do this,
   your Mac keeps using whatever DNS server your network already gives it,
   and the filter process sees no traffic at all.

Confirm it's working:

```bash
dig blocked-domain.example.com
```

Expect `NXDOMAIN` for a blocked domain, and a normal answer for anything
else (unblocked lookups are forwarded upstream, not swallowed).

### Santa

Santa enforces "only approved software can run" by checking every launch
against an allow-list this server generates from approved packages. It is
**not installed by `start.sh`** — it's a system extension that needs a
one-time manual install and approval in System Settings.

1. **Install it:**
   ```bash
   brew install --cask santa
   ```
   macOS will ask you to approve a system extension in
   System Settings → Privacy & Security, and likely a restart.
2. **Point its sync URL at this server**, via its config profile or
   `com.northpolesec.santa`/`com.google.santa` preferences (depending on
   which Santa build got installed):
   ```
   http://<this-host>:3100/
   ```
3. **Known friction:** Santa historically expects an HTTPS sync URL, and
   this server only speaks plain HTTP by default (TLS is meant to
   terminate at nginx in front of it, not in this process — see
   `FORCE_HTTPS` in `src/server.js`). If Santa refuses to sync against a
   plain `http://` URL, you'll need either a local HTTPS front end (a
   self-signed cert behind nginx, or similar) or a way to tell your
   specific Santa build to accept HTTP for local testing — this hasn't
   been verified yet, so budget time for it the first time you try this.

To test the server-side logic without any of that Santa setup, you don't
need Santa running at all — upload and approve a package through the admin
console, then ask the server directly what rule it would hand out:

```bash
curl -s -X POST http://127.0.0.1:3100/ruledownload/TEST-MACHINE | python3 -m json.tool
```

An approved package's hash should show up with `"policy": "ALLOWLIST"`.

### How it uses Munki

**What Munki is.** An open-source macOS software deployment tool with a
well-established, backward-compatible repo file format: `pkgsinfo` plists
(one per package), compiled `catalogs`, and `manifests` (which packages
each client/group should see).

**Core design choice: no fork.** This service never modifies Munki's own
source. It only does two things with Munki: (1) shells out to Munki's own
unmodified command-line tools as external processes, and (2) reads/writes
plain plist files in Munki's own documented repo format. That's why
`brew upgrade --cask munki` to a newer Munki version is safe as long as
two things stay true after the upgrade:

- the specific CLI flags this code passes to `munkiimport`/`makecatalogs`
  still exist and mean the same thing, and
- the specific pkginfo/manifest plist keys this code reads and writes
  (`name`, `display_name`, `version`, `category`, `catalogs`,
  `installer_item_location`, `installer_item_hash`, `installer_item_size`,
  `PackageCompleteURL`, `requires`, `optional_installs`) are still
  supported.

Both have been stable across Munki releases for years, but that's the
actual sync-risk surface to watch — not Munki's internal Python/Swift
implementation, which this service never touches.

**Exactly which Munki binaries get called, from where, with what flags**
(all in `munki-catalog-server/src/munki-repo.js`):

- **`munkiimport`** — called by `importFile()` for the "upload a `.pkg`"
  storage mode, with this exact argument list:

  ```
  munkiimport --nointeractive \
    --repo-url file://<repo path> \
    --subdirectory <sanitized category> \
    --catalog production \
    --category <sanitized category> \
    --name <name> \
    --displayname <displayname or name> \
    --description <description> \
    --developer <developer> \
    <uploaded file path>
  ```

  (the `--catalog production` flag was added deliberately during code
  review — without it, `munkiimport` would fall back to its own default
  catalog, which wouldn't match the fixed `production` catalog name this
  service's manifest expects). `munkiimport` copies the file into `pkgs/`,
  computes its SHA-256, and writes a `pkgsinfo/*.plist` with autodetected
  bundle id/version. `importFile()` then parses `munkiimport`'s stdout
  (`Saved pkginfo to pkgsinfo/....`) to find the file it just wrote.

- **`makecatalogs`** — called (via the shared `runMakeCatalogs()` helper,
  as `makecatalogs <repo path>`) by `approve()` and `revoke()` after every
  manifest change, to recompile the repo's `catalogs/` directory from the
  current `pkgsinfo/` files.

- **Not called at all by this service**: `managedsoftwareupdate` (the
  actual client-side install tool) and `Managed Software Center.app`.
  Those run independently on each enrolled Mac, reading the same repo
  files this service writes to — this service only ever writes to the
  repo, never triggers an install.

**The two package storage modes** (`importFile()` vs `importExternal()`
in `munki-repo.js`):

- **Upload file** — an admin uploads a real `.pkg`/`.dmg`; `munkiimport`
  (above) does the inspection and writes the pkginfo automatically.
- **External URL** — no local file to inspect, so no `munkiimport` call
  at all. The admin hand-enters name, version, category, description,
  developer, source URL, SHA-256, and size. `importExternal()` builds a
  `pkgsinfo/<category>/<name>-<version>.plist` directly with the `plist`
  npm library, setting `PackageCompleteURL` to the source URL (Munki
  downloads straight from there instead of from `pkgs/`),
  `installer_item_hash` to the hand-entered SHA-256 (Munki verifies the
  download against it before installing), and `installer_item_size`
  (converted to KB, Munki's convention, for its free-disk-space check).

Both modes end with a normal pkginfo entry — approval and Santa sync
treat both identically from that point on.

**How "approval" works.** A package is visible to Munki clients only when
its `name` is present in the `optional_installs` array of the single
`manifests/site_default` manifest file. `approve()`/`revoke()` in
`munki-repo.js` add/remove the name from that array and then call
`runMakeCatalogs()` to rebuild the compiled catalog.

**What this service does NOT touch in Munki.** It never runs
`managedsoftwareupdate`, never modifies Munki's client-side preferences,
and never touches `/Library/Managed Installs/` on the machine it runs on.
Pointing an actual Mac's Munki client at the repo this service manages is
a separate, one-time step on that Mac (see
`munki-catalog-server/README.md`):

```bash
sudo defaults write /Library/Preferences/ManagedInstalls SoftwareRepoURL "file://$HOME/munki_repo"
sudo defaults write /Library/Preferences/ManagedInstalls ClientIdentifier "site_default"
```

Device and install-event reporting back to the admin console works via a
`postflight` script installed on the client Mac (`scripts/postflight` in
`munki-catalog-server/`, copied to `/usr/local/munki/postflight`), not via
any API this service calls into Munki.

### If Munki changes

After any `brew upgrade --cask munki`, re-run the test suite:

```bash
cd munki-catalog-server && npm test
```

The tests deliberately don't mock the Munki binaries — they build a real
`.pkg` with `pkgbuild` and run it through the real `munkiimport`, so a
breaking change to `munkiimport`/`makecatalogs`' argument parsing or to
the pkginfo/manifest plist keys this code depends on shows up as a test
failure, not a silent bug later.
