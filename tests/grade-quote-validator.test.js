// ═══════════════════════════════════════════════════════════
// Gate 3 — quote-bound grading (code-enforced anti-hallucination).
//
// For any non-PENDING result, the model must return an evidence_quote that is
// an EXACT substring (whitespace-normalized) of the evidence it was given.
// Missing / paraphrased / fabricated quote → forced PENDING (UNVERIFIED_QUOTE).
// This is a string check, not a trust call — it must work with a small model.
//
// Pure function, no DB. DB_PATH points at a throwaway file because requiring
// grading.js loads database.js transitively.
// ═══════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbFile = path.join(os.tmpdir(), `bettracker-quote-validator-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

const grading = require('../services/grading');
const database = require('../services/database');
const { validateEvidenceQuote, resolveGate3Mode, applyGate3, buildGate3WouldFireMarker } = grading._internal;

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}\n    expected ${expected}\n    actual   ${actual}`); fail++; }
}

try {
  console.log('grade-quote-validator (Gate 3):');

  const EVIDENCE = 'Final: Boston Celtics 118, New York Knicks 112 (ESPN box score). Jayson Tatum scored 31 points.';

  // PASS: exact substring quote on a WIN.
  check('exact substring quote on WIN passes',
    validateEvidenceQuote({ status: 'WIN', evidence: 'Celtics won', evidence_quote: 'Boston Celtics 118, New York Knicks 112' }, EVIDENCE).ok,
    true);

  // PASS: exact substring on a LOSS.
  check('exact substring quote on LOSS passes',
    validateEvidenceQuote({ status: 'LOSS', evidence: 'Knicks lost', evidence_quote: 'New York Knicks 112' }, EVIDENCE).ok,
    true);

  // PASS: whitespace-normalized match (extra spaces / newlines collapse).
  check('whitespace-normalized quote passes',
    validateEvidenceQuote({ status: 'WIN', evidence: 'x', evidence_quote: 'Boston Celtics 118,\n   New York   Knicks 112' }, EVIDENCE).ok,
    true);

  // PASS: case-insensitive match.
  check('case-insensitive quote passes',
    validateEvidenceQuote({ status: 'WIN', evidence: 'x', evidence_quote: 'JAYSON TATUM SCORED 31 POINTS' }, EVIDENCE).ok,
    true);

  // FAIL: missing evidence_quote on a non-PENDING result.
  const missing = validateEvidenceQuote({ status: 'WIN', evidence: 'Celtics won' }, EVIDENCE);
  check('missing evidence_quote on WIN fails', missing.ok, false);
  check('missing evidence_quote reason is UNVERIFIED_QUOTE', missing.reason, 'UNVERIFIED_QUOTE');

  // FAIL: empty / whitespace-only quote.
  check('empty-string quote fails', validateEvidenceQuote({ status: 'WIN', evidence: 'x', evidence_quote: '' }, EVIDENCE).ok, false);
  check('whitespace-only quote fails', validateEvidenceQuote({ status: 'LOSS', evidence: 'x', evidence_quote: '   ' }, EVIDENCE).ok, false);

  // FAIL: paraphrased quote (not a verbatim substring).
  const paraphrased = validateEvidenceQuote({ status: 'WIN', evidence: 'x', evidence_quote: 'Celtics beat the Knicks by six' }, EVIDENCE);
  check('paraphrased quote fails', paraphrased.ok, false);
  check('paraphrased quote reason is UNVERIFIED_QUOTE', paraphrased.reason, 'UNVERIFIED_QUOTE');

  // FAIL: fabricated score not present in evidence (the hallucination case).
  check('fabricated score quote fails',
    validateEvidenceQuote({ status: 'WIN', evidence: 'x', evidence_quote: 'Celtics 130, Knicks 90' }, EVIDENCE).ok,
    false);

  // EXEMPT: PENDING never needs a quote.
  check('PENDING is exempt (no quote required)',
    validateEvidenceQuote({ status: 'PENDING', evidence: 'no final score yet' }, EVIDENCE).ok,
    true);
  check('PENDING exempt even with empty evidence text',
    validateEvidenceQuote({ status: 'PENDING' }, '').ok,
    true);

  // Robustness: non-PENDING against empty evidence text can never verify.
  check('WIN against empty evidence text fails',
    validateEvidenceQuote({ status: 'WIN', evidence: 'x', evidence_quote: 'anything' }, '').ok,
    false);

  // ── A3: punctuation normalization (still EXACT — folds cosmetic chars only) ──
  // model en-dash "118–112" matches evidence hyphen "118-112"
  check('en-dash quote matches hyphen evidence',
    validateEvidenceQuote({ status: 'WIN', evidence: 'x', evidence_quote: '118–112' }, 'Final: 118-112 (ESPN)').ok,
    true);
  // model em-dash "118—112" matches evidence hyphen "118-112"
  check('em-dash quote matches hyphen evidence',
    validateEvidenceQuote({ status: 'WIN', evidence: 'x', evidence_quote: '118—112' }, 'Final: 118-112 (ESPN)').ok,
    true);
  // model curly apostrophe matches evidence straight apostrophe
  check('curly single-quote matches straight apostrophe',
    validateEvidenceQuote({ status: 'WIN', evidence: 'x', evidence_quote: 'Shai’s 40 points' }, "Shai's 40 points sealed it").ok,
    true);
  // and the reverse: evidence curly, model straight (normalization is symmetric)
  check('straight apostrophe matches curly evidence',
    validateEvidenceQuote({ status: 'WIN', evidence: 'x', evidence_quote: "Shai's 40 points" }, 'Shai’s 40 points sealed it').ok,
    true);
  // curly double quotes fold to ASCII on both sides
  check('curly double-quotes match straight double-quotes',
    validateEvidenceQuote({ status: 'WIN', evidence: 'x', evidence_quote: '“walk-off”' }, 'a "walk-off" homer').ok,
    true);
  // NOT fuzzy: a genuinely different number still fails after folding
  check('en-dash folding does not make 118–110 match 118-112',
    validateEvidenceQuote({ status: 'WIN', evidence: 'x', evidence_quote: '118–110' }, 'Final: 118-112 (ESPN)').ok,
    false);

  // ── A1: resolveGate3Mode — default + unknown/legacy fail safe to shadow ──
  check('mode "off" resolves off', resolveGate3Mode('off'), 'off');
  check('mode "shadow" resolves shadow', resolveGate3Mode('shadow'), 'shadow');
  check('mode "enforce" resolves enforce', resolveGate3Mode('enforce'), 'enforce');
  check('mode undefined (no env) → shadow', resolveGate3Mode(undefined), 'shadow');
  check('mode "" → shadow', resolveGate3Mode(''), 'shadow');
  check('mode unknown "garbage" → shadow (never silent enforce)', resolveGate3Mode('garbage'), 'shadow');
  check('mode "ENFORCE" (case/space) → enforce', resolveGate3Mode('  ENFORCE '), 'enforce');
  check('legacy boolean "true" → shadow (not enforce)', resolveGate3Mode('true'), 'shadow');

  // ── A1/A2: applyGate3 tri-state behavior ──
  const FAILING = { status: 'WIN', evidence: 'Celtics won', evidence_quote: 'Celtics beat the Knicks by six' }; // paraphrase → fails
  const PASSING = { status: 'WIN', evidence: 'x', evidence_quote: 'Boston Celtics 118' };

  // off: no validation, no log, grade unchanged.
  const off = applyGate3(FAILING, EVIDENCE, { mode: 'off', betId: 'bet-off', legIndex: null });
  check('off: not validated', off.validated, false);
  check('off: no would-fire', off.wouldFire, false);
  check('off: no force-pending', off.forcePending, false);
  check('off: no log line', off.logLine, null);

  // shadow: failing quote → would-fire logged, grade unchanged (no force-pending).
  const shadow = applyGate3(FAILING, EVIDENCE, { mode: 'shadow', betId: 'bet-shadow', legIndex: null });
  check('shadow: validated', shadow.validated, true);
  check('shadow: would-fire true', shadow.wouldFire, true);
  check('shadow: does NOT force pending (grade unchanged)', shadow.forcePending, false);
  check('shadow: emits a log line', typeof shadow.logLine === 'string' && shadow.logLine.length > 0, true);

  // enforce: same failing quote → force PENDING with UNVERIFIED_QUOTE.
  const enforce = applyGate3(FAILING, EVIDENCE, { mode: 'enforce', betId: 'bet-enforce', legIndex: null });
  check('enforce: would-fire true', enforce.wouldFire, true);
  check('enforce: forces pending', enforce.forcePending, true);
  check('enforce: reason UNVERIFIED_QUOTE', enforce.reason, 'UNVERIFIED_QUOTE');

  // default (no mode passed) behaves as shadow.
  const dflt = applyGate3(FAILING, EVIDENCE, { betId: 'bet-default', legIndex: null });
  check('default mode is shadow', dflt.mode, 'shadow');
  check('default: would-fire but does NOT force pending', dflt.wouldFire && !dflt.forcePending, true);

  // passing quote: ok in every active mode, never fires, never logs.
  const passShadow = applyGate3(PASSING, EVIDENCE, { mode: 'shadow', betId: 'b', legIndex: null });
  check('passing quote (shadow): ok', passShadow.ok, true);
  check('passing quote (shadow): no would-fire', passShadow.wouldFire, false);
  check('passing quote (shadow): no log', passShadow.logLine, null);
  const passEnforce = applyGate3(PASSING, EVIDENCE, { mode: 'enforce', betId: 'b', legIndex: null });
  check('passing quote (enforce): does not force pending', passEnforce.forcePending, false);

  // ── A2: would-fire log line format (bounded, greppable, one line) ──
  const line = shadow.logLine;
  check('log line starts with [GATE3 would-fire]', line.startsWith('[GATE3 would-fire] '), true);
  check('log line carries bet id', line.includes('bet=bet-shadow'), true);
  check('log line carries claimed status', line.includes('claimed=WIN'), true);
  check('log line carries reason', line.includes('reason=UNVERIFIED_QUOTE'), true);
  check('log line carries quoted snippet', line.includes('quote="'), true);
  check('log line is a single line (no newline)', line.includes('\n'), false);

  // leg index: null → n/a; a real (incl. zero) index is shown verbatim.
  check('leg=n/a when legIndex null', line.includes('leg=n/a'), true);
  const legLine = applyGate3(FAILING, EVIDENCE, { mode: 'shadow', betId: 'b', legIndex: 2 }).logLine;
  check('leg=2 when legIndex 2', legLine.includes('leg=2'), true);
  const leg0Line = applyGate3(FAILING, EVIDENCE, { mode: 'shadow', betId: 'b', legIndex: 0 }).logLine;
  check('leg=0 when legIndex 0 (not n/a)', leg0Line.includes('leg=0') && !leg0Line.includes('leg=n/a'), true);

  // quote snippet bounded to ~80 chars + whitespace collapsed (no full blob, no wrap).
  const longQuote = 'x'.repeat(200);
  const longLine = applyGate3({ status: 'LOSS', evidence_quote: longQuote }, EVIDENCE, { mode: 'shadow', betId: 'b', legIndex: null }).logLine;
  const snippet = longLine.match(/quote="([^"]*)"/)[1];
  check('quote snippet capped at 80 chars', snippet.length, 80);

  // ── B0: buildGate3WouldFireMarker — the persisted would-fire audit token ──
  // applyGate3 now carries the model's claimed status so the marker can record it.
  check('applyGate3 carries claimed status on would-fire', shadow.claimed, 'WIN');

  const GAME_LINE = { description: 'Lakers ML -110', bet_type: 'straight' };
  const PROP_LINE = { description: 'OVER 14.5 POINTS SCOOT HENDERSON', bet_type: 'straight' };

  // No would-fire → no marker (off mode, or a quote that verified).
  check('off mode → no marker (null)', buildGate3WouldFireMarker(off, GAME_LINE), null);
  check('passing quote → no marker (null)', buildGate3WouldFireMarker(passShadow, GAME_LINE), null);
  check('missing g3 → no marker (null)', buildGate3WouldFireMarker(null, GAME_LINE), null);

  // shadow + failing quote → distinctive, single-line, SELECT-able marker.
  const mShadow = buildGate3WouldFireMarker(shadow, GAME_LINE);
  check('shadow marker is a string', typeof mShadow === 'string' && mShadow.length > 0, true);
  check('shadow marker has GATE3_WOULD_FIRE prefix (queryable)', mShadow.startsWith('GATE3_WOULD_FIRE'), true);
  check('shadow marker carries mode=shadow', mShadow.includes('mode=shadow'), true);
  check('shadow marker carries claimed=WIN', mShadow.includes('claimed=WIN'), true);
  check('shadow marker carries reason=UNVERIFIED_QUOTE', mShadow.includes('reason=UNVERIFIED_QUOTE'), true);
  check('shadow marker is single-line (no newline)', mShadow.includes('\n'), false);

  // enforce + failing quote → same marker, mode=enforce.
  const mEnforce = buildGate3WouldFireMarker(enforce, GAME_LINE);
  check('enforce marker has GATE3_WOULD_FIRE prefix', mEnforce.startsWith('GATE3_WOULD_FIRE'), true);
  check('enforce marker carries mode=enforce', mEnforce.includes('mode=enforce'), true);

  // prop vs game-line split (the metric the audit is for).
  check('game-line bet → prop=0', buildGate3WouldFireMarker(shadow, GAME_LINE).includes('prop=0'), true);
  check('player-prop description → prop=1', buildGate3WouldFireMarker(shadow, PROP_LINE).includes('prop=1'), true);
  check('bet_type=prop → prop=1 (explicit type)', buildGate3WouldFireMarker(shadow, { description: 'x', bet_type: 'prop' }).includes('prop=1'), true);

  // ── P1: futures / tease bet — Gate 3 backstops an uncited grade ──────────────
  // Bet 3f78b923 shape: a bare "NBA Champion" futures bet with no odds. A model
  // that returns WIN with a fabricated evidence_quote (not a substring of the
  // evidence) must be force-PENDING under enforce (the Gate-3 anti-hallucination
  // guarantee), and merely logged under shadow.
  const FUTURES_EVIDENCE = 'The 2026 NBA Finals are scheduled for June. No champion has been crowned yet.';
  const futuresClaim = { status: 'WIN', evidence: 'Thunder won the title', evidence_quote: 'Oklahoma City Thunder are the 2026 NBA Champions' };
  // Sanity: the claimed quote is genuinely NOT in the evidence.
  check('futures fabricated quote is not a substring (validateEvidenceQuote fails)',
    validateEvidenceQuote(futuresClaim, FUTURES_EVIDENCE).ok, false);

  const futuresEnforce = applyGate3(futuresClaim, FUTURES_EVIDENCE, { mode: 'enforce', betId: 'bet-3f78b923', legIndex: null });
  check('futures WIN, non-substring quote, enforce → forces pending', futuresEnforce.forcePending, true);
  check('futures forced-pending reason UNVERIFIED_QUOTE', futuresEnforce.reason, 'UNVERIFIED_QUOTE');
  check('futures enforce would-fire true', futuresEnforce.wouldFire, true);

  const futuresShadow = applyGate3(futuresClaim, FUTURES_EVIDENCE, { mode: 'shadow', betId: 'bet-3f78b923', legIndex: null });
  check('futures shadow would-fire true (logged)', futuresShadow.wouldFire, true);
  check('futures shadow does NOT force pending', futuresShadow.forcePending, false);

  // A correctly-cited quote passes even in enforce (the guard is a substring
  // check, not a blanket futures block).
  const citedClaim = { status: 'WIN', evidence: 'x', evidence_quote: 'No champion has been crowned yet' };
  check('futures with a real substring quote passes enforce',
    applyGate3(citedClaim, FUTURES_EVIDENCE, { mode: 'enforce', betId: 'b', legIndex: null }).forcePending, false);

  console.log(`\n${pass} passed / ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('Quote validator (Gate 3) validation passed.');
} finally {
  try { database.db.close(); } catch (_) {}
  try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch (_) {}
}
