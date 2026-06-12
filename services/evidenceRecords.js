// ═══════════════════════════════════════════════════════════
// Evidence-record layer (Gate 4 precondition).
//
// The grader is handed a single flat evidence string (`evidenceForModel` in
// services/grading.js — the snippet titles + bodies joined and sliced to 1500
// chars). Gate 3 proves the model's `evidence_quote` is a verbatim substring of
// THAT string. But a verbatim quote can still come from the WRONG game: the
// 2026-06-12 incident graded a June-12 World Cup opener LOSS against a quote
// ("FT USMNT <strong>1-2 Germany</strong>") lifted from the June-6 friendly —
// right quote, wrong fixture.
//
// This module builds a *parallel*, structured view of that same evidence — one
// record per search hit, each carrying the hit's char span inside
// `evidenceForModel` plus the calendar dates extracted from that span — WITHOUT
// changing a single byte of the string the model sees (the records only annotate
// it). Gate 4 (services/grading.js) then date-checks the quote-bearing record(s)
// against the bet's game window.
//
// Dependency-free by design (no npm deps, no DB, no env, no I/O) so it stays a
// pure, heavily-unit-tested layer. Gate 5 (season-vs-game scope reject) will add
// a `scope` tag to the same records — the `scope: null` field is its stub.
// ═══════════════════════════════════════════════════════════

'use strict';

// Month name → 1-based month number. Full names + 3-letter abbreviations (plus
// the common 4-letter "Sept").
const MONTH_TO_NUM = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

// Alternation matching any full or abbreviated month name (case-insensitive at
// the call sites via the `i` flag).
const MONTH_NAME_RE =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const MS_PER_DAY = 86400000;

function pad2(n) { return String(n).padStart(2, '0'); }

// True only for a real, plausible calendar date. The Date round-trip rejects
// impossible days (Feb 30, Apr 31, …) so "garbage in → empty out"; the year
// floor rejects sub-1900 / post-2100 junk (e.g. a malformed 3-digit "year")
// that would round-trip fine through Date.UTC but can never be a real game date
// and — being un-window-able — would otherwise always read as off-date.
function isValidYMD(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1900 || y > 2100) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function toISO(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }

// Epoch millis of a YYYY-MM-DD day at UTC midnight, or NaN.
function dayMs(iso) {
  return Date.parse(`${String(iso == null ? '' : iso).slice(0, 10)}T00:00:00Z`);
}

// Extract every calendar date in `text`, normalized to YYYY-MM-DD, deduped and
// sorted. Conservative: only the documented formats, only real dates.
//
// Formats:
//   - ISO            YYYY-MM-DD
//   - Month D, YYYY  full + 3-letter month names (comma optional for HTML noise)
//   - M/D/YYYY and M/D/YY  (US month-first; 2-digit year → 20YY)
//   - year-less Month D / Mon D → resolved to the anchor year (anchor year − 1
//     when that lands the date > ~300 days in the future, wrapping a Jan bet
//     that cites the prior December).
//
// HTML noise: tags are stripped to a space first, so `June <strong>6</strong>,
// 2026` and `FT USMNT <strong>1-2 Germany</strong>` both behave — tags between
// tokens never block extraction of a nearby date.
function extractDates(text, anchorISO) {
  if (!text) return [];
  const clean = String(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  const found = new Set();

  // a. ISO YYYY-MM-DD
  for (const m of clean.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (isValidYMD(y, mo, d)) found.add(toISO(y, mo, d));
  }

  // b. Month D, YYYY  /  Mon D, YYYY  (year present)
  const reMonthYear = new RegExp(
    `\\b${MONTH_NAME_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(\\d{4})\\b`, 'gi');
  for (const m of clean.matchAll(reMonthYear)) {
    const mo = MONTH_TO_NUM[m[1].toLowerCase()];
    const d = +m[2], y = +m[3];
    if (mo && isValidYMD(y, mo, d)) found.add(toISO(y, mo, d));
  }

  // c. M/D/YYYY and M/D/YY (year is EXACTLY 4 or 2 digits — a 3-digit token is
  // not a year and must not be parsed as one).
  for (const m of clean.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g)) {
    const mo = +m[1], d = +m[2];
    let y = +m[3];
    if (m[3].length === 2) y = 2000 + y; // 2-digit year → 20YY (recent sports evidence)
    if (isValidYMD(y, mo, d)) found.add(toISO(y, mo, d));
  }

  // d. Year-less Month D / Mon D → anchor year, wrapping year boundaries: − 1 if
  // the date lands > ~300d in the FUTURE (a January bet citing the prior
  // December), + 1 if it lands > ~300d in the PAST (a December bet citing the
  // upcoming January). KNOWN year-less limitations (intentionally deferred —
  // contained by the union-of-dates rule + shadow default, see PR notes):
  //   - a month word used as a verb ("may 6 times", "march 5 times") can yield a
  //     spurious date (the case-insensitive flag can't disambiguate);
  //   - "Month D, YY" (2-digit year) is treated as year-less here (the explicit
  //     2-digit year is dropped) — safe-direction, never fabricates a fire.
  const anchorYear = Number(String(anchorISO == null ? '' : anchorISO).slice(0, 4));
  const anchorMs = dayMs(anchorISO);
  if (Number.isInteger(anchorYear) && !Number.isNaN(anchorMs)) {
    // Negative lookahead skips dates already captured WITH a year by rule (b).
    const reMonthOnly = new RegExp(
      `\\b${MONTH_NAME_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*,?\\s*\\d{4})`, 'gi');
    for (const m of clean.matchAll(reMonthOnly)) {
      const mo = MONTH_TO_NUM[m[1].toLowerCase()];
      const d = +m[2];
      if (!mo || !isValidYMD(anchorYear, mo, d)) continue;
      let y = anchorYear;
      const candMs = dayMs(toISO(y, mo, d));
      if (!Number.isNaN(candMs)) {
        const diffDays = (candMs - anchorMs) / MS_PER_DAY;
        if (diffDays > 300 && isValidYMD(anchorYear - 1, mo, d)) y = anchorYear - 1;
        else if (diffDays < -300 && isValidYMD(anchorYear + 1, mo, d)) y = anchorYear + 1;
        else if (Math.abs(diffDays) > 300) continue; // wrap target itself invalid
      }
      found.add(toISO(y, mo, d));
    }
  }

  return [...found].sort();
}

// Reassemble the exact evidence string services/grading.js hands the model:
//   for each hit: push title (if truthy), push `  ${snippet}` (if truthy)
//   then snippets.join('\n')
// This is the single source of truth for the assembly algorithm; the
// byte-identity test asserts it matches the (unchanged) call-site loop, which is
// what proves the record layer never perturbs the model-visible string.
function assembleEvidenceText(searchResults) {
  const results = Array.isArray(searchResults) ? searchResults : [];
  const snippets = [];
  for (const r of results) {
    // String() matches the call site's join-time coercion (snippets.join) for any
    // non-string-but-truthy title; the produced bytes are identical either way.
    if (r && r.title) snippets.push(String(r.title));
    if (r && r.snippet) snippets.push(`  ${r.snippet}`);
  }
  return snippets.join('\n');
}

// Build the parallel record array. `evidenceForModel` is the ALREADY-assembled,
// already-sliced (≤1500) string the call site computed — passed in so the
// records' char spans land in exactly the bytes the model saw. Each record:
//   { idx, backend, url, domain, snippet, char_start, char_end, dates, scope }
// where char_start/char_end locate the hit's visible footprint inside
// `evidenceForModel`, `snippet` is that footprint, and `dates` are the dates
// extracted from it. Hits truncated away by the 1500-char slice collapse to an
// empty span (and therefore no dates) — conservative by construction.
function buildEvidenceRecords(searchResults, evidenceForModel, anchorISO, opts = {}) {
  const results = Array.isArray(searchResults) ? searchResults : [];
  const evText = String(evidenceForModel == null ? '' : evidenceForModel);
  const evLen = evText.length;
  const defaultBackend = opts.defaultBackend || null;

  // Flatten to the same line sequence assembleEvidenceText/the call site produce,
  // tagging each line with its originating hit index.
  const lines = []; // { idx, text }
  results.forEach((r, idx) => {
    // String()-coerce so the offset math (ln.text.length, measured BEFORE the
    // join) is never NaN for a non-string-but-truthy title — which would
    // cascade NaN spans to every later record and silently disable Gate 4.
    // Byte-neutral for the normal string case; mirrors the call-site join.
    if (r && r.title) lines.push({ idx, text: String(r.title) });
    if (r && r.snippet) lines.push({ idx, text: `  ${r.snippet}` });
  });

  // Cumulative char offsets inside lines.join('\n'): a single '\n' separates
  // consecutive lines, so start(k) = Σ_{j<k} len(j) + k.
  const spanByIdx = new Map();
  let cursor = 0;
  lines.forEach((ln, k) => {
    if (k > 0) cursor += 1; // the '\n' join separator
    const start = cursor;
    cursor += ln.text.length;
    const end = cursor;
    const prev = spanByIdx.get(ln.idx);
    if (prev) { prev.start = Math.min(prev.start, start); prev.end = Math.max(prev.end, end); }
    else { spanByIdx.set(ln.idx, { start, end }); }
  });

  return results.map((r, idx) => {
    const span = spanByIdx.get(idx);
    // Clamp spans into the (possibly truncated) model-visible string.
    const char_start = span ? Math.min(span.start, evLen) : Math.min(cursor, evLen);
    const char_end = span ? Math.min(span.end, evLen) : char_start;
    const snippet = evText.slice(char_start, char_end);
    return {
      idx,
      backend: (r && r.backend) || defaultBackend,
      url: (r && (r.url || r.link)) || null,
      domain: (r && r.domain) || null,
      snippet,
      char_start,
      char_end,
      dates: extractDates(snippet, anchorISO),
      scope: null, // scope: TODO(Gate 5) — season-vs-game scope tag added later
    };
  });
}

// True when `dateISO` falls inside [anchor − tol, anchor + tol] (days, inclusive).
function isWithinWindow(dateISO, anchorISO, tolDays) {
  const d = dayMs(dateISO);
  const a = dayMs(anchorISO);
  if (Number.isNaN(d) || Number.isNaN(a)) return false;
  const tol = Number(tolDays);
  const span = Number.isFinite(tol) ? tol : 0;
  return Math.abs((d - a) / MS_PER_DAY) <= span + 1e-9;
}

// Pure off-date decision over the record layer. Locates the record(s) whose
// VISIBLE text contains the (Gate-3-)verified quote — using the SAME
// normalization Gate 3 used for its substring test — takes the union of their
// extracted dates, and classifies:
//   off_date       — ≥1 date, NONE inside the window → fire (off-date evidence)
//   date_ok        — ≥1 date inside the window       → pass
//   no_date_signal — quote not located, or located but the record carries no
//                    extractable date                → pass-through (we do not
//                    block on absence of signal)
// Returns { status, evdates, quoteIdxs, reason }.
function evaluateOffDate(records, evidenceQuote, anchorISO, tolDays, normalize) {
  const recs = Array.isArray(records) ? records : [];
  const norm = typeof normalize === 'function' ? normalize : (s => String(s == null ? '' : s));
  const needle = norm(evidenceQuote);

  let quoteIdxs = [];
  if (needle && needle.length > 0) {
    quoteIdxs = recs.filter(r => norm(r.snippet).includes(needle)).map(r => r.idx);
  }
  if (quoteIdxs.length === 0) {
    return { status: 'no_date_signal', evdates: [], quoteIdxs: [], reason: 'no_quote_match' };
  }

  const dateSet = new Set();
  for (const r of recs) {
    if (!quoteIdxs.includes(r.idx)) continue;
    for (const d of (r.dates || [])) dateSet.add(d);
  }
  const evdates = [...dateSet].sort();
  if (evdates.length === 0) {
    return { status: 'no_date_signal', evdates: [], quoteIdxs, reason: 'no_date_in_quote_record' };
  }

  const anyInWindow = evdates.some(d => isWithinWindow(d, anchorISO, tolDays));
  if (anyInWindow) return { status: 'date_ok', evdates, quoteIdxs, reason: 'date_in_window' };
  return { status: 'off_date', evdates, quoteIdxs, reason: 'OFF_DATE_EVIDENCE' };
}

module.exports = {
  extractDates,
  assembleEvidenceText,
  buildEvidenceRecords,
  isWithinWindow,
  evaluateOffDate,
  // Exported for unit tests only:
  _internal: { MONTH_TO_NUM, MONTH_NAME_RE, isValidYMD, toISO },
};
