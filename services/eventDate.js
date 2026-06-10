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
// recoverHold's backdate path (services/holdReview.js) writes event_date
// directly from the Discord snowflake — already a valid datetime — and
// intentionally does not pass through here.
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

/**
 * Normalize a raw event_date for storage in bets.event_date.
 *
 * @param {*} raw - extractor output (string, Date, or anything)
 * @param {Date|string|number} [createdAt] - the bet's creation moment;
 *   defaults to now, which is what created_at gets at insert time.
 * @returns {string|null} ISO-8601 UTC datetime, or null when unparseable.
 */
function normalizeEventDateForStorage(raw, createdAt = new Date()) {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw.toISOString();
  const s = String(raw).trim();
  if (!s) return null;

  const anchor = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const anchorOk = !isNaN(anchor.getTime());

  // Time-only: "9:10PM ET" / "3:00 PM ET" — the age-gate poison. Resolve
  // against created_at's ET calendar date. A leading weekday ("THU 6:29AM ET")
  // is the slip's post-day label, so it resolves the same way.
  const timeOnly = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)\b/i)
    || s.match(/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+(\d{1,2}):(\d{2})\s*(am|pm)\b/i);
  if (timeOnly) {
    if (!anchorOk) return null;
    const d = etParts(anchor);
    return etWallClockToUtc(d.year, d.month, d.day, to24h(timeOnly[1], timeOnly[3]), parseInt(timeOnly[2], 10)).toISOString();
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
    return attempt.toISOString();
  }

  // "4/12/26 5:00 PM" — explicit date, time read as ET wall clock.
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (m) {
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    return etWallClockToUtc(year, parseInt(m[1], 10), parseInt(m[2], 10), to24h(m[4], m[6]), parseInt(m[5], 10)).toISOString();
  }

  // Already a real datetime (ISO, "YYYY-MM-DD HH:MM:SS", etc.). The length
  // guard rejects bare numbers like "2026" that Date would happily parse.
  const generic = new Date(s);
  if (!isNaN(generic.getTime()) && s.length > 8) return generic.toISOString();

  console.warn(`[eventDateStorage] unparseable event_date dropped, storing NULL: "${s.slice(0, 80)}"`);
  return null;
}

module.exports = { normalizeEventDateForStorage, etWallClockToUtc, etParts };
