# munki-catalog-server

A Munki-backed replacement for `catalog-server` + `client-mac`. See
`../docs/superpowers/specs/2026-09-04-munki-catalog-server-design.md`
for the full design.

## Run it

```bash
npm install
MUNKI_REPO_PATH="$HOME/munki_repo" PORT=3100 npm start
```

Runs on port 3100 by default so it can run alongside `catalog-server`
(port 3000) during the parallel-testing period.

## Point a Mac's Munki client at this repo

```bash
sudo defaults write /Library/Preferences/ManagedInstalls SoftwareRepoURL "file://$HOME/munki_repo"
sudo defaults write /Library/Preferences/ManagedInstalls ClientIdentifier "site_default"
```

## Point Santa at this server

Configure Santa's sync URL (via its config profile or
`com.northpolesec.santa`/`com.google.santa` preferences, depending on
which Santa build is installed) to `http://<this-host>:3100/`.

## Install the postflight script (device/install-event tracking)

```bash
sudo cp scripts/postflight /usr/local/munki/postflight
sudo chmod +x /usr/local/munki/postflight
```

## Admin console

http://127.0.0.1:3100/admin (subject to `ADMIN_IP_WHITELIST`, same
default-deny-except-localhost behavior as `catalog-server`).
