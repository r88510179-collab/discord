// ═══════════════════════════════════════════════════════════
// sgpWouldHoldPulse — render the `ocr_sgp_would_hold` shadow measurement
// (PR #43) as ONE compact line for the #bot-audits health pulse.
//
// THROWAWAY: this exists only to make the SGP would-hold measurement visible
// without hand-running SQL. Delete this module + its pulse wiring + its test
// once SGP PR 2b ships (the flip drop→hold on a PASS makes the measurement
// moot). Tracked in the OCR-first backlog.
//
// READ-ONLY. SELECT only — no writes, no schema change. The section builder is
// FAIL-SOFT: any throw returns null so the caller drops the section and the
// pulse is never broken or delayed.
//
// `formatSgpWouldHold` is a PURE function (no DB/network/env) so it is unit
// tested directly (tests/sgp-would-hold-pulse.test.js); the one-line DB glue in
// `buildSgpWouldHoldSection` is covered by `npm run check` + the PR grep proof,
// matching the repo's pure-helper test convention (cf. gate3-would-fire-audit).
// ═══════════════════════════════════════════════════════════

'use strict';

// pipeline_events.created_at is INTEGER epoch SECONDS (NOT ISO text). strftime
// returns a numeric epoch string which SQLite coerces to the column's numeric
// affinity, so this comparison is correct — unlike datetime('now',...), which
// returns ISO text and silently matches 0 rows (see docs/DEPLOY_CHECKLIST §3a).
// 7-day window: HRB SGP volume is low, so a 24h window would usually read empty.
const SGP_WOULD_HOLD_SQL = `
  SELECT json_extract(payload,'$.pass')   AS pass,
         json_extract(payload,'$.reason') AS reason,
         count(*)                         AS c
  FROM pipeline_events
  WHERE event_type='ocr_sgp_would_hold'
    AND created_at > strftime('%s','now','-7 day')
  GROUP BY 1,2
  ORDER BY c DESC
`;

// json_extract of a JSON boolean yields 1/0, but tolerate true/'1'/'true' too.
function isPass(v) {
  return v === 1 || v === true || v === '1' || v === 'true';
}

// rows: [{ pass, reason, c }] from SGP_WOULD_HOLD_SQL (grouped by pass+reason).
// Returns the single compact pulse line. Pure; never throws on well-shaped rows.
function formatSgpWouldHold(rows) {
  const data = Array.isArray(rows) ? rows : [];
  const n = (v) => Number(v) || 0;
  const total = data.reduce((s, r) => s + n(r.c), 0);
  if (total === 0) return 'SGP would-hold (7d): none yet';

  const pass = data.filter((r) => isPass(r.pass)).reduce((s, r) => s + n(r.c), 0);
  const fail = total - pass;
  const pct = Math.round((pass / total) * 100);

  let line = `SGP would-hold (7d): ${total} events · PASS ${pass} (${pct}%) · FAIL ${fail}`;

  if (fail > 0) {
    const reasons = data
      .filter((r) => !isPass(r.pass))
      .reduce((m, r) => {
        const k = r.reason == null || r.reason === '' ? 'unknown' : String(r.reason);
        m[k] = (m[k] || 0) + n(r.c);
        return m;
      }, {});
    const breakdown = Object.entries(reasons)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, c]) => `${reason} ${c}`)
      .join(', ');
    if (breakdown) line += ` — ${breakdown}`;
  }

  return line;
}

// Run the read-only query via the caller's better-sqlite3 handle and build the
// pulse section object ({ title, lines, color }). FAIL-SOFT: any throw → null so
// the caller omits the section. Never writes, never throws.
function buildSgpWouldHoldSection(db) {
  try {
    const rows = db.prepare(SGP_WOULD_HOLD_SQL).all();
    return { title: '🧮 SGP Would-Hold', lines: [formatSgpWouldHold(rows)], color: 0x3498DB };
  } catch (_) {
    return null;
  }
}

module.exports = { formatSgpWouldHold, buildSgpWouldHoldSection, SGP_WOULD_HOLD_SQL };
