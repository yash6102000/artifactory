# Software Center — Phase 1 Scaffold

This is the working start of the plan in `../inhouse-software-center-plan.html`:
our own catalog + client app, with Santa handling enforcement later (not part
of this scaffold yet — see the plan's Build Plan tab for that phase).

Two pieces:

- **`catalog-server/`** — the backend + admin console. Fully working: upload
  a package, approve it, it appears in the catalog API, a client can check
  in, download it, and report install events. Verified end to end.
- **`client-mac/`** — the employee-facing Software Center app (SwiftUI).
  Builds and runs, checks in with the server, lists approved apps, and can
  download a package. **Does not yet do a real privileged install** — see
  the note in `client-mac/Sources/SoftwareCenter/Services/InstallService.swift`
  for exactly why and what's needed (a signed privileged helper, which needs
  a real Apple Developer ID to build properly).

## Run it

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

## What's stubbed vs real

| Piece | Status |
|---|---|
| Catalog API, admin console, SQLite storage | Real, tested |
| Device check-in, install-event logging | Real, tested |
| Client app UI, fetching the catalog | Real, tested |
| Privileged install (admin rights) | **Stubbed** — downloads + opens the installer, macOS prompts for a password manually. Needs a signed XPC helper before this is the real, automated flow |
| Santa enforcement | Not part of this scaffold — see the plan doc's Build Plan tab, Phase 2 |
| Auth on the admin console | **None yet** — do not point this at anything beyond localhost until basic auth (or a VPN/office-network restriction) is added |
| Postgres | Plan calls for it at ~100-machine scale; this scaffold uses SQLite since no Postgres was available to set up here — see the comment at the top of `catalog-server/src/db.js` |

## Next real steps (Phase 1, per the plan)

1. Add basic auth to the `/admin` routes before this touches even the pilot Macs.
2. Build the privileged install helper (`SMAppService` + XPC) — needs the
   Apple Developer ID cert.
3. Sign and notarize the client app as a `.pkg` so it installs cleanly and
   Gatekeeper doesn't warn.
4. Swap SQLite for Postgres before enrolling real pilot devices.
