// ═══════════════════════════════════════════════════════════
// Write-time event_date normalization.
//
// bets.event_date used to accept whatever string the extractor emitted.
// Time-only values like "9:10PM ET" poisoned the grader's age gate: the
// read-side normalizer (services/ai.js normalizeEventDate) re-anchors a
// time-only string to "today" on EVERY poll, so the event sits a few
// hours in the future forever and the bet returns "too soon to grade"
// until its attempts burn to quarantine.
//
// normalizeEventDateForStorage is the single write-path gate (called from
// createBet in services/database.js). Hard rule it enforces:
//   stored event_date is NULL or an ISO-8601 UTC datetime — never a raw
//   unparseable string.
//
// Time-only strings resolve against the bet's created_at calendar date in
// ET (sportsbook slips print Eastern times); dated formats without a year
// anchor to created_at's year. Anything else stores NULL — the grader
// already falls back to created_at when event_date is NULL.
//
// A second backstop runs on every PARSED datetime before it is stored: a
// sanity guard that NULLs values implausibly far from created_at (see
// applyEventDateSanityGuard below). It stops the vision extractor's
// real-but-stale dates (e.g. a 2023 World-Cup fixture on a 2026 bet) from
// being trusted event_date-first by the grader. NULL — never throw — so the
// bet still saves and falls back to created_at.
//
// EVENT_DATE_SANITY_MODE gates TELEMETRY ONLY, not the guard itself: the
// NULLing above shipped always-on (#153/#154) and is live prod behavior, so
// unset/off = byte-identical today (guard NULLs, warn log only). shadow and
// enforce additionally report each rejection to the caller via
// opts.onSanityReject so createBet can emit an event_date_sanity_rejected
// pipeline event carrying the rejected value — the reviewable paper trail the
// warn log (ephemeral Fly logs) is not. enforce ≡ shadow today; the third
// state exists so the flag reads like every other tri-state ladder and leaves
// room if enforcement semantics ever need to diverge from telemetry.
//
// recoverHold's backdate path (services/holdReview.js) writes event_date
// directly from the Discord snowflake — already a valid datetime, and
// derived from the SAME timestamp it stamps into created_at (same calendar
// day → can never trip the sanity guard) — and intentionally does not pass
// through here.
// ═══════════════════════════════════════════════════════════

const ET_ZONE = 'America/New_York';

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Calendar fields of `date` as seen on an ET wall clock.
function etParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour === 24 ? 0 : +p.hour, // some ICU versions render midnight as 24
    minute: +p.minute, second: +p.second,
  };
}

// ET wall-clock fields → UTC Date. Two adjustment passes converge across
// DST boundaries (EST/EDT offset differs by an hour).
function etWallClockToUtc(year, month, day, hour, minute) {
  const want = Date.UTC(year, month - 1, day, hour, minute, 0);
  let ts = want;
  for (let i = 0; i < 2; i++) {
    const p = etParts(new Date(ts));
    const rendered = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    ts += want - rendered;
  }
  return new Date(ts);
}

function to24h(hourStr, ampm) {
  let h = parseInt(hourStr, 10);
  if (/pm/i.test(ampm) && h !== 12) h += 12;
  if (/am/i.test(ampm) && h === 12) h = 0;
  return h;
}

// Write-time sanity bounds on a PARSED event_date, relative to created_at.
// Derived from the live distribution: every legitimate bet has a created→event
// gap of -1..+8 days (max forward +8 = a real golf futures; the only negative,
// -1, is a timezone slice artifact). Every corrupt value is hundreds of days
// off (prior-year 2023/2022/2024 fixtures and a 2001 NCAAM on 2026 bets —
// 354..9131 days). The cliff between legit (+8d) and garbage (-354d) is ~346
// days, so the bounds below are deliberately wide — ~7x the real +8 max — to
// never clip a legitimate multi-week future while still catching the staleness
// the extractor occasionally emits. -2 (not -1) keeps the timezone artifact
// safe; +60 leaves room for real multi-week futures.
//
// GAP-ONLY by design: the guard compares instants by their millisecond gap and
// NOTHING else. There is deliberately no calendar-year / cross-year rule — the
// gap bounds already null every wrong-year date, and a year rule would ALSO null
// legitimate same-week Dec→Jan bets days apart (bowls, NFL Wk18, NBA), which
// must be preserved. (A prior cross-year rule was removed for exactly that
// false-positive.)
const EVENT_DATE_GUARD_MIN_GAP_DAYS = -2;
const EVENT_DATE_GUARD_MAX_GAP_DAYS = 60;

// Backstop a parsed event_date before storage. Returns the ISO string when the
// value is plausible, or NULL (never throws) when it is implausibly far from
// created_at — so the bet still saves and the grader falls back to created_at.
//
// ONE rule (gap-only): NULL when (event_date - created_at) < -2 days OR
// > +60 days. There is NO cross-year / calendar-year rule — see the bounds
// comment above. A New-Year's-boundary bet (created late Dec, game early Jan —
// bowls / NFL Wk18 / NBA) is cross-year but only days apart, so it stays within
// bounds and is PRESERVED. Only the hundreds-of-days-off garbage is nulled. The
// warn log records gapDays so the thresholds can be tuned from real logs.
//
// When no usable created_at anchor is available the value cannot be compared, so
// it is preserved unchanged (matches the pre-guard behavior of the dated
// branches, which returned the parsed value regardless of the anchor).
function applyEventDateSanityGuard(date, anchor, raw, opts) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return null;
  if (!(anchor instanceof Date) || isNaN(anchor.getTime())) return date.toISOString();

  const gapDays = (date.getTime() - anchor.getTime()) / 86400000;
  const outOfBounds = gapDays < EVENT_DATE_GUARD_MIN_GAP_DAYS || gapDays > EVENT_DATE_GUARD_MAX_GAP_DAYS;

  if (outOfBounds) {
    const idTag = opts && opts.betId ? ` bet=${opts.betId}` : '';
    console.warn(
      `[eventDateStorage] implausible event_date NULLed${idTag}: value=${date.toISOString()} ` +
      `created=${anchor.toISOString()} gapDays=${gapDays.toFixed(1)} rule=out-of-bounds ` +
      `raw="${String(raw).slice(0, 80)}"`,
    );
    // Surface the rejection to the caller (createBet emits the
    // event_date_sanity_rejected pipeline event when EVENT_DATE_SANITY_MODE
    // is shadow/enforce). Fires ONLY for out-of-bounds rejections — an
    // unparseable string never reaches this guard. The callback must never
    // break the NULL-never-throw contract.
    if (opts && typeof opts.onSanityReject === 'function') {
      try {
        opts.onSanityReject({
          value: date.toISOString(),
          gapDays,
          raw: String(raw).slice(0, 120),
        });
      } catch (_) { /* telemetry must not affect the write */ }
    }
    return null;
  }
  return date.toISOString();
}

// EVENT_DATE_SANITY_MODE — strict compare, read per call (injectable raw for
// tests), unset/anything-else → 'off'. Same tri-state idiom as
// PIPELINE_IDEM_MODE / EVENT_DATE_SLATE. NOTE the atypical semantics: the
// guard's NULLing is NOT gated (always-on since #153/#154) — this flag gates
// only the pipeline-event telemetry on rejections. off = warn log only
// (byte-identical current behavior); shadow/enforce = also emit one
// event_date_sanity_rejected pipeline event per rejection (see createBet).
function resolveEventDateSanityMode(raw = process.env.EVENT_DATE_SANITY_MODE) {
  if (raw === 'shadow') return 'shadow';
  if (raw === 'enforce') return 'enforce';
  return 'off';
}

/**
 * Normalize a raw event_date for storage in bets.event_date.
 *
 * @param {*} raw - extractor output (string, Date, or anything)
 * @param {Date|string|number} [createdAt] - the bet's creation moment;
 *   defaults to now, which is what created_at gets at insert time.
 * @param {{betId?:string}} [opts] - context for the sanity-guard warn log.
 * @returns {string|null} ISO-8601 UTC datetime, or null when unparseable or
 *   nulled by the sanity guard.
 */
function normalizeEventDateForStorage(raw, createdAt = new Date(), opts = {}) {
  if (raw === null || raw === undefined) return null;

  const anchor = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const anchorOk = !isNaN(anchor.getTime());

  if (raw instanceof Date) return applyEventDateSanityGuard(raw, anchor, raw, opts);
  const s = String(raw).trim();
  if (!s) return null;

  // Time-only: "9:10PM ET" / "3:00 PM ET" — the age-gate poison. Resolve
  // against created_at's ET calendar date. A leading weekday ("THU 6:29AM ET")
  // is the slip's post-day label, so it resolves the same way.
  const timeOnly = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)\b/i)
    || s.match(/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+(\d{1,2}):(\d{2})\s*(am|pm)\b/i);
  if (timeOnly) {
    if (!anchorOk) return null;
    const d = etParts(anchor);
    return applyEventDateSanityGuard(
      etWallClockToUtc(d.year, d.month, d.day, to24h(timeOnly[1], timeOnly[3]), parseInt(timeOnly[2], 10)),
      anchor, raw, opts);
  }

  // "Thu Apr 2 @ 10:30pm" / "Mon Apr 2 10:30pm" — month+day but no year.
  // Anchor to created_at's year; a date that lands >7d before the anchor is
  // assumed to wrap into the next year (mirrors the read-side normalizer).
  let m = s.match(/\w{3,}\s+(\w{3})\s+(\d{1,2})(?:\s*@\s*|\s+)(\d{1,2}):?(\d{0,2})\s*(am|pm)/i);
  if (m && MONTHS[m[1].toLowerCase()]) {
    if (!anchorOk) return null;
    let year = etParts(anchor).year;
    let attempt = etWallClockToUtc(year, MONTHS[m[1].toLowerCase()], parseInt(m[2], 10), to24h(m[3], m[5]), parseInt(m[4] || '0', 10));
    if (attempt.getTime() < anchor.getTime() - 7 * 24 * 3600000) {
      attempt = etWallClockToUtc(year + 1, MONTHS[m[1].toLowerCase()], parseInt(m[2], 10), to24h(m[3], m[5]), parseInt(m[4] || '0', 10));
    }
    return applyEventDateSanityGuard(attempt, anchor, raw, opts);
  }

  // "4/12/26 5:00 PM" — explicit date, time read as ET wall clock.
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (m) {
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    return applyEventDateSanityGuard(
      etWallClockToUtc(year, parseInt(m[1], 10), parseInt(m[2], 10), to24h(m[4], m[6]), parseInt(m[5], 10)),
      anchor, raw, opts);
  }

  // "Today 7:10 PM ET" / "Tonight 7:10PM" / "Tomorrow, 1:05 PM ET" — relative
  // to created_at, the format HRB renders constantly (the time-only regex is
  // ^\d-anchored, so a leading word never matches it). Resolve the time on
  // created_at's ET CALENDAR day (today/tonight) or that day + 1 (tomorrow).
  // The day is fed straight to etWallClockToUtc, which normalizes day/month/year
  // overflow (Dec 31 + 1 → Jan 1) AND applies the TARGET day's DST offset — so
  // "tomorrow" is correct even across a month boundary or a DST transition. (A
  // fixed +24h ms add is NOT used: it lands a day off when the anchor sits in
  // the short window adjacent to a spring-forward/fall-back transition.) A bare
  // "Today" with no time does NOT match — it falls through to NULL rather than
  // guess a start time.
  const rel = s.match(/^(today|tonight|tomorrow)\b,?\s*(\d{1,2}):(\d{2})\s*(am|pm)\b/i);
  if (rel) {
    if (!anchorOk) return null;
    const d = etParts(anchor);
    const day = /tomorrow/i.test(rel[1]) ? d.day + 1 : d.day;
    return applyEventDateSanityGuard(
      etWallClockToUtc(d.year, d.month, day, to24h(rel[2], rel[4]), parseInt(rel[3], 10)),
      anchor, raw, opts);
  }

  // Already a real datetime (ISO, "YYYY-MM-DD HH:MM:SS", etc.). The length
  // guard rejects bare numbers like "2026" that Date would happily parse.
  const generic = new Date(s);
  if (!isNaN(generic.getTime()) && s.length > 8) return applyEventDateSanityGuard(generic, anchor, raw, opts);

  console.warn(`[eventDateStorage] unparseable event_date dropped, storing NULL: "${s.slice(0, 80)}"`);
  return null;
}

module.exports = {
  normalizeEventDateForStorage,
  applyEventDateSanityGuard,
  resolveEventDateSanityMode,
  etWallClockToUtc,
  etParts,
  EVENT_DATE_GUARD_MIN_GAP_DAYS,
  EVENT_DATE_GUARD_MAX_GAP_DAYS,
};
