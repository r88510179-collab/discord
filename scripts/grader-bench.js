// scripts/grader-bench.js (v2)
// Disposable benchmark — compares 4 grader candidates against human-verified ground truth.
// Runs INSIDE Fly container (uses real searchWeb + real env vars).
// Usage: node /app/grader-bench.js

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { _internal } = require('./services/grading');
const { searchWeb } = _internal;

const GROUND_TRUTH_PATH = '/tmp/ground_truth.json';
const DB_PATH = '/data/bettracker.db';
const OUT_PATH = '/tmp/grader-bench-results.json';
const MAX_TOKENS = 1000;
const SAMPLE_SIZE = 25;
const THROTTLE_MS = 2500; // stay under 30 RPM on Cerebras

const CANDIDATES = [
  { name: 'cerebras-qwen-235b',  url: 'https://api.cerebras.ai/v1/chat/completions',     key: process.env.CEREBRAS_API_KEY, model: 'qwen-3-235b-a22b-instruct-2507' },
  { name: 'cerebras-gpt-oss',    url: 'https://api.cerebras.ai/v1/chat/completions',     key: process.env.CEREBRAS_API_KEY, model: 'gpt-oss-120b' },
  { name: 'cerebras-glm-4.7',    url: 'https://api.cerebras.ai/v1/chat/completions',     key: process.env.CEREBRAS_API_KEY, model: 'zai-glm-4.7' },
  { name: 'groq-llama4-scout',   url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY,     model: 'meta-llama/llama-4-scout-17b-16e-instruct' },
];

function mapTruth(result) {
  if (result === 'win') return 'WIN';
  if (result === 'loss') return 'LOSS';
  if (result === 'push') return 'PUSH';
  return 'UNKNOWN';
}

function scoreCall(candidateStatus, truthMapped) {
  if (truthMapped === 'UNKNOWN') {
    if (candidateStatus === 'PENDING' || candidateStatus === 'VOID') return 'correct_abstain';
    return 'hallucination';
  }
  if (candidateStatus === truthMapped) return 'match';
  if (candidateStatus === 'PENDING') return 'pending_when_known';
  if (candidateStatus === 'VOID') return 'void_when_known';
  return 'mismatch';
}

function parseBetDate(dbRow, today) {
  // created_at format: "2026-04-07 16:24:37" (reliable)
  // event_date format: "07 Apr 2026 22:00" or "" (unreliable)
  if (dbRow.created_at && /^\d{4}-\d{2}-\d{2}/.test(dbRow.created_at)) {
    return dbRow.created_at.slice(0, 10);
  }
  if (dbRow.event_date) {
    const d = new Date(dbRow.event_date);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return today;
}

async function callModel(provider, prompt) {
  const start = Date.now();
  try {
    const res = await fetch(provider.url, {
      method: 'POST',
      signal: AbortSignal.timeout(25000),
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.key}` },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: MAX_TOKENS,
      }),
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 300);
      return { status: 'ERROR', evidence: `HTTP ${res.status}: ${errText}`, latencyMs, raw: null, httpStatus: res.status };
    }
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || null;
    const usage = data.usage || {};
    if (!raw) return { status: 'ERROR', evidence: 'Empty response', latencyMs, raw: null, usage };
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      return { status: 'ERROR', evidence: `JSON parse error: ${e.message}`, latencyMs, raw, usage };
    }
    return {
      status: (parsed.status || '').toUpperCase(),
      evidence: parsed.evidence || '',
      latencyMs,
      raw,
      usage,
    };
  } catch (err) {
    return { status: 'ERROR', evidence: err.message, latencyMs: Date.now() - start, raw: null };
  }
}

function buildPrompt(bet, searchSnippets, today, betDate) {
  return `You MUST respond with valid JSON only. No prose, no markdown, no code fences.
Grade this bet ONLY using the search results below. Today: ${today}. Bet placed: ${betDate}.
Bet: "${bet.description}" | Sport: ${bet.sport || '?'}

Search results:
${searchSnippets.slice(0, 1500)}

Required JSON format:
{"status": "WIN", "evidence": "Final score Lakers 118 Nuggets 112 per ESPN"}

status must be exactly one of: "WIN", "LOSS", "PUSH", "VOID", "PENDING"
evidence must reference specific scores or stats from the search results above.

CRITICAL RULES:
- Cite specific numbers from search results. If no final score found for this game on ${betDate}, return PENDING.
- DO NOT invent scores. If unsure, return PENDING.`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('[bench v2] Loading ground truth from', GROUND_TRUTH_PATH);
  const truth = JSON.parse(fs.readFileSync(GROUND_TRUTH_PATH, 'utf8')).slice(0, SAMPLE_SIZE);
  console.log(`[bench v2] Loaded ${truth.length} ground-truth bets`);

  console.log('[bench v2] Opening SQLite at', DB_PATH);
  const db = new Database(DB_PATH, { readonly: true });

  const today = new Date().toISOString().slice(0, 10);
  const results = [];

  for (let i = 0; i < truth.length; i++) {
    const gt = truth[i];
    const dbRow = db.prepare('SELECT id, description, sport, bet_type, event_date, created_at FROM bets WHERE id = ?').get(gt.bet_id);

    if (!dbRow) {
      console.warn(`[bench] [${i+1}/${truth.length}] SKIP ${gt.bet_id.slice(0,8)} — not in DB`);
      results.push({ bet_id: gt.bet_id, truth: mapTruth(gt.result), skipped: 'not_in_db' });
      continue;
    }

    const truthMapped = mapTruth(gt.result);
    const betDate = parseBetDate(dbRow, today);

    console.log(`[bench] [${i+1}/${truth.length}] ${gt.bet_id.slice(0,8)} | ${dbRow.sport} | truth=${truthMapped} | betDate=${betDate} | "${dbRow.description.slice(0,50).replace(/\n/g,' ')}"`);

    let searchResults = [];
    let searchSnippets = '';
    try {
      const query = `${dbRow.description.split('\n')[0]} ${dbRow.sport || ''} ${betDate}`.slice(0, 120);
      searchResults = await searchWeb(query);
      const snippets = [];
      for (const r of searchResults) {
        if (r.title) snippets.push(r.title);
        if (r.snippet) snippets.push(`  ${r.snippet}`);
      }
      searchSnippets = snippets.join('\n');
      console.log(`         search: ${searchResults.length} hits, ${searchSnippets.length} chars`);
    } catch (err) {
      console.warn(`         search ERROR: ${err.message}`);
    }

    const betRow = { id: dbRow.id, description: dbRow.description, sport: dbRow.sport };
    const prompt = buildPrompt(betRow, searchSnippets, today, betDate);

    const callResults = {};
    for (const cand of CANDIDATES) {
      if (!cand.key) {
        callResults[cand.name] = { status: 'SKIP', evidence: 'No API key', score: 'skipped' };
        continue;
      }
      const r = await callModel(cand, prompt);
      r.score = r.status === 'ERROR' ? 'error' : scoreCall(r.status, truthMapped);
      callResults[cand.name] = r;
      const httpInfo = r.httpStatus ? `http=${r.httpStatus}` : '';
      console.log(`         ${cand.name.padEnd(22)} status=${r.status.padEnd(8)} score=${r.score.padEnd(20)} ${r.latencyMs}ms ${httpInfo}  cached=${r.usage?.prompt_tokens_details?.cached_tokens ?? '-'}`);
      await sleep(THROTTLE_MS);
    }

    results.push({
      bet_id: gt.bet_id,
      description: dbRow.description,
      sport: dbRow.sport,
      bet_date: betDate,
      truth: truthMapped,
      truth_reason: gt.grade_reason,
      search_hits: searchResults.length,
      candidates: callResults,
    });
  }

  const summary = {};
  for (const cand of CANDIDATES) {
    summary[cand.name] = { match:0, mismatch:0, pending_when_known:0, void_when_known:0, hallucination:0, correct_abstain:0, error:0, skipped:0, total_latency_ms:0, total_cached_tokens:0, total_prompt_tokens:0, errors_by_http:{} };
  }
  for (const r of results) {
    if (!r.candidates) continue;
    for (const [name, call] of Object.entries(r.candidates)) {
      const s = summary[name];
      if (!s) continue;
      s[call.score] = (s[call.score] || 0) + 1;
      s.total_latency_ms += call.latencyMs || 0;
      s.total_cached_tokens += call.usage?.prompt_tokens_details?.cached_tokens || 0;
      s.total_prompt_tokens += call.usage?.prompt_tokens || 0;
      if (call.httpStatus) {
        s.errors_by_http[call.httpStatus] = (s.errors_by_http[call.httpStatus] || 0) + 1;
      }
    }
  }

  const out = { ran_at: new Date().toISOString(), sample_size: results.length, max_tokens: MAX_TOKENS, throttle_ms: THROTTLE_MS, summary, results };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));

  console.log('\n=== SUMMARY ===');
  console.log(`Sample: ${results.length} bets, max_tokens=${MAX_TOKENS}, throttle=${THROTTLE_MS}ms`);
  console.log('');
  console.log('Model'.padEnd(24) + 'match'.padEnd(8) + 'mismatch'.padEnd(10) + 'pending'.padEnd(10) + 'halluc'.padEnd(10) + 'abstain'.padEnd(10) + 'error'.padEnd(8) + 'avg_ms'.padEnd(8) + 'cache_hit%'.padEnd(12) + 'http_errs');
  console.log('-'.repeat(140));
  for (const [name, s] of Object.entries(summary)) {
    const n = results.length - (s.skipped || 0);
    const avgMs = n > 0 ? Math.round(s.total_latency_ms / n) : 0;
    const cacheHitPct = s.total_prompt_tokens > 0 ? Math.round(100 * s.total_cached_tokens / s.total_prompt_tokens) : 0;
    const httpErrs = Object.entries(s.errors_by_http).map(([k,v]) => `${k}:${v}`).join(' ') || '-';
    console.log(
      name.padEnd(24) +
      String(s.match).padEnd(8) +
      String(s.mismatch).padEnd(10) +
      String(s.pending_when_known).padEnd(10) +
      String(s.hallucination).padEnd(10) +
      String(s.correct_abstain).padEnd(10) +
      String(s.error).padEnd(8) +
      String(avgMs).padEnd(8) +
      `${cacheHitPct}%`.padEnd(12) +
      httpErrs
    );
  }
  console.log('\nFull results written to', OUT_PATH);
  db.close();
}

main().catch(err => {
  console.error('[bench] FATAL', err);
  process.exit(1);
});