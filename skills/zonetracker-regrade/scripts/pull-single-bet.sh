#!/usr/bin/env bash
#
# pull-single-bet.sh — Pull raw bet details from bettracker.db for specific bet IDs.
#
# Usage:
#   bash scripts/pull-single-bet.sh <bet_id_1> [bet_id_2] ...
#
# Returns JSON with: id, description, created_at, event_date, odds, units,
# sport, league, capper_id, source, source_url, result for each bet.
#
# Implementation: writes JS to a local temp file, uploads via sftp, executes
# via ssh console. Avoids nested quote-escape collisions from inline node-e.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: bash $0 <bet_id_1> [bet_id_2] ..." >&2
  echo "Each bet_id must be a 32-char hex string." >&2
  exit 1
fi

for id in "$@"; do
  if ! [[ "$id" =~ ^[0-9a-f]{32}$ ]]; then
    echo "Invalid bet_id: $id (must be 32 hex chars)" >&2
    exit 1
  fi
done

APP="${FLY_APP:-bettracker-discord-bot}"
LOCAL_TMP=$(mktemp -t pull-bet.XXXXXX.js)
REMOTE_TMP="/tmp/pull-bet-$$-$(date +%s).js"
trap 'rm -f "$LOCAL_TMP"' EXIT

IDS_JS=""
for id in "$@"; do
  [ -n "$IDS_JS" ] && IDS_JS="$IDS_JS, "
  IDS_JS="${IDS_JS}'$id'"
done

cat > "$LOCAL_TMP" <<JS
const db = require('better-sqlite3')('/data/bettracker.db', { readonly: true });
const ids = [$IDS_JS];
const placeholders = ids.map(() => '?').join(',');
const rows = db.prepare(
  'SELECT id, description, created_at, event_date, odds, units, ' +
  'sport, league, capper_id, source, source_url, result ' +
  'FROM bets WHERE id IN (' + placeholders + ')'
).all(...ids);
console.log(JSON.stringify(rows, null, 2));
JS

fly ssh sftp shell -a "$APP" >/dev/null 2>&1 <<SFTP
put $LOCAL_TMP $REMOTE_TMP
SFTP

fly ssh console -a "$APP" -C "bash -c \"NODE_PATH=/app/node_modules node $REMOTE_TMP\""

fly ssh console -a "$APP" -C "rm -f $REMOTE_TMP" >/dev/null 2>&1 || true
