#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════
// scripts/sgp-audit.js — SGP would-hold audit: read-only evidence dump.
//
// 8 SGP slips FAILed the shadow would-hold gate (`ocr_sgp_would_hold`,
// services/ocrFirstWiring.js runSgpWouldHold). This script re-runs the exact
// same chain per slip — OCR → Groq parse → N-Bet header → evaluateSgpGate —
// and emits ONE JSON report to stdout so the rescuable-vs-junk call for PR 2b
// can be made from evidence instead of eyeballing screenshots.
//
// READ-ONLY: the DB is opened { readonly: true }; there is no INSERT/UPDATE/
// DELETE, no pipeline_events emit (recordStage is never imported), and no
// Discord write (REST GETs only). No production behavior change.
//
// REUSES the real production functions — nothing reimplemented:
//   services/localOcr.js        callOcrService        (RapidOCR HTTP client)
//   services/ocrFirst.js        callGroqParse, extractHeaderLegCount, SGP_RE
//   services/sgpGate.js         evaluateSgpGate       (pure)
//   services/ocrFirstWiring.js  fetchImageBytes, ALLOWED_IMAGE_HOSTS
//                               (host-allowlisted + size-capped + abort-bounded)
//
// Usage:
//   node scripts/sgp-audit.js [--ids <csv-of-message-ids>] [--db <path>]
//
//   --ids  defaults to the 8 FAILed slips (see DEFAULT_IDS).
//   --db   defaults to $DB_PATH, then /data/bettracker.db (prod, in-container).
//
// Run inside the Fly machine (all env present there):
//   fly ssh console -a bettracker-discord-bot -C "node scripts/sgp-audit.js" > report.json
// If this commit is merged-but-not-deployed, sftp-upload this file to /tmp and
// run `node /tmp/sgp-audit.js` — services/ resolve from APP_ROOT (default /app),
// i.e. the DEPLOYED module versions, same fallback as reconcile-needs-review.js.
//
// Env (names read from code, not memory):
//   DISCORD_TOKEN                     required — bot token for the REST GET
//   OCR_SERVICE_URL / OCR_SERVICE_TOKEN / OCR_TIMEOUT_MS   (services/localOcr.js)
//   GROQ_API_KEY / OCR_PARSE_MODEL / GROQ_MODEL / OCR_PARSE_TEMPERATURE
//                                     (services/ocrFirst.js callGroqParse)
//   OCR_IMAGE_MAX_BYTES               (services/ocrFirstWiring.js fetchImageBytes)
//
// Every network call is timeout-bounded: Discord REST via AbortSignal.timeout
// (DISCORD_TIMEOUT_MS below), image fetch via fetchImageBytes' AbortController
// (OCR_TIMEOUT_MS), OCR via callOcrService (OCR_TIMEOUT_MS), Groq via
// callGroqParse's internal 15s AbortSignal.
//
// Output: ONE JSON object on stdout. All progress/diagnostics go to stderr
// (the reused modules only console.warn, which is stderr, so stdout stays pure
// JSON). Per-message failures land in that message's `errors[]` and the run
// continues. Exit 0 when the report was emitted (even with per-message errors),
// 1 when EVERY message failed before OCR, 2 on usage/preflight errors.
//
// Deviations from the audit prompt (documented per house rule):
//   • No exports were added — every needed function was already exported.
//   • Groq parse is SKIPPED when OCR produced no text (production never parses
//     empty OCR; the gate still runs and reports its canonical SGP_OCR_EMPTY).
//   • Embed images: the raw embed URL is often an external host that
//     fetchImageBytes' allowlist rightly blocks, so for origin:'embed' images
//     the Discord-proxied `proxy_url` (media.discordapp.net) is preferred when
//     the raw url host is not allowlisted. Mirrors getImageAttachments intent.
//   • Multi-image messages: the chain runs per image (prompt step 3 says each
//     attachment); top-level report fields mirror image[0] — the shadow gate's
//     `image[0]_of_multi` scope — with every image's full chain in `images[]`.
// ═══════════════════════════════════════════════════════════

const path = require('path');

// Optional local-dev convenience; on Fly the env is real. Never fatal.
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

// The 8 slips that FAILed the shadow would-hold gate.
const DEFAULT_IDS = [
  '1522665209058164746',
  '1522717290624323685',
  '1523038383780270195',
  '1520859560825327666',
  '1523743668622856250',
  '1523743764038942950',
  '1523831106103934996',
  '1523831184268722238',
];

const PROD_DB_PATH = '/data/bettracker.db';
const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_TIMEOUT_MS = 15000;
const PER_MESSAGE_DELAY_MS = 1000; // pace Discord REST + OCR service
const PER_IMAGE_DELAY_MS = 250;

const USAGE = 'Usage: node scripts/sgp-audit.js [--ids <csv-of-message-ids>] [--db <path>]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Module resolution ─────────────────────────────────────────
// Repo run: services/ sit next to scripts/. Uploaded-to-/tmp run (merged !=
// deployed): resolve against APP_ROOT so the DEPLOYED services are reused.
const APP_ROOT = process.env.APP_ROOT || '/app';

function requireService(name) {
  const candidates = [
    path.join(__dirname, '..', 'services', name),
    path.join(APP_ROOT, 'services', name),
  ];
  let lastErr;
  for (const c of candidates) {
    try { return require(c); } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

// Same operator-flow fallback as scripts/reconcile-needs-review.js.
function requireBetterSqlite() {
  const candidates = ['better-sqlite3', path.join(APP_ROOT, 'node_modules', 'better-sqlite3')];
  let lastErr;
  for (const c of candidates) {
    try { return require(c); } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

// Resolution failure is a preflight error (exit 2), not the exit-1 "report
// emitted, every message failed early" code an uncaught throw would produce.
let localOcr, ocrFirst, sgpGate, wiring;
try {
  localOcr = requireService('localOcr.js');
  ocrFirst = requireService('ocrFirst.js');
  sgpGate = requireService('sgpGate.js');
  wiring = requireService('ocrFirstWiring.js');
} catch (err) {
  console.error(`ABORT: cannot resolve services/ (tried __dirname/../services and ${APP_ROOT}/services): ${err.message}`);
  process.exit(2);
}

const { callOcrService } = localOcr;
const { callGroqParse, extractHeaderLegCount, SGP_RE } = ocrFirst;
const { evaluateSgpGate } = sgpGate;
const { fetchImageBytes, ALLOWED_IMAGE_HOSTS } = wiring;

// ── Args ──────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { ids: DEFAULT_IDS, dbPath: process.env.DB_PATH || PROD_DB_PATH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ids') {
      const v = argv[++i];
      if (!v) return { error: '--ids requires a comma-separated value' };
      out.ids = v.split(',').map((s) => s.trim()).filter(Boolean);
      if (out.ids.length === 0) return { error: '--ids parsed to zero ids' };
      const bad = out.ids.find((id) => !/^\d{15,22}$/.test(id));
      if (bad) return { error: `--ids contains a non-snowflake value: '${bad}'` };
    } else if (a === '--db') {
      const v = argv[++i];
      if (!v) return { error: '--db requires a path' };
      out.dbPath = v;
    } else if (a === '--help' || a === '-h') {
      return { help: true };
    } else {
      return { error: `unknown argument: '${a}'` };
    }
  }
  return out;
}

// ── DB: resolve channelId/channelName from the RECEIVED event ──
function resolveChannel(db, messageId) {
  const row = db.prepare(`
    SELECT json_extract(payload, '$.channelId')   AS channelId,
           json_extract(payload, '$.channelName') AS channelName
    FROM pipeline_events
    WHERE stage = 'RECEIVED' AND source_type = 'discord' AND source_ref = ?
    ORDER BY id DESC LIMIT 1
  `).get(messageId);
  return row || null;
}

// ── Discord REST: GET one message; bounded; one retry on 429 ──
async function fetchDiscordMessage(channelId, messageId, token) {
  const url = `${DISCORD_API}/channels/${channelId}/messages/${messageId}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    });
    if (res.status === 429 && attempt === 0) {
      let waitMs = 2000;
      try {
        const body = await res.json();
        if (Number.isFinite(Number(body.retry_after))) waitMs = Math.ceil(Number(body.retry_after) * 1000) + 250;
      } catch (_) { /* default wait */ }
      console.error(`[sgp-audit] Discord 429 on ${messageId}; retrying in ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) return { ok: false, error: `discord_fetch: HTTP ${res.status}` };
    try {
      return { ok: true, message: await res.json() };
    } catch (err) {
      return { ok: false, error: `discord_fetch: invalid JSON body (${err.message})` };
    }
  }
  return { ok: false, error: 'discord_fetch: HTTP 429 after retry' };
}

function hostAllowlisted(url) {
  try { return ALLOWED_IMAGE_HOSTS.has(new URL(String(url)).hostname.toLowerCase()); }
  catch (_) { return false; }
}

// For embed images the raw url is often an external host (blocked by the
// fetch allowlist); prefer it only when allowlisted, else Discord's proxy.
function pickEmbedUrl(img) {
  if (!img) return null;
  if (img.url && hostAllowlisted(img.url)) return img.url;
  return img.proxy_url || img.url || null;
}

// Raw-REST-JSON port of handlers/messageHandler.js getImageAttachments (that
// function reads a discord.js Message — camelCase, Collections — so it cannot
// consume the REST payload directly). Same semantics: real attachments first,
// then embed images/thumbnails, then forwarded-snapshot attachments/embeds,
// deduped by URL, each tagged origin 'attachment' | 'embed'.
function extractImagesFromRest(message) {
  const images = [];

  for (const att of message.attachments || []) {
    if (att && typeof att.content_type === 'string' && att.content_type.startsWith('image/')) {
      images.push({ url: att.url, type: att.content_type, origin: 'attachment', filename: att.filename || null });
    }
  }

  for (const embed of message.embeds || []) {
    if (!embed) continue;
    if (embed.image) {
      const u = pickEmbedUrl(embed.image);
      if (u) images.push({ url: u, type: 'image/png', origin: 'embed', filename: null });
    } else if (embed.thumbnail) {
      const u = pickEmbedUrl(embed.thumbnail);
      if (u) images.push({ url: u, type: 'image/png', origin: 'embed', filename: null });
    }
  }

  for (const snap of message.message_snapshots || []) {
    const inner = (snap && snap.message) || {};
    for (const att of inner.attachments || []) {
      if (att && typeof att.content_type === 'string' && att.content_type.startsWith('image/')) {
        images.push({ url: att.url, type: att.content_type, origin: 'attachment', filename: att.filename || null });
      }
    }
    for (const embed of inner.embeds || []) {
      if (embed && embed.image) {
        const u = pickEmbedUrl(embed.image);
        if (u) images.push({ url: u, type: 'image/png', origin: 'embed', filename: null });
      }
    }
  }

  const seen = new Set();
  return images.filter((img) => {
    if (seen.has(img.url)) return false;
    seen.add(img.url);
    return true;
  });
}

// ── The would-hold chain on one image — the runSgpWouldHold chain, verbatim
//    order: OCR text → SGP token → N-Bet header → Groq parse → evaluateSgpGate.
async function auditImage(img, requestId, errors) {
  const out = {
    origin: img.origin,
    url: img.url,
    ocr: null,
    ocrText: '',
    sgpToken: null,
    declaredLegCount: null,
    parsedBet: null,
    parsedLegCount: null,
    legs: [],
    gate: null,
  };

  const bytes = await fetchImageBytes(img.url, img.type);
  if (!bytes || bytes.ok !== true) {
    errors.push(`image_fetch(${requestId}): ${(bytes && bytes.reason) || 'no bytes'}`);
    out.gate = evaluateSgpGate({ declaredLegCount: null, parsedBet: null, ocrText: '' });
    return out;
  }

  const ocr = await callOcrService(bytes.base64, bytes.mediaType, requestId);
  out.ocr = ocr.ok
    ? { ok: true, chars: ocr.text.length, confidence: ocr.confidence, latencyMs: ocr.latencyMs, imageHash: ocr.imageHash }
    : { ok: false, error: ocr.error };
  if (!ocr.ok) {
    errors.push(`ocr(${requestId}): ${ocr.error.code} ${ocr.error.message}`);
    out.gate = evaluateSgpGate({ declaredLegCount: null, parsedBet: null, ocrText: '' });
    return out;
  }

  out.ocrText = ocr.text;
  const sgpMatch = ocr.text.match(SGP_RE);
  out.sgpToken = sgpMatch ? sgpMatch[0] : null;
  out.declaredLegCount = extractHeaderLegCount(ocr.text);

  // Production never Groq-parses empty OCR text; the gate still reports
  // its canonical SGP_OCR_EMPTY below.
  if (ocr.text.trim()) {
    const parseRes = await callGroqParse(ocr.text, requestId);
    if (parseRes && parseRes.ok === true && parseRes.parsed) {
      out.parsedBet = parseRes.parsed;
      out.parsedLegCount = Array.isArray(parseRes.parsed.legs) ? parseRes.parsed.legs.length : null;
      out.legs = Array.isArray(parseRes.parsed.legs) ? parseRes.parsed.legs : [];
    } else {
      errors.push(`groq_parse(${requestId}): no valid parse (see stderr warns)`);
    }
  }

  out.gate = evaluateSgpGate({
    declaredLegCount: out.declaredLegCount,
    parsedBet: out.parsedBet,
    ocrText: out.ocrText,
  });
  return out;
}

async function auditMessage(db, messageId, token) {
  const result = {
    messageId,
    channelId: null,
    channelName: null,
    attachmentCount: 0,
    imageCount: 0,
    ocrText: '',
    sgpToken: null,
    declaredLegCount: null,
    parsedLegCount: null,
    legs: [],
    gate: null,
    images: [],
    errors: [],
  };

  const chan = resolveChannel(db, messageId);
  if (!chan || !chan.channelId) {
    result.errors.push("db_resolve: no RECEIVED row with a channelId for this source_ref");
    return result;
  }
  result.channelId = String(chan.channelId);
  result.channelName = chan.channelName != null ? String(chan.channelName) : null;

  const fetched = await fetchDiscordMessage(result.channelId, messageId, token);
  if (!fetched.ok) {
    result.errors.push(fetched.error);
    return result;
  }

  const message = fetched.message;
  result.attachmentCount = Array.isArray(message.attachments) ? message.attachments.length : 0;

  const images = extractImagesFromRest(message);
  result.imageCount = images.length;
  if (images.length === 0) {
    result.errors.push('images: message carries no image attachments or embed images');
    return result;
  }

  for (let i = 0; i < images.length; i++) {
    if (i > 0) await sleep(PER_IMAGE_DELAY_MS);
    const requestId = `sgp-audit-${messageId}-img${i}`;
    result.images.push(await auditImage(images[i], requestId, result.errors));
  }

  // Top-level chain fields mirror image[0] — the shadow gate's production scope.
  const first = result.images[0];
  result.ocrText = first.ocrText;
  result.sgpToken = first.sgpToken;
  result.declaredLegCount = first.declaredLegCount;
  result.parsedLegCount = first.parsedLegCount;
  result.legs = first.legs;
  result.gate = first.gate ? { pass: first.gate.pass, reason: first.gate.reason, detail: first.gate.detail, normalizedBet: first.gate.normalizedBet } : null;

  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.error(USAGE); process.exit(0); }
  if (args.error) { console.error(`${args.error}\n${USAGE}`); process.exit(2); }

  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error('ABORT: DISCORD_TOKEN not set — cannot fetch messages. Run inside the Fly machine (fly ssh console).');
    process.exit(2);
  }
  if (!process.env.OCR_SERVICE_URL) {
    console.error('WARN: OCR_SERVICE_URL not set — every OCR call will fail typed UNREACHABLE.');
  }
  if (!process.env.GROQ_API_KEY) {
    console.error('WARN: GROQ_API_KEY not set — every Groq parse will fail and gates will report NO_LEGS.');
  }

  const Database = requireBetterSqlite();
  let db;
  try {
    db = new Database(args.dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    console.error(`cannot open --db=${args.dbPath} read-only: ${err.message}`);
    process.exit(2);
  }

  const results = [];
  try {
    for (let i = 0; i < args.ids.length; i++) {
      if (i > 0) await sleep(PER_MESSAGE_DELAY_MS);
      const id = args.ids[i];
      console.error(`[sgp-audit] ${i + 1}/${args.ids.length} message ${id} …`);
      try {
        results.push(await auditMessage(db, id, token));
      } catch (err) {
        // Per-message failures never end the run.
        results.push({
          messageId: id, channelId: null, channelName: null, attachmentCount: 0,
          imageCount: 0, ocrText: '', sgpToken: null, declaredLegCount: null,
          parsedLegCount: null, legs: [], gate: null, images: [],
          errors: [`unexpected: ${err.message}`],
        });
      }
    }
  } finally {
    db.close();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dbPath: args.dbPath,
    ids: args.ids,
    env: {
      ocrServiceUrlSet: !!process.env.OCR_SERVICE_URL,
      groqApiKeySet: !!process.env.GROQ_API_KEY,
      ocrParseModel: process.env.OCR_PARSE_MODEL || process.env.GROQ_MODEL || null,
    },
    results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  // exitCode + natural exit (NOT process.exit): the report just written can
  // exceed the 64KB pipe buffer, and process.exit() drops undrained stdout —
  // same house pattern (and comment) as scripts/reconcile-needs-review.js.
  const allFailedEarly = results.every((r) => r.images.length === 0);
  process.exitCode = allFailedEarly ? 1 : 0;
}

main().catch((err) => {
  console.error(`fatal: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 2;
});
