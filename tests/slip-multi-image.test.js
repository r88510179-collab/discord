// ═══════════════════════════════════════════════════════════
// F-07 — slip-feed multi-image selection (pure helpers).
//
// handleSlipFeed historically called processSlipImage(images[0]) only, silently
// dropping images[1..n] when a capper posts multiple real slip screenshots in
// one message (lost bets). selectSlipImages picks which images to process and
// slipImageIngestId derives the per-image ingestId. Both are pure — no DB/vision.
//
// CRITICAL invariant under test: embed/preview thumbnails (origin:'embed' —
// FixTwitter/HRB share cards/link previews) are NEVER multiply-processed. Only
// origin:'attachment' images are real slips. The N=1 and embed-only paths stay
// single-call with the base ingestId (byte-for-byte unchanged).
//
// Requiring messageHandler.js transitively loads database.js, so point DB_PATH
// at a throwaway file (mirrors tests/parlay-reducer.test.js).
// ═══════════════════════════════════════════════════════════
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbFile = path.join(os.tmpdir(), `bettracker-slip-multi-image-${process.pid}.db`);
process.env.DB_PATH = dbFile;

const { selectSlipImages, slipImageIngestId } = require('../handlers/messageHandler');

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}\n    expected ${e}\n    actual   ${a}`); fail++; }
}

// Image fixtures mirror getImageAttachments' output shape { url, type, origin }.
const att = (n) => ({ url: `https://cdn.discordapp.com/att${n}.png`, type: 'image/png', origin: 'attachment' });
const emb = (n) => ({ url: `https://embed.example/preview${n}.png`, type: 'image/png', origin: 'embed' });
const urls = (arr) => arr.map((i) => i.url);

try {
  console.log('slip-multi-image (F-07):');

  // ── selectSlipImages — the five required spec cases ──
  check('one attachment → that one (length 1)',
    urls(selectSlipImages([att(1)])),
    [att(1).url]);

  check('three attachments → all three, in order',
    urls(selectSlipImages([att(1), att(2), att(3)])),
    [att(1).url, att(2).url, att(3).url]);

  check('six attachments → first 4 (cap)',
    urls(selectSlipImages([att(1), att(2), att(3), att(4), att(5), att(6)])),
    [att(1).url, att(2).url, att(3).url, att(4).url]);

  check('zero attachments + one embed → [images[0]] (embed fallback unchanged)',
    urls(selectSlipImages([emb(1)])),
    [emb(1).url]);

  check('mixed 2 attachments + 1 embed → only the 2 attachments',
    urls(selectSlipImages([att(1), att(2), emb(1)])),
    [att(1).url, att(2).url]);

  // ── Invariant: a real attachment always beats an embed, regardless of order.
  // Guards the rare forward-with-link-preview shape (embed listed before the
  // snapshot attachment) — process the real slip, never the preview thumbnail. ──
  check('embed BEFORE attachment → only the attachment (never feed a preview to vision)',
    urls(selectSlipImages([emb(1), att(1)])),
    [att(1).url]);

  // ── Defensive edges (handleSlipFeed already guards images.length>0, but keep pure) ──
  check('empty input → []', selectSlipImages([]), []);
  check('non-array input → [] (defensive)', selectSlipImages(undefined), []);
  check('explicit cap override respected',
    urls(selectSlipImages([att(1), att(2), att(3)], { cap: 2 })),
    [att(1).url, att(2).url]);

  // ── slipImageIngestId — first = base (single-image byte-for-byte), rest = base-img{i} ──
  const base = 'disc_123456789';
  check('ingestId index 0 → base (single-image path unchanged)', slipImageIngestId(base, 0), base);
  check('ingestId index 1 → base-img1', slipImageIngestId(base, 1), `${base}-img1`);
  check('ingestId index 2 → base-img2', slipImageIngestId(base, 2), `${base}-img2`);

  // ── End-to-end id mapping over a 3-attachment selection: first base, rest suffixed, all unique ──
  const sel = selectSlipImages([att(1), att(2), att(3)]);
  const ids = sel.map((_, i) => slipImageIngestId(base, i));
  check('3-image id mapping → [base, base-img1, base-img2]', ids, [base, `${base}-img1`, `${base}-img2`]);
  assert.strictEqual(new Set(ids).size, ids.length, 'per-image ingestIds must be unique');

  console.log(`\n${pass} passed / ${fail} failed`);
} catch (err) {
  console.error(err);
  fail++;
} finally {
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) { /* best-effort */ }
  }
}

if (fail > 0) process.exit(1);
console.log('slip-multi-image (F-07) validation passed.');
process.exit(0);
