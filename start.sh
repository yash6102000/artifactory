#!/usr/bin/env bash
# One command to start everything needed to test the Munki-backed stack:
# munki-catalog-server (admin console + Santa sync) and the DNS domain
# filter. See README.md for what each piece does and one-time setup steps
# (pointing a Mac's Munki client at the repo, Santa's sync URL, DNS
# settings) that this script does not do for you.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PORT="${PORT:-3100}"
PIDS=()

cleanup() {
  echo ""
  echo "Stopping..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

echo "== munki-catalog-server (admin console, port $PORT) =="
(cd munki-catalog-server && PORT="$PORT" npm start) &
PIDS+=("$!")

echo "== DNS domain filter (port 53, needs sudo) =="
(cd munki-catalog-server && sudo npm run dns-filter) &
PIDS+=("$!")

echo ""
echo "== Santa =="
if command -v santactl >/dev/null 2>&1; then
  echo "Santa is installed. Confirm its sync URL points at http://127.0.0.1:$PORT/"
  echo "(see 'Point Santa at this server' in munki-catalog-server/README.md)."
else
  echo "Santa is NOT installed — nothing to start."
  echo "To test enforcement, install it first: brew install --cask santa"
  echo "Then point its sync URL at http://127.0.0.1:$PORT/"
  echo "(see 'Point Santa at this server' in munki-catalog-server/README.md)."
fi

echo ""
echo "Admin console: http://127.0.0.1:$PORT/admin"
echo "Press Ctrl+C to stop everything started here."
echo ""

wait
