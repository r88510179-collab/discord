#!/usr/bin/env bash
#
# run-fly-sql.sh — Execute readonly SQL against /data/bettracker.db on Fly.
#
# Usage:
#   bash scripts/run-fly-sql.sh "SELECT ... FROM ... LIMIT 10;"
#
# Returns rows as JSON. Readonly enforced at the better-sqlite3 layer.
# DDL/DML (INSERT/UPDATE/DELETE/CREATE/DROP/ALTER) are rejected client-side
# before the SQL is ever sent to Fly.
#
# Implementation mirrors pull-single-bet.sh — local JS file, sftp upload,
# remote node execution — to avoid nested quote-escape collisions from
# inline node -e.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: bash $0 \"<SQL>\"" >&2
  exit 1
fi

SQL="$1"

# Hard-block any keyword that mutates state. SQLite readonly mode would
# block these too, but we want a fast-fail before round-tripping to Fly.
SQL_UPPER=$(echo "$SQL" | tr '[:lower:]' '[:upper:]')
for kw in INSERT UPDATE DELETE DROP CREATE ALTER REPLACE TRUNCATE PRAGMA_WRITE; do
  if echo "$SQL_UPPER" | grep -qE "(^|[^A-Z_])${kw}([^A-Z_]|$)"; then
    # Allow PRAGMA reads — they're explicitly required by the investigation.
    if [ "$kw" = "PRAGMA_WRITE" ]; then continue; fi
    echo "Refused: SQL contains '${kw}' which is not allowed in readonly mode." >&2
    exit 2
  fi
done

APP="${FLY_APP:-bettracker-discord-bot}"
LOCAL_TMP=$(mktemp -t run-sql.XXXXXX.js)
REMOTE_TMP="/tmp/run-sql-$$-$(date +%s).js"
trap 'rm -f "$LOCAL_TMP"' EXIT

# Embed SQL as a base64 blob so it survives nested quoting unchanged.
SQL_B64=$(printf '%s' "$SQL" | base64 | tr -d '\n')

cat > "$LOCAL_TMP" <<JS
const db = require('better-sqlite3')('/data/bettracker.db', { readonly: true });
const sql = Buffer.from('$SQL_B64', 'base64').toString('utf8');
try {
  const rows = db.prepare(sql).all();
  console.log(JSON.stringify(rows, null, 2));
} catch (e) {
  console.error('SQL error:', e.message);
  process.exit(3);
}
JS

fly ssh sftp shell -a "$APP" >/dev/null 2>&1 <<SFTP
put $LOCAL_TMP $REMOTE_TMP
SFTP

fly ssh console -a "$APP" -C "bash -c \"NODE_PATH=/app/node_modules node $REMOTE_TMP\""

fly ssh console -a "$APP" -C "rm -f $REMOTE_TMP" >/dev/null 2>&1 || true
