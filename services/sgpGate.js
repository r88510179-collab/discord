// ═══════════════════════════════════════════════════════════
// sgpGate — deterministic same-game-parlay confidence gate (PURE function).
//
// evaluateSgpGate({ declaredLegCount, parsedBet, ocrText }) → { pass, reason,
// normalizedBet, detail }. No DB, no network, no env, no side effects — given the
// same inputs it always returns the same output. NEVER throws.
//
// PURPOSE (PR 1 of 2 — gate only, NO wiring): an OCR-first Groq parse of an HRB
// SGP/SGPMAX slip is only trustworthy enough to route a slip to hold-enrichment
// (drop→hold on a PASS, per the signed-off design D2) when EVERY check below
// holds. This module is the single source of truth for that decision. It is DEAD
// CODE until a follow-up PR wires it in — nothing in services/ or handlers/
// requires it yet (intentional; see the build prompt + PR body).
//
// WHY a gate at all: the production SGP path today short-circuits to
// FALLBACK_GEMINI *before* Groq runs (services/ocrFirst.js extractViaOcr, the
// "SGP gate — BEFORE Groq" branch), so SGP slips never get an OCR parse and the
// HRB vision-failure census (DatDude) drops them. To safely rescue them we must
// be sure the parse is COMPLETE (every declared leg present), WELL-FORMED (every
// leg has a subject + market + line) and NOT HALLUCINATED (every subject appears
// verbatim in the OCR text). Anything less keeps the current behavior.
//
// FIELD MAPPING (confirmed against reports/sgp-content-spotcheck.json, 16 real
// SGP slips / 98 legs). The Groq OCR parse (services/ocrFirst.js OCR_PARSE_SYSTEM)
// emits per-leg `{ matchup, player, market, selection, odds, start_time }`. The
// gate's three required conceptual fields map as:
//   entity ← player (fallback matchup) — the bet subject; 97/98 verbatim in OCR.
//   market ← market, OR — when Groq left market empty and put the prop type in
//            `selection` (spot-check slip 10: 8/8 legs market:"" selection:"TO
//            RECORD 1+ HITS") — promoted from selection. "market-in-selection".
//   line   ← selection — the side+line ("Over 0.5"). For a binary prop whose
//            prop type WAS the selection (the promote case) line == market; both
//            are non-empty, which is all the gate requires (it does NOT demand a
//            numeric line — binary "HITS"/"To Record 1+ Hits" markets legitimately
//            have none; spot-check line-15 note).
//
// The two real FAIL shapes the census exhibits:
//   • phantom leg (slip 12): a game-odds line ("-118 / Orioles vs Blue Jays")
//     parsed as an extra leg → parsed count 4 vs declared 3 → SGP_COUNT_MISMATCH.
//     (It carries a matchup entity, so it is NOT a ticket-metadata leg and is NOT
//     silently dropped — the count mismatch is the signal that the parse is off.)
//   • boost/total odds (slip 1: total_odds "+3305", "33% Profit Boost"): lives in
//     `total_odds`, never a leg. A stray odds-only "leg" (no subject, content is
//     just an American-odds token) is excluded as ticket metadata before counting.
// ═══════════════════════════════════════════════════════════

'use strict';

// Stable reason codes (surfaced in PR-2 would-fire telemetry; keep these stable).
const SgpGateReason = Object.freeze({
  PASS: 'SGP_PASS',
  OCR_EMPTY: 'SGP_OCR_EMPTY',
  NO_DECLARED_COUNT: 'SGP_NO_DECLARED_COUNT',
  NO_LEGS: 'SGP_NO_LEGS',
  COUNT_MISMATCH: 'SGP_COUNT_MISMATCH',
  LEG_MISSING_FIELD: 'SGP_LEG_MISSING_FIELD',
  CONTRADICTION: 'SGP_CONTRADICTION',
  ENTITY_NOT_IN_OCR: 'SGP_ENTITY_NOT_IN_OCR',
});

function s(v) {
  return v == null ? '' : String(v).trim();
}

// Whitespace-insensitive, case-folded fold for the verbatim-in-OCR confidence
// check. HRB OCR routinely drops inter-word spaces ("WILLYADAMES",
// "OriolesvsYankees", "WHITESoxvsCubs"), so collapsing ALL whitespace on both the
// haystack and the needle is what makes "verbatim" match real OCR text. The
// result is always ≤ the raw text, so this can only loosen, never invent, a match.
function foldWs(v) {
  return s(v).toLowerCase().replace(/\s+/g, '');
}

// An American-odds token and nothing else (after stripping $ , whitespace), e.g.
// "+3305", "-118", "+110". Used to spot boost/total-odds values misparsed as legs.
function isOddsToken(v) {
  const t = s(v).replace(/[$,\s]/g, '');
  return /^[+-]?\d{2,5}$/.test(t);
}

// Derive the bet subject for a raw Groq leg: player, else matchup, else a
// pre-derived `entity` (so a caller may also pass the spot-check legView shape).
function legEntity(leg) {
  return s(leg.player) || s(leg.matchup) || s(leg.entity);
}

// Ticket-metadata leg = boost / total-odds value or a wholly empty leg that Groq
// emitted as a "leg" but which carries no bet. Excluded from the leg list BEFORE
// counting so a stray "+3305" never inflates the count (build-prompt: "Boost odds
// … never counted as a leg"). A leg with ANY subject (player OR matchup) is NEVER
// metadata — that keeps the slip-12 phantom (matchup entity) counted, so it still
// trips SGP_COUNT_MISMATCH rather than being silently swallowed.
function isTicketMetadataLeg(leg) {
  if (!leg || typeof leg !== 'object') return true; // junk entry — not a real leg
  if (legEntity(leg)) return false;                 // has a subject → a real (or phantom) leg
  const content = [s(leg.market), s(leg.selection)].filter(Boolean);
  if (content.length === 0) return true;            // nothing at all → drop
  return content.every(isOddsToken);                // only an odds token → boost/total odds
}

// Normalize a raw Groq leg into the gate's { entity, market, line } shape,
// applying the market-in-selection promotion. Pure; carries `raw` for callers.
function normalizeLeg(leg) {
  const entity = legEntity(leg);
  let market = s(leg.market);
  const selection = s(leg.selection);
  // Market-in-selection split: when market is empty, the prop type leaked into
  // selection (real: slip 10). Promote it so the leg is not wrongly rejected.
  if (!market && selection) market = selection;
  const line = selection; // the side+line; equals market in the promoted binary-prop case
  return { entity, market, line, odds: s(leg.odds), raw: leg };
}

// Contradictory direction within a single leg — both Over and Under present.
function hasContradiction(nl) {
  const blob = `${nl.market} ${nl.line}`.toLowerCase();
  return /\bover\b/.test(blob) && /\bunder\b/.test(blob);
}

/**
 * evaluateSgpGate — deterministic PASS/FAIL for an OCR-first SGP parse.
 *
 * @param {object}  args
 * @param {number}  args.declaredLegCount  leg count parsed from the slip header
 *                  ("N-Bet Parlay"); the caller extracts it (PR 2). A positive
 *                  integer is REQUIRED — without a declared count there is nothing
 *                  to confirm the parse against, so the gate fails closed.
 * @param {object}  args.parsedBet         the Groq OCR parse: { bet_type,
 *                  total_odds, stake, payout, legs:[{matchup,player,market,
 *                  selection,odds,...}] }.
 * @param {string}  args.ocrText           raw OCR text (the hallucination guard).
 * @returns {{ pass:boolean, reason:string, normalizedBet:object|null, detail:object }}
 *
 * PASS requires ALL of:
 *   1. ocrText is non-empty.
 *   2. declaredLegCount is a positive integer.
 *   3. parsedBet has ≥1 leg.
 *   4. real-leg count (after excluding boost/odds-only ticket-metadata legs)
 *      EQUALS declaredLegCount.
 *   5. every real leg has a non-empty entity, market (promoting prop-type from
 *      selection) and line.
 *   6. no leg carries a contradictory Over+Under direction.
 *   7. every leg entity appears verbatim (whitespace-insensitive) in ocrText.
 * Any miss → { pass:false, reason:<specific code>, normalizedBet:null }.
 *
 * GUARDRAIL (enforced when wired in PR 2): ONLY pass:true may route a slip to
 * hold-enrichment / drop→hold. Every FAIL (and OCR missing/empty/malformed) keeps
 * the current behavior. Nothing here reaches live grading — a hold is human review.
 */
function evaluateSgpGate({ declaredLegCount, parsedBet, ocrText } = {}) {
  const fail = (reason, detail = {}) => ({ pass: false, reason, normalizedBet: null, detail });

  // 1. OCR text present.
  const text = typeof ocrText === 'string' ? ocrText : '';
  if (!text.trim()) return fail(SgpGateReason.OCR_EMPTY);

  // 2. Declared leg count present and valid (no count → nothing to verify against).
  const declared = Number(declaredLegCount);
  if (!Number.isInteger(declared) || declared < 1) {
    return fail(SgpGateReason.NO_DECLARED_COUNT, { declaredLegCount });
  }

  // 3. Parsed legs present.
  const rawLegs = parsedBet && Array.isArray(parsedBet.legs)
    ? parsedBet.legs.filter((l) => l && typeof l === 'object')
    : [];
  if (rawLegs.length === 0) return fail(SgpGateReason.NO_LEGS);

  // 4. Exclude boost/odds-only ticket-metadata legs, then the count MUST match.
  const realLegs = rawLegs.filter((l) => !isTicketMetadataLeg(l));
  if (realLegs.length !== declared) {
    return fail(SgpGateReason.COUNT_MISMATCH, {
      declared,
      parsed: realLegs.length,
      rawLegCount: rawLegs.length,
      excluded: rawLegs.length - realLegs.length,
    });
  }

  // 5. Per-leg field presence (after market-in-selection normalization).
  const legs = realLegs.map(normalizeLeg);
  for (let i = 0; i < legs.length; i++) {
    const nl = legs[i];
    if (!nl.entity || !nl.market || !nl.line) {
      return fail(SgpGateReason.LEG_MISSING_FIELD, {
        index: i,
        entity: nl.entity || null,
        hasMarket: !!nl.market,
        hasLine: !!nl.line,
      });
    }
  }

  // 6. No contradictory Over+Under within a leg.
  for (let i = 0; i < legs.length; i++) {
    if (hasContradiction(legs[i])) {
      return fail(SgpGateReason.CONTRADICTION, { index: i, market: legs[i].market, line: legs[i].line });
    }
  }

  // 7. Confidence: every entity appears verbatim (whitespace-insensitive) in OCR.
  const hay = foldWs(text);
  for (let i = 0; i < legs.length; i++) {
    if (!hay.includes(foldWs(legs[i].entity))) {
      return fail(SgpGateReason.ENTITY_NOT_IN_OCR, { index: i, entity: legs[i].entity });
    }
  }

  // PASS — normalizedBet carries the cleaned legs for downstream hold-enrichment.
  return {
    pass: true,
    reason: SgpGateReason.PASS,
    normalizedBet: {
      bet_type: s(parsedBet.bet_type) || null,
      total_odds: s(parsedBet.total_odds) || null,
      stake: s(parsedBet.stake) || null,
      payout: s(parsedBet.payout) || null,
      declaredLegCount: declared,
      legs: legs.map((nl) => ({ entity: nl.entity, market: nl.market, line: nl.line, odds: nl.odds || null })),
    },
    detail: { legCount: legs.length, excluded: rawLegs.length - realLegs.length },
  };
}

module.exports = {
  evaluateSgpGate,
  SgpGateReason,
  // exposed for unit tests / introspection
  normalizeLeg,
  isTicketMetadataLeg,
  isOddsToken,
  foldWs,
};
