#!/usr/bin/env node
// scripts/tierb-reanchor.js
// ═══════════════════════════════════════════════════════════
// TIER B of the pre-gate audit — READ-ONLY snowflake re-anchor of twitter
// rows + shadow re-run of rows whose anchor moved + delta report data.
//
// The pre-gate shadow regrade (scripts/shadow-regrade-pregate.js, the 2026-07-02
// audit) anchored every row to event_date-or-created_at. For scraped tweets
// created_at is the SCRAPE time, not the post time — and scrapes trail posts by
// 0–5 days (deep backfills more), so the created_at-derived ET slate day can be
// the wrong game day. That is precisely why 47 of the 71 v1 disagreements were
// flagged low-confidence ("LC").
//
// This script recovers the TRUE post time from the tweet's snowflake id
// (X/Twitter epoch), re-derives the ET slate day with the ENGINE'S OWN ET
// conversion, and — for rows whose slate day moved — re-runs the UNCHANGED
// grading engine with the corrected anchor. It computes NO grades itself: every
// verdict comes from a child invocation of scripts/shadow-regrade-pregate.js on
// a patched export (moved rows carry the post instant as event_date, which is
// the only field the engine's anchorFor prefers over created_at). Zero
// grading-logic changes; the engine is reused verbatim.
//
// READ-ONLY: no DB access, no writes to any repo file, no correction script,
// no deploy. Network is limited to the child engine's public score-API calls.
// Output is a results JSON (via --out) + patched export artifacts, consumed by
// a human-authored delta report.
//
// Usage:
//   node scripts/tierb-reanchor.js <export.json> --baseline <baseline.json> \
//        [--out results.json] [--artifact-dir DIR] [--controls N] [--no-grade]
//
//   --baseline   v1 engine results (shadow-regrade-pregate.js --out) for the
//                SAME export — supplies the v1 verdicts to diff against and the
//                determinism control's expected verdicts. Required unless
//                --no-grade.
//   --no-grade   re-anchor only (no child engine run); emits anchor stats and
//                the patched moved-rows export, skips the delta/candidate join.
//   --controls   number of unmoved v1-agree rows to re-grade as the engine
//                determinism gate before the batch (default 5).
//
// Snowflake: post_ms = (id >> 22) + 1288834974657. ids exceed 2^53 so the
// shift is done in BigInt. Sanity window per row: post must be
// <= created_at + 1h (scrape can't precede the post; +1h absorbs clock skew)
// and >= created_at - 21d (deep backfill pulls). Outside → keep v1 anchor,
// flag anchor_reject. Discord rows and twitter rows with no /status/ id are
// not re-anchorable → keep v1 anchor, flag unanchorable.
// ═══════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// The one piece of engine machinery reused directly: the UTC-instant → ET
// calendar-day conversion. Importing etParts (pure, zero requires) guarantees
// byte-identical slate-day derivation; etYMD/parseUtcInstant/anchorFor below
// are copied verbatim from shadow-regrade-pregate.js (lines 112–135).
const { etParts } = require('../services/eventDate');

// ── Snowflake constants ──────────────────────────────────────
const TW_EPOCH_MS = 1288834974657n;   // X/Twitter snowflake epoch (2010-11-04)
const SANITY_FWD_MS = 60 * 60 * 1000;         // post <= created_at + 1h
const SANITY_BACK_MS = 21 * 24 * 60 * 60 * 1000; // post >= created_at - 21d

// ── CLI ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const inputPath = args.find(a => !a.startsWith('--'));
function flagVal(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}
const hasFlag = name => args.includes(name);
const baselinePath = flagVal('--baseline');
const outPath = flagVal('--out');
const artifactDir = flagVal('--artifact-dir') || (outPath ? path.dirname(path.resolve(outPath)) : os.tmpdir());
const enginePath = flagVal('--engine') || path.join(__dirname, 'shadow-regrade-pregate.js');
const noGrade = hasFlag('--no-grade');
const controlN = parseInt(flagVal('--controls') || '5', 10) || 5;

if (!inputPath) {
  console.error('Usage: node scripts/tierb-reanchor.js <export.json> --baseline <baseline.json> [--out results.json] [--artifact-dir DIR] [--controls N] [--no-grade]');
  process.exit(2);
}
if (!noGrade && !baselinePath) {
  console.error('--baseline <baseline.json> is required unless --no-grade');
  process.exit(2);
}

// ── Date helpers — VERBATIM from shadow-regrade-pregate.js ───
function parseUtcInstant(s) {
  if (!s) return null;
  const iso = String(s).includes('T') ? String(s) : String(s).replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}
function pad2(n) { return String(n).padStart(2, '0'); }
function etYMD(d) {
  const p = etParts(d);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}
// v1 anchor: event_date if present, else created_at, resolved to the ET slate
// day — identical to the engine's anchorFor (this is what the baseline used).
function v1AnchorFor(bet) {
  const src = bet.event_date || bet.created_at;
  const from = bet.event_date ? 'event_date' : 'created_at';
  const d = parseUtcInstant(src);
  return d ? { ymd: etYMD(d), from } : null;
}

// ── Snowflake re-anchor ──────────────────────────────────────
function statusId(url) {
  const m = /\/status\/(\d+)/.exec(String(url || ''));
  return m ? m[1] : null;
}
function snowflakeMs(idStr) {
  return Number((BigInt(idStr) >> 22n) + TW_EPOCH_MS);
}

// Re-anchor one row. Returns the v1 anchor, the snowflake anchor (when
// derivable), the moved flag, and a re-anchorability classification.
//   reanchorable=true  → source LIKE 'twitter%' AND /status/ id AND in window
//   flag='anchor_reject'  → snowflake derivable but outside the sanity window
//   flag='unanchorable*'  → discord / non-twitter / twitter w/o status id
function reanchor(bet) {
  const v1 = v1AnchorFor(bet);
  const v1ymd = v1 ? v1.ymd : null;
  const src = String(bet.source || '');
  const isTwitter = /^twitter/i.test(src);
  const sid = statusId(bet.source_url);

  const base = {
    id: bet.id,
    source: bet.source,
    source_url: bet.source_url || null,
    created_at: bet.created_at,
    v1_anchor_date: v1ymd,
    v1_anchor_source: v1 ? v1.from : null,
    snowflake_ms: null,
    snowflake_post_iso: null,
    snowflake_date: null,
    gap_days: null,
    reanchorable: false,
    moved: false,
    flag: null,
  };

  if (!isTwitter || !sid) {
    // Discord rows, vision_slip / hold_review_script, and twitter rows whose
    // stored url is a relay permalink (no /status/ id) can't be re-anchored.
    base.flag = !isTwitter ? `unanchorable_${src || 'unknown'}` : 'unanchorable_no_status';
    return base;
  }

  const ms = snowflakeMs(sid);
  base.snowflake_ms = ms;
  base.snowflake_post_iso = new Date(ms).toISOString();
  const snowDate = etYMD(new Date(ms));
  base.snowflake_date = snowDate;

  const ca = parseUtcInstant(bet.created_at);
  const caMs = ca ? ca.getTime() : null;
  if (caMs != null) base.gap_days = +(((caMs - ms) / 86400000)).toFixed(3);

  if (caMs == null) {
    base.flag = 'anchor_reject_no_created_at';
    return base;
  }
  if (!(ms <= caMs + SANITY_FWD_MS && ms >= caMs - SANITY_BACK_MS)) {
    base.flag = 'anchor_reject';
    return base;
  }

  base.reanchorable = true;
  base.moved = v1ymd != null && snowDate !== v1ymd;
  return base;
}

// ── Child engine invocation (verbatim reuse) ────────────────
// Writes `rows` to a temp export, runs the UNCHANGED engine against it, and
// returns its results array keyed by id. The child inherits process.env
// (NODE_PATH) and does its own throttled score-API fetching.
let spawnSeq = 0;
function runEngine(rows, label) {
  fs.mkdirSync(artifactDir, { recursive: true });
  const inFile = path.join(artifactDir, `tierb-${label}-in.json`);
  const outFile = path.join(artifactDir, `tierb-${label}-out.json`);
  fs.writeFileSync(inFile, JSON.stringify(rows, null, 1));
  spawnSeq++;
  console.error(`[tierb] engine run "${label}" on ${rows.length} rows → ${outFile}`);
  execFileSync('node', [enginePath, inFile, '--out', outFile], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: process.env,
  });
  const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const byId = {};
  for (const r of payload.results) byId[r.id] = r;
  return { byId, summary: payload.summary, inFile, outFile };
}

// ── Main ─────────────────────────────────────────────────────
(async () => {
  const startedAt = Date.now();
  const all = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  if (!Array.isArray(all)) { console.error('Input is not a JSON array'); process.exit(2); }

  // Re-anchor every row.
  const anchors = all.map(reanchor);
  const anchorById = {};
  for (const a of anchors) anchorById[a.id] = a;

  const moved = anchors.filter(a => a.moved);
  const unmovedReanchorable = anchors.filter(a => a.reanchorable && !a.moved);
  const anchorReject = anchors.filter(a => String(a.flag || '').startsWith('anchor_reject'));
  const unanchorable = anchors.filter(a => String(a.flag || '').startsWith('unanchorable'));

  // Day-shift size distribution for moved rows (signed calendar-day delta,
  // snowflake_date − v1_anchor_date).
  function dayDelta(fromYmd, toYmd) {
    const a = new Date(`${fromYmd}T12:00:00Z`).getTime();
    const b = new Date(`${toYmd}T12:00:00Z`).getTime();
    return Math.round((b - a) / 86400000);
  }
  const shiftDist = {};
  for (const m of moved) {
    const d = dayDelta(m.v1_anchor_date, m.snowflake_date);
    shiftDist[d] = (shiftDist[d] || 0) + 1;
  }

  const anchorStats = {
    input_rows: all.length,
    moved: moved.length,
    unmoved_reanchorable: unmovedReanchorable.length,
    unanchorable: unanchorable.length,
    anchor_reject: anchorReject.length,
    day_shift_distribution: shiftDist,
  };
  console.error(`[tierb] anchors: moved=${moved.length} unmoved(reanchorable)=${unmovedReanchorable.length} ` +
    `unanchorable=${unanchorable.length} anchor_reject=${anchorReject.length}`);

  // Always emit the patched moved-rows export as an inspectable artifact.
  const patchedMoved = moved.map(m => {
    const bet = all.find(b => b.id === m.id);
    return { ...bet, event_date: m.snowflake_post_iso, _tierb_v1_anchor: m.v1_anchor_date, _tierb_snowflake_date: m.snowflake_date };
  });
  fs.mkdirSync(artifactDir, { recursive: true });
  const patchedFile = path.join(artifactDir, 'tierb-moved-patched.json');
  fs.writeFileSync(patchedFile, JSON.stringify(patchedMoved, null, 1));

  let payload = {
    anchor_stats: anchorStats,
    anchors,
    generated_from: path.resolve(inputPath),
  };

  if (noGrade) {
    if (outPath) fs.writeFileSync(path.resolve(outPath), JSON.stringify(payload, null, 1));
    console.log(JSON.stringify(anchorStats, null, 2));
    console.error('[tierb] --no-grade: skipped engine runs');
    return;
  }

  // ── Load baseline & internal-consistency check ──────────────
  const baseline = JSON.parse(fs.readFileSync(path.resolve(baselinePath), 'utf8'));
  const baseById = {};
  for (const r of baseline.results) baseById[r.id] = r;

  // My replicated v1 anchor must equal the engine's baseline anchor_ymd for
  // every row — proves the re-anchor shares the engine's ET convention.
  const anchorMismatches = anchors.filter(a => {
    const b = baseById[a.id];
    return b && b.anchor_ymd && a.v1_anchor_date && b.anchor_ymd !== a.v1_anchor_date;
  });
  if (anchorMismatches.length) {
    console.error(`[tierb] FATAL: ${anchorMismatches.length} rows where replicated v1 anchor != baseline anchor_ymd`);
    for (const a of anchorMismatches.slice(0, 10)) {
      console.error(`  ${a.id} mine=${a.v1_anchor_date} baseline=${baseById[a.id].anchor_ymd}`);
    }
    process.exit(1);
  }
  console.error(`[tierb] v1 anchor parity vs baseline: ${anchors.length}/${anchors.length} OK`);

  // ── Determinism control (BEFORE the batch) ──────────────────
  // Re-grade N unmoved v1-agree rows UNPATCHED (identical input to baseline)
  // and require identical verdicts. A mismatch means the engine is not
  // reproducing (e.g. a score API changed between runs) → abort, do not trust
  // any moved-row delta.
  const controlPool = unmovedReanchorable
    .concat(anchors.filter(a => !a.reanchorable && !String(a.flag || '').startsWith('anchor_reject')))
    .filter(a => baseById[a.id] && baseById[a.id].agree === true)
    .sort((x, y) => String(x.id).localeCompare(String(y.id)));
  // Spread across sports where possible for a broader determinism probe.
  const bySport = {};
  const controls = [];
  for (const a of controlPool) {
    const sp = baseById[a.id].sport_used || 'x';
    if ((bySport[sp] || 0) < Math.ceil(controlN / 3) || controls.length < controlN) {
      controls.push(a);
      bySport[sp] = (bySport[sp] || 0) + 1;
    }
    if (controls.length >= controlN) break;
  }
  const controlRows = controls.map(c => all.find(b => b.id === c.id));
  const ctl = runEngine(controlRows, 'control');
  const controlResults = controls.map(c => {
    const b = baseById[c.id];
    const r = ctl.byId[c.id];
    return {
      id: c.id,
      sport: b.sport_used,
      baseline_verdict: b.shadow_verdict,
      rerun_verdict: r ? r.shadow_verdict : null,
      identical: !!(r && r.shadow_verdict === b.shadow_verdict),
    };
  });
  const controlFails = controlResults.filter(c => !c.identical);
  console.error(`[tierb] determinism control: ${controlResults.length - controlFails.length}/${controlResults.length} identical`);
  for (const c of controlResults) {
    console.error(`  control ${c.id} ${c.sport} base=${c.baseline_verdict} rerun=${c.rerun_verdict} ${c.identical ? 'OK' : 'MISMATCH'}`);
  }
  if (controlFails.length) {
    console.error('[tierb] FATAL: determinism control failed — engine not reproducing; refusing to emit deltas');
    payload.control = controlResults;
    if (outPath) fs.writeFileSync(path.resolve(outPath), JSON.stringify(payload, null, 1));
    process.exit(1);
  }

  // ── Batch: shadow re-run of moved rows (patched anchor) ─────
  const batch = moved.length ? runEngine(patchedMoved, 'moved') : { byId: {}, summary: {} };

  // ── Suggested corrected P/L (mirrors engine.suggestedPu) ────
  function suggestedPu(bet, verdict) {
    const units = Number(bet.units) || 0;
    if (verdict === 'PUSH' || verdict === 'VOID') return { pu: 0, defaultOdds: false };
    if (verdict === 'LOSS') return { pu: -units, defaultOdds: false };
    const o = Number(bet.odds);
    if (bet.odds == null || bet.odds === '' || !Number.isFinite(o) || o === 0) {
      return { pu: +(0.909 * units).toFixed(4), defaultOdds: true };
    }
    const pu = o > 0 ? units * (o / 100) : units * (100 / Math.abs(o));
    return { pu: +pu.toFixed(4), defaultOdds: false };
  }

  // ── Delta join over moved rows ──────────────────────────────
  function priorClass(b) {
    if (b.agree === true) return 'v1_agree';
    if (b.agree === false) return 'v1_lc_disagree';
    return 'v1_unresolved';
  }
  const deltas = [];
  const candidates = [];
  for (const m of moved) {
    const bet = all.find(b => b.id === m.id);
    const b = baseById[m.id];
    const r = batch.byId[m.id];
    const prior = priorClass(b);
    const newAgree = r ? r.agree : null;
    const newVerdict = r ? r.shadow_verdict : null;
    let newClass;
    if (newAgree === true) newClass = 'agree';
    else if (newAgree === false) newClass = 'disagree';
    else newClass = 'unresolved';
    const d = {
      id: m.id,
      description: bet.description,
      sport_used: r ? r.sport_used : b.sport_used,
      market: r ? r.market : b.market,
      v1_anchor_date: m.v1_anchor_date,
      snowflake_date: m.snowflake_date,
      day_shift: dayDelta(m.v1_anchor_date, m.snowflake_date),
      stored_result: b.stored_result,
      stored_pu: bet.profit_units,
      v1_verdict: b.shadow_verdict,
      v1_class: prior,
      rerun_verdict: newVerdict,
      rerun_reason: r ? r.reason : null,
      rerun_date_used: r ? r.date_used : null,
      rerun_date_shifted: r ? !!r.date_shifted : null,
      new_class: newClass,
      transition: `${prior} → ${newClass}`,
      evidence: r ? r.evidence : null,
      evidence_url: r ? r.evidence_url : null,
    };
    deltas.push(d);

    // A NEW high-confidence correction candidate: moved row now on the exact
    // snowflake anchor whose re-run terminally disagrees with the stored result.
    if (newAgree === false && newVerdict) {
      const s = suggestedPu(bet, newVerdict);
      candidates.push({
        id: m.id,
        expect_stored_result: b.stored_result,
        new_result: newVerdict.toLowerCase(),
        stored_pu: bet.profit_units,
        new_pu: s.pu,
        default_odds: s.defaultOdds,
        pu_delta: +((s.pu - (Number(bet.profit_units) || 0))).toFixed(4),
        odds: bet.odds,
        units: bet.units,
        sport_used: d.sport_used,
        market: d.market,
        description: bet.description,
        v1_anchor_date: m.v1_anchor_date,
        snowflake_date: m.snowflake_date,
        rerun_date_used: d.rerun_date_used,
        rerun_date_shifted: d.rerun_date_shifted,
        v1_class: prior,
        evidence: d.evidence,
        evidence_url: d.evidence_url,
      });
    }
  }
  candidates.sort((a, b) => Math.abs(b.pu_delta) - Math.abs(a.pu_delta));

  // Delta matrix by prior class.
  function matrixFor(cls) {
    const rows = deltas.filter(d => d.v1_class === cls);
    const m = { moved: rows.length, to_agree: 0, to_disagree: 0, to_unresolved: 0 };
    for (const r of rows) {
      if (r.new_class === 'agree') m.to_agree++;
      else if (r.new_class === 'disagree') m.to_disagree++;
      else m.to_unresolved++;
    }
    return m;
  }
  const priorCounts = {
    v1_agree: baseline.results.filter(r => r.agree === true).length,
    v1_lc_disagree: baseline.results.filter(r => r.agree === false).length,
    v1_unresolved: baseline.results.filter(r => r.agree === null).length,
  };
  const matrix = {
    v1_agree: { total: priorCounts.v1_agree, unmoved: priorCounts.v1_agree - matrixFor('v1_agree').moved, ...matrixFor('v1_agree') },
    v1_lc_disagree: { total: priorCounts.v1_lc_disagree, unmoved: priorCounts.v1_lc_disagree - matrixFor('v1_lc_disagree').moved, ...matrixFor('v1_lc_disagree') },
    v1_unresolved: { total: priorCounts.v1_unresolved, unmoved: priorCounts.v1_unresolved - matrixFor('v1_unresolved').moved, ...matrixFor('v1_unresolved') },
  };

  const netDelta = +candidates.reduce((s, c) => s + c.pu_delta, 0).toFixed(4);

  payload = {
    ...payload,
    control: controlResults,
    matrix,
    prior_counts: priorCounts,
    deltas,
    candidates,
    net_delta_if_applied: netDelta,
    batch_summary: batch.summary,
    control_summary: ctl.summary,
    runtime_seconds: Math.round((Date.now() - startedAt) / 1000),
  };

  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), JSON.stringify(payload, null, 1));
    console.error(`[tierb] wrote ${outPath}`);
  }

  // Console digest.
  const digest = {
    anchor_stats: anchorStats,
    matrix,
    candidate_count: candidates.length,
    net_delta_if_applied: netDelta,
    determinism_control: `${controlResults.length}/${controlResults.length} identical`,
  };
  console.log(JSON.stringify(digest, null, 2));
  for (const c of candidates) {
    console.log(`CANDIDATE ${c.id} ${c.sport_used}/${c.market} ${c.expect_stored_result}→${c.new_result} ` +
      `puΔ=${c.pu_delta} [${c.v1_class}] shift=${c.v1_anchor_date}→${c.snowflake_date}` +
      `${c.rerun_date_shifted ? ' (rerun±1)' : ''} | ${String(c.description).slice(0, 50)}`);
  }
})().catch(err => { console.error('[tierb] fatal:', err); process.exit(1); });
