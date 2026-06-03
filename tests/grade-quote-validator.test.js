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
const { validateEvidenceQuote } = grading._internal;

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

  console.log(`\n${pass} passed / ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('Quote validator (Gate 3) validation passed.');
} finally {
  try { database.db.close(); } catch (_) {}
  try { if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile); } catch (_) {}
}
