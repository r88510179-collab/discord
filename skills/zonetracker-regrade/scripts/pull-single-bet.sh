#!/usr/bin/env bash
#
# pull-single-bet.sh — Pull raw bet details from bettracker.db for specific bet IDs.
#
# Usage:
#   bash scripts/pull-single-bet.sh <bet_id_1> [bet_id_2] [bet_id_3] ...
#
# Example:
#   bash scripts/pull-single-bet.sh c532bab5980425901d0e5bf00b131d6a 6d0dcce342ad5d2db9f7c73e88e0a6cb
#
# Returns JSON with: id, description, created_at, event_date, odds, units, sport,
# league, capper_id, source, source_url for each bet.
#
# Requires: fly CLI authenticated, access to bettracker-discord-bot.
#
# Common use cases (per methodology.md):
#   - Disambiguate target date for a bet with ambiguous timing
#   - Verify capper source for capper-class anchoring
#   - Pull raw description when a parlay's structure is ambiguous
#   - Resolve disputes between grading passes

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: bash $0 <bet_id_1> [bet_id_2] ..." >&2
  echo "Each bet_id must be a 32-char hex string." >&2
  exit 1
fi

# Validate all IDs are 32-char hex
for id in "$@"; do
  if ! [[ "$id" =~ ^[0-9a-f]{32}$ ]]; then
    echo "Invalid bet_id: $id (must be 32 hex chars)" >&2
    exit 1
  fi
done

# Build the JS array of IDs with proper quoting for the nested shell layers
ids_js=""
placeholders=""
for id in "$@"; do
  if [ -n "$ids_js" ]; then
    ids_js="$ids_js,"
    placeholders="$placeholders,"
  fi
  ids_js="${ids_js}'\\''$id'\\''"
  placeholders="$placeholders?"
done

# Fly SSH: NODE_PATH must be set so better-sqlite3 resolves.
# bash -c wrapper is required for env var propagation.
fly ssh console -a bettracker-discord-bot -C "bash -c \"NODE_PATH=/app/node_modules node -e \\\"const db=require('\\\\''better-sqlite3'\\\\'')('\\\\''/data/bettracker.db'\\\\'', {readonly:true}); const ids=[$ids_js]; const rows=db.prepare('\\\\''SELECT id, description, created_at, event_date, odds, units, sport, league, capper_id, source, source_url FROM bets WHERE id IN ($placeholders)'\\\\'').all(...ids); console.log(JSON.stringify(rows, null, 2));\\\"\""
