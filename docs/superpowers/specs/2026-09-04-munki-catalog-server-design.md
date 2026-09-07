# Munki-backed catalog server — design

Status: approved by user, ready for implementation planning.
Date: 2026-09-04

## Goal

Replace the current custom stack (`catalog-server/` SQLite catalog +
`client-mac/` SwiftUI app) with a service built on Munki, while keeping
every feature `catalog-server` has today: package approval, Santa
enforcement, device/install tracking, a domain blocklist (DNS sinkhole),
and an admin console.

New requirement not in the current stack: a package can be stored either
as an actual `.pkg`/`.dmg` file (as today), or as metadata only — a
pointer to the file's original source URL plus a hand-entered SHA-256,
so Munki fetches it from the vendor at install time instead of from our
storage.

This is a parallel build, not an in-place rewrite. `catalog-server/` and
`client-mac/` are not modified. A new sibling service is built, tested,
and only after it's proven out do `catalog-server/` and `client-mac/`
get retired.

## Non-goals

- No change to `catalog-server/` or `client-mac/` code in this project.
  They stay running, untouched, until a separate future cutover.
- No automatic package inspection for metadata-only (external URL)
  packages — the admin supplies name/version/category/hash by hand.
  There is no `installcheck` beyond a version comparison for these; this
  is a known, documented simplification (see "Known simplifications").
- No per-device manifests. One shared manifest (`site_default`), same
  single-catalog model `catalog-server` uses today.
- No MunkiReport or other separate fleet-reporting dashboard. Device and
  install-event history stays in the new service's own SQLite tables and
  its own admin pages, matching what exists today.
- No change to `ip-whitelist.js` or `FORCE_HTTPS` behavior — both port
  over unchanged.

## Constraint: must run on macOS

`munkiimport` and `makecatalogs` are macOS-only binaries — they shell
out to `pkgutil`/`installer` to inspect `.pkg` files. The new service
must run on a Mac (as, presumably, `catalog-server` already does), and
calls these tools as external processes. This rules out hosting the new
service on a plain Linux box without also reimplementing macOS package
inspection — out of scope here.

## No fork of Munki itself

This design never modifies Munki's own source code. It consumes the
unmodified `munkiimport`, `makecatalogs`, and `managedsoftwareupdate`
binaries (installed via the `munki` Homebrew cask) as external tools,
and only reads/writes plain plist files in Munki's documented repo
format (`pkgsinfo`/`catalogs`/`manifests`). That file format has stayed
backward-compatible across Munki releases for years.

Because of this, there is no upstream fork to maintain and no merge
step, ever: a new Munki version is a plain
`brew upgrade --cask munki`. If a future need ever requires changing
Munki's own source (not part of this build), that would be a separate,
much heavier decision — a real git fork with its own upstream-merge
process — and is explicitly out of scope here.

## Dependency support (frameworks/libraries)

A shared framework or library is packaged and imported exactly like any
other package (a `.pkg` via `pkgbuild`, or an external-URL entry) — no
special package type. What's new is expressing "app X needs library Y
installed first":

- The upload form gets an optional **Requires** field: a multi-select
  list of other package names already in the repo.
- `munki-repo.js` writes the selected names into the `requires` key of
  the app's `pkginfo` — this is a native Munki key; `managedsoftwareupdate`
  already resolves and installs required items before the item that
  needs them, no custom logic required on our side.
- The admin console's package list (`/admin/packages`) shows each
  package's `requires`, if any, so dependencies are visible at a glance.

## Architecture

A new top-level directory, `munki-catalog-server/`, mirrors
`catalog-server/`'s shape (Fastify app, server-rendered admin console,
own `PORT` env var so it can run side by side with `catalog-server`
during testing).

```
munki-catalog-server/
  src/
    server.js          # client API + admin console (mirrors catalog-server/src/server.js)
    db.js              # devices, install_events, blocked_hashes, blocked_domains — same schema as today, minus `packages`
    munki-repo.js       # NEW: reads/writes pkginfo/catalogs/manifests, shells out to munkiimport/makecatalogs
    santa-sync.js       # ported: builds Santa rules from the Munki repo instead of the `packages` table
    dns-filter-server.js # ported unchanged
    ip-whitelist.js      # ported unchanged
  munki_repo/
    catalogs/
    manifests/          # site_default
    pkgs/
    pkgsinfo/
    icons/
    client_resources/
  views/                # admin console templates, adapted from catalog-server/views
  data/
    catalog.db          # NEW, separate SQLite file — devices/install_events/blocked_hashes/blocked_domains only
```

`munki-repo.js` is the one genuinely new module. Everything else is a
port of existing `catalog-server` code, adjusted to read from Munki repo
files instead of the `packages` SQL table.

## Admin console — same pages as `catalog-server`

`munki-catalog-server` ships the same admin console shape as
`catalog-server`, one console for everything, not separate tools per
feature:

| Page | Behavior |
|---|---|
| `GET /admin` | Dashboard: package count, approved count, device count — counts now come from `pkgsinfo`/manifest files and the new `data/catalog.db`. |
| `GET /admin/packages` | List every package (from `pkgsinfo/`), showing name, version, category, storage mode (file vs. external URL), `requires` (dependencies, if any), and approved/not-approved. |
| `GET /admin/packages/new` | Upload form with the two storage modes ("Upload file" and "External URL", see below) plus an optional **Requires** dependency field. |
| `POST /admin/packages/:id/approve` `/revoke` | Adds/removes the package from `site_default`'s `optional_installs`, runs `makecatalogs`. |
| `GET /admin/devices` | Device list, populated by the postflight-script check-ins (see "Device and install-event tracking"). |
| `GET /admin/santa` | Santa sync status — ported unchanged. |
| `GET/POST /admin/blocklist` | Manage `blocked_hashes` — ported unchanged, same narrow blocklist-outside-the-approval-flow behavior as today. |
| `GET/POST /admin/domains` | Manage `blocked_domains`, read by the ported `dns-filter-server.js` — the "website filter/blocking" feature, ported unchanged. |

Every one of these is a straight port of the matching page in
`catalog-server/src/server.js` and `catalog-server/views/`, with the
package-related pages rewired to `munki-repo.js` instead of SQL queries
against a `packages` table.

## Package storage — two modes

The upload form (`/admin/packages/new`) gets a mode switch:

**Upload file** (unchanged behavior from today)
- Admin uploads a `.pkg`/`.dmg`.
- `munki-repo.js` shells out to:
  ```
  munkiimport --nointeractive --repo-url "file://<munki_repo>" \
    --subdirectory <category> --category <category> \
    --name <name> --displayname <displayname> \
    --description <description> \
    <uploaded file path>
  ```
- `munkiimport` copies the file into `pkgs/`, computes the SHA-256, and
  writes a `pkgsinfo/*.plist` with autodetected bundle id/version.

**External URL** (new)
- Admin enters: name, display name, version, category, description,
  developer, source URL, SHA-256 (hex), and file size in bytes.
- `munki-repo.js` writes a `pkgsinfo/<category>/<name>-<version>.plist`
  plist directly (a plist-writing library, no shell-out — there's no
  local file for `munkiimport` to inspect), with:
  - `installer_item_location`: a synthetic relative path, e.g.
    `external/<name>-<version>.pkg` (never actually created under
    `pkgs/` — Munki only uses this key to name its local download
    cache file, not to locate the source).
  - `PackageCompleteURL`: the admin-entered source URL. Munki's
    `download_installeritem()` downloads directly from this URL when
    it's present, bypassing the repo's `pkgs/` folder entirely.
  - `installer_item_hash`: the admin-entered SHA-256. Munki verifies
    the downloaded file against this hash before installing — this is
    the safety net if the vendor changes the file at that URL without
    a re-import.
  - `installer_item_size`: the admin-entered size, in KB (Munki's
    convention), used only for the free-disk-space check before
    download.

Both modes end with a normal `pkgsinfo` entry — from that point on,
approval, Santa sync, and manifest handling treat both identically.

## Approval = manifest membership

- **Approve**: `munki-repo.js` adds the package's `name` to
  `optional_installs` in `manifests/site_default` (self-serve, matching
  `catalog-server`'s current "approved packages just become visible"
  semantics — not force-installed), then runs
  `makecatalogs <munki_repo>`.
- **Revoke**: removes the name from `optional_installs`, re-runs
  `makecatalogs`.

This directly replaces `packages.approved` from the old schema. There is
no `packages` table in the new service — `pkgsinfo/` + `manifests/` +
`catalogs/` are the source of truth.

## Santa sync

`santa-sync.js` ports `catalog-server`'s 4-stage protocol
(preflight/eventupload/ruledownload/postflight) unchanged in shape, but
`ruledownload` now:
1. Reads the compiled `all` catalog (or every `pkgsinfo/*.plist` — same
   data either way) instead of `SELECT * FROM packages`.
2. Emits an ALLOWLIST rule per item currently in `site_default`'s
   `optional_installs`, using that item's `installer_item_hash` — the
   same field, whether it came from `munkiimport` (uploaded file) or was
   hand-entered (external URL). This is why the hash is mandatory for
   both storage modes.
3. Emits REMOVE for any previously-known hash no longer in the manifest.

Since a Mac's Santa client can only sync against one server, enrolled
Macs get repointed to the new service's sync URL as part of this
rollout (not deferred to a later cutover) — `catalog-server`'s Santa
sync becomes dead code once that repoint happens, though the files stay
in place until the broader cutover.

## DNS domain blocking

`dns-filter-server.js` and the `blocked_domains` table/admin page
(`/admin/domains`) port over unchanged in behavior, reading from the new
service's own `data/catalog.db`.

## Device and install-event tracking

Managed Software Center doesn't call custom HTTP endpoints the way
`client-mac` did. To keep the admin dashboard's device list and install
history working:

- A `postflight_script` is added to Munki's client configuration
  (`/usr/local/munki/preflight.d/` equivalent for postflight — a shell
  script Munki runs after every `managedsoftwareupdate`).
- That script POSTs to the new service's `/api/devices/checkin` and
  `/api/install-events`, matching the exact request shape
  `catalog-server`'s endpoints already accept today (same DB schema for
  `devices`/`install_events`, so no endpoint contract changes needed).

## Client app

`client-mac` is not wired to the new service and is not modified.
Managed Software Center (already installed via the `munki` Homebrew
cask on the test Mac) is the end-user install UI going forward.
`client-mac` is retired at the final cutover, after the trial proves the
new service works — not part of this build.

## Data separation during the trial

The new service uses its own SQLite file, `munki-catalog-server/data/catalog.db`,
with the same `devices`/`install_events`/`blocked_hashes`/`blocked_domains`/
`santa_devices`/`santa_events` schema as `catalog-server/src/db.js` today,
minus the `packages` table (replaced by the Munki repo files). No shared
writes with `catalog-server`'s existing `catalog.db` during the trial.

## Known simplifications

- **No installcheck for external-URL packages.** Without a local file to
  inspect, there is no automatic "is this already installed" check
  beyond Munki's own version comparison. In practice this means Munki
  may re-offer an external-URL item as "available" even after install,
  until Munki's version-tracking catches up on a later catalog refresh.
  Upgrade path: let the admin optionally supply an `installs` array
  (path + version key) by hand for external-URL packages that need a
  precise check.
- **`installer_item_hash` is mandatory, entered by hand, for external-URL
  packages.** If the admin gets it wrong, Munki will refuse to install
  (hash mismatch) — this fails safe, not silently.
- **Single global manifest (`site_default`).** Matches today's
  single-catalog model. Per-group or per-device manifests are a
  follow-up if ever needed.
