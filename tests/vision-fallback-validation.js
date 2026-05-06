// ═══════════════════════════════════════════════════════════
// Vision fallback validation — exercises tryVisionGemma against
// each image in ~/Documents/discord/test-fixtures/vision/.
//
// Gracefully skipped when OLLAMA_URL / OLLAMA_PROXY_SECRET are
// unset (i.e. in CI / local-without-Tailscale).
//
// This is a sanity probe, not a correctness test — it prints
// what Gemma produces so a human can eyeball the output.
// ═══════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { tryVisionGemma, parseGemmaOutputWithCerebras } = require('../services/ai');

const FIXTURES_DIR = path.join(__dirname, '..', 'test-fixtures', 'vision');
const FIXTURE_LIMIT = Number(process.env.VISION_FIXTURE_LIMIT || 3);

async function main() {
  if (!process.env.OLLAMA_URL || !process.env.OLLAMA_PROXY_SECRET) {
    console.log('⚠️  OLLAMA_URL / OLLAMA_PROXY_SECRET not set — skipping live Gemma test.');
    console.log('   (Run from Fly console with `cat /path/to/this.js | fly ssh console -C \'node -\'` for a live probe.)');
    process.exit(0);
  }

  if (!fs.existsSync(FIXTURES_DIR)) {
    console.log(`⚠️  Fixtures dir not found: ${FIXTURES_DIR} — nothing to probe.`);
    process.exit(0);
  }

  const files = fs.readdirSync(FIXTURES_DIR)
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .slice(0, FIXTURE_LIMIT);

  if (files.length === 0) {
    console.log(`⚠️  No image fixtures in ${FIXTURES_DIR}.`);
    process.exit(0);
  }

  console.log(`Probing Gemma 3:4b against ${files.length} fixture(s)...\n`);

  for (const f of files) {
    const p = path.join(FIXTURES_DIR, f);
    const buf = fs.readFileSync(p);
    const b64 = buf.toString('base64');
    const mime = f.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    console.log(`── ${f} (${(buf.length / 1024).toFixed(0)}KB) ──`);
    const start = Date.now();
    const result = await tryVisionGemma(b64, mime);
    const dur = Date.now() - start;
    if (!result.ok) {
      console.log(`  ❌ Gemma fail (${dur}ms) errorClass=${result.errorClass} error=${result.error}\n`);
      continue;
    }
    const raw = result.value;
    console.log(`  ✅ Gemma OK (${dur}ms, ${raw.length} chars)`);
    console.log(`  first 200 chars: ${raw.slice(0, 200).replace(/\n/g, ' | ')}`);

    // Also try Cerebras parse when we have a CEREBRAS_API_KEY
    if (process.env.CEREBRAS_API_KEY) {
      const parsed = await parseGemmaOutputWithCerebras(raw);
      if (parsed) {
        const bets = Array.isArray(parsed.parsed?.bets) ? parsed.parsed.bets : [];
        const legCount = bets.reduce((n, b) => n + (Array.isArray(b.legs) ? b.legs.length : 0), 0);
        console.log(`  ✅ Cerebras parsed: ${bets.length} bet(s), ${legCount} total legs`);
      } else {
        console.log('  ❌ Cerebras could not parse Gemma output into legs');
      }
    }
    console.log('');
  }
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
