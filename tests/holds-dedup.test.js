// ═══════════════════════════════════════════════════════════
// routes/admin.js selectHoldQueue — /holds messageUrl collapse tests.
//
// A buffered multi-message post (image-album split, or TweetShift posting text
// + media as separate messages) produces N MANUAL_REVIEW_HOLD pipeline_events
// rows with DISTINCT ingest_ids but ONE shared primary messageUrl (stageAll
// records the hold per constituent for trace). The live pipeline calls
// sendHoldReviewEmbed only ONCE per aggregated post, so GET /holds now collapses
// those rows by messageUrl — keeping the `disc_<urlMessageId>` primary (else the
// oldest) — which is lossless and matches live behavior. selectHoldQueue is the
// pure, exported core of that selection; these tests pin its contract with no
// HTTP harness and no DB (it operates on plain row objects).
//
// Run:  node --test tests/holds-dedup.test.js   (also discovered by `node --test`)
// ═══════════════════════════════════════════════════════════

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { selectHoldQueue } = require('../routes/admin');

// ── helpers ──────────────────────────────────────────────────
// Build a raw pipeline_events row exactly as routes/admin.js GET /holds SELECTs
// it (id, ingest_id, payload JSON text, created_at epoch seconds).
let _auto = 0;
function row({ id, ingestId = null, messageUrl, createdAt, payload }) {
  const pay = payload !== undefined
    ? payload
    : JSON.stringify(messageUrl === undefined ? {} : { messageUrl });
  return { id: id ?? ++_auto, ingest_id: ingestId, payload: pay, created_at: createdAt };
}

// The handler hands selectHoldQueue rows already ordered created_at DESC, id
// DESC. Mimic that so tests can declare rows in any order.
function queryOrder(rows) {
  return rows.slice().sort((a, b) => (b.created_at - a.created_at) || (b.id - a.id));
}

const NONE = () => false;                       // nothing resolved
const resolved = (...ids) => {                  // these ingest_ids are resolved
  const set = new Set(ids);
  return (ingestId) => set.has(ingestId);
};
const url = (mid) => `https://discord.com/channels/100/200/${mid}`;

// ── 1. same ingest_id twice → ONE row (existing behavior preserved) ──
test('same ingest_id twice collapses to one row, newest kept', () => {
  const rows = queryOrder([
    row({ id: 1, ingestId: 'disc_500', messageUrl: url(500), createdAt: 10 }),
    row({ id: 2, ingestId: 'disc_500', messageUrl: url(500), createdAt: 20 }),
  ]);
  const out = selectHoldQueue(rows, NONE);
  assert.equal(out.length, 1);
  assert.equal(out[0].ingest_id, 'disc_500');
  assert.equal(out[0].created_at, 20);   // newest row kept
  assert.equal(out[0].id, 2);
});

// ── 2. two distinct ingest_ids, one shared messageUrl → ONE row,
//       rep is the disc_<urlMessageId> match ──
test('two ingest_ids sharing a messageUrl collapse to the disc_<mid> primary', () => {
  const rows = queryOrder([
    row({ id: 1, ingestId: 'disc_555', messageUrl: url(555), createdAt: 10 }),  // primary (suffix match), OLDER
    row({ id: 2, ingestId: 'disc_999', messageUrl: url(555), createdAt: 20 }),  // constituent, NEWER
  ]);
  const out = selectHoldQueue(rows, NONE);
  assert.equal(out.length, 1);
  // permalink-suffix match wins even though it is the older row
  assert.equal(out[0].ingest_id, 'disc_555');
});

// ── 3. rep falls back to OLDEST when no ingest_id matches the suffix ──
test('rep falls back to the oldest row when no ingest_id matches the permalink suffix', () => {
  const rows = queryOrder([
    row({ id: 1, ingestId: 'disc_111', messageUrl: url(777), createdAt: 10 }),  // oldest
    row({ id: 2, ingestId: 'disc_222', messageUrl: url(777), createdAt: 20 }),
    row({ id: 3, ingestId: 'disc_333', messageUrl: url(777), createdAt: 30 }),
  ]);
  const out = selectHoldQueue(rows, NONE);   // none is disc_777
  assert.equal(out.length, 1);
  assert.equal(out[0].ingest_id, 'disc_111');
  assert.equal(out[0].created_at, 10);
});

// ── 3b. oldest-rep tiebreak prefers the smaller id on a created_at tie ──
test('oldest-rep tiebreak prefers the smaller id when created_at ties', () => {
  const rows = queryOrder([
    row({ id: 7, ingestId: 'disc_aaa', messageUrl: url(888), createdAt: 30 }),
    row({ id: 3, ingestId: 'disc_bbb', messageUrl: url(888), createdAt: 30 }),  // same created_at, smaller id
  ]);
  const out = selectHoldQueue(rows, NONE);   // none is disc_888
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 3);
});

// ── 4. null/empty messageUrl rows stay distinct (not merged) ──
test('rows with null / empty / missing messageUrl are never merged', () => {
  const rows = queryOrder([
    row({ id: 1, ingestId: 'disc_a', payload: JSON.stringify({ messageUrl: null }), createdAt: 10 }),
    row({ id: 2, ingestId: 'disc_b', payload: JSON.stringify({ messageUrl: '' }),   createdAt: 20 }),
    row({ id: 3, ingestId: 'disc_c', payload: JSON.stringify({}),                    createdAt: 30 }),  // no key
    row({ id: 4, ingestId: 'disc_d', payload: JSON.stringify({ messageUrl: '   ' }), createdAt: 40 }),  // whitespace only
  ]);
  const out = selectHoldQueue(rows, NONE);
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((r) => r.ingest_id).sort(), ['disc_a', 'disc_b', 'disc_c', 'disc_d']);
});

// ── 4b. unparseable payloads are not merged and never throw ──
test('rows with unparseable payload are not merged and do not throw', () => {
  const rows = queryOrder([
    row({ id: 1, ingestId: 'disc_x', payload: '{not json', createdAt: 10 }),
    row({ id: 2, ingestId: 'disc_y', payload: 'also bad',  createdAt: 20 }),
  ]);
  const out = selectHoldQueue(rows, NONE);
  assert.equal(out.length, 2);
});

// ── 4c. rows sharing a NON-permalink messageUrl are NOT merged ──
//   Only a Discord message permalink (trailing numeric message id) identifies a
//   specific post; a placeholder like https://discord.com/x cannot, so distinct
//   holds that merely share such a string stay distinct. This guards against
//   merging unrelated holds — cf. tests/admin-holds-imageurl.test.js, which
//   seeds many distinct holds under one placeholder messageUrl.
test('rows sharing a non-permalink messageUrl are not merged', () => {
  const rows = queryOrder([
    row({ id: 1, ingestId: 'disc_a', messageUrl: 'https://discord.com/x', createdAt: 10 }),
    row({ id: 2, ingestId: 'disc_b', messageUrl: 'https://discord.com/x', createdAt: 20 }),
    row({ id: 3, ingestId: 'disc_c', messageUrl: 'https://discord.com/g', createdAt: 30 }),
  ]);
  const out = selectHoldQueue(rows, NONE);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((r) => r.ingest_id).sort(), ['disc_a', 'disc_b', 'disc_c']);
});

// ── 5. a group whose REP ingest_id is resolved → dropped entirely ──
//   Only the primary (= disc_<mid> = the embed's ingestId) ever receives a
//   MANUAL_REVIEW_RELEASED/DISMISSED event, so a per-row resolve check BEFORE
//   collapse would leave the non-primary constituent as a ghost. The collapse
//   must drop the whole post.
test('a messageUrl group whose representative is resolved is dropped entirely', () => {
  const rows = queryOrder([
    row({ id: 1, ingestId: 'disc_333', messageUrl: url(333), createdAt: 10 }),  // primary / rep
    row({ id: 2, ingestId: 'disc_444', messageUrl: url(333), createdAt: 20 }),  // constituent, NOT resolved
  ]);
  const out = selectHoldQueue(rows, resolved('disc_333'));
  assert.equal(out.length, 0);   // whole post gone — no ghost constituent row
});

// ── 5b. resolved single hold dropped; unresolved single hold kept ──
test('a resolved single hold is dropped (existing behavior preserved)', () => {
  const rows = queryOrder([
    row({ id: 1, ingestId: 'disc_solo', messageUrl: url(1), createdAt: 10 }),
  ]);
  assert.equal(selectHoldQueue(rows, resolved('disc_solo')).length, 0);
  assert.equal(selectHoldQueue(rows, NONE).length, 1);
});

// ── 6. the 100-cap is applied AFTER the collapse ──
//   120 buffered posts × 2 rows each = 240 rows. Collapsed → 120 posts, capped
//   at 100. (A pre-collapse cap would slice 240 rows to 100 → only ~50 posts.)
test('the 100-cap is applied AFTER the messageUrl collapse', () => {
  const raw = [];
  for (let i = 0; i < 120; i++) {
    const mid = 1000 + i;
    raw.push(row({ id: i * 2 + 1, ingestId: `disc_${mid}`,  messageUrl: url(mid), createdAt: 1000 + i }));  // primary
    raw.push(row({ id: i * 2 + 2, ingestId: `disc_x${mid}`, messageUrl: url(mid), createdAt: 1000 + i }));  // constituent
  }
  const out = selectHoldQueue(queryOrder(raw), NONE);
  assert.equal(out.length, 100);                              // 240 rows → 120 posts → capped at 100
  for (const r of out) assert.match(r.ingest_id, /^disc_\d+$/); // every rep is the permalink-suffix primary
});

// ── 7. distinct posts are returned newest-first ──
test('distinct posts are returned newest-first', () => {
  const rows = queryOrder([
    row({ id: 1, ingestId: 'disc_1', messageUrl: url(1), createdAt: 10 }),
    row({ id: 2, ingestId: 'disc_2', messageUrl: url(2), createdAt: 30 }),
    row({ id: 3, ingestId: 'disc_3', messageUrl: url(3), createdAt: 20 }),
  ]);
  const out = selectHoldQueue(rows, NONE);
  assert.deepEqual(out.map((r) => r.created_at), [30, 20, 10]);
});
