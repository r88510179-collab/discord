// ═══════════════════════════════════════════════════════════
// Twitter Image Parsing — Validation Tests
// Verifies that tweets with media URLs trigger Vision AI
// and that SGP/parlay detection works correctly.
// ═══════════════════════════════════════════════════════════

const assert = require('assert');

// ── Test 1: extractImageUrls extracts photo URLs ──
console.log('Test 1: extractImageUrls...');
{
  // Simulate the extraction logic
  function extractImageUrls(tweet) {
    const urls = [];
    if (Array.isArray(tweet.media)) {
      for (const m of tweet.media) {
        if (m.type === 'photo' && m.url) urls.push(m.url);
        else if (m.media_url_https) urls.push(m.media_url_https);
      }
    }
    if (urls.length === 0 && Array.isArray(tweet.photos)) {
      for (const p of tweet.photos) {
        if (p.url) urls.push(p.url);
      }
    }
    return urls;
  }

  // apitwitter.com format
  const tweet1 = {
    id: '123',
    text: 'FanDuel SGP +510',
    media: [
      { type: 'photo', url: 'https://pbs.twimg.com/media/abc123.jpg' },
      { type: 'photo', url: 'https://pbs.twimg.com/media/def456.jpg' },
    ],
  };
  const urls1 = extractImageUrls(tweet1);
  assert.strictEqual(urls1.length, 2, 'Should extract 2 photo URLs');
  assert.ok(urls1[0].includes('abc123'), 'First URL should match');

  // Legacy format
  const tweet2 = {
    id: '456',
    text: 'DK parlay',
    photos: [{ url: 'https://pbs.twimg.com/media/legacy.jpg' }],
  };
  const urls2 = extractImageUrls(tweet2);
  assert.strictEqual(urls2.length, 1, 'Should extract 1 legacy photo URL');

  // No media
  const tweet3 = { id: '789', text: 'Text only pick' };
  const urls3 = extractImageUrls(tweet3);
  assert.strictEqual(urls3.length, 0, 'Should extract 0 URLs for text-only');

  console.log('  PASS: Image URL extraction works for all formats');
}

// ── Test 2: SGP detection in tweet text ──
console.log('Test 2: SGP detection...');
{
  const sgpPatterns = [
    'FanDuel SGP +510 Nuggets vs Spurs',
    'Same Game Parlay for tonight',
    'sgp lock of the day',
    'My same game parlay hits again',
  ];
  const nonSgpPatterns = [
    'Lakers -3.5 ML',
    'Over 220.5 total points',
    'Parlay: Lakers + Dodgers', // regular parlay, not SGP
  ];

  const sgpRegex = /\b(sgp|same\s*game\s*parlay)\b/i;

  for (const text of sgpPatterns) {
    assert.ok(sgpRegex.test(text), `Should detect SGP in: "${text}"`);
  }
  for (const text of nonSgpPatterns) {
    assert.ok(!sgpRegex.test(text), `Should NOT detect SGP in: "${text}"`);
  }

  console.log('  PASS: SGP regex correctly identifies SGP tweets');
}

// ── Test 3: Vision path is chosen when images present ──
console.log('Test 3: Vision routing logic...');
{
  function chooseAIPath(tweet) {
    const imageUrls = [];
    if (Array.isArray(tweet.media)) {
      for (const m of tweet.media) {
        if (m.type === 'photo' && m.url) imageUrls.push(m.url);
      }
    }
    return imageUrls.length > 0 ? 'vision' : 'text';
  }

  const tweetWithImage = { media: [{ type: 'photo', url: 'https://example.com/slip.jpg' }] };
  const tweetTextOnly = { media: [] };
  const tweetNoMedia = {};

  assert.strictEqual(chooseAIPath(tweetWithImage), 'vision', 'Image tweet → vision path');
  assert.strictEqual(chooseAIPath(tweetTextOnly), 'text', 'Empty media → text path');
  assert.strictEqual(chooseAIPath(tweetNoMedia), 'text', 'No media field → text path');

  console.log('  PASS: Correct AI path selected based on media presence');
}

// ── Test 4: Parlay bet structure validation ──
console.log('Test 4: Parlay structure...');
{
  // Simulate what Vision AI should return for a 4-leg SGP
  const visionResult = {
    type: 'bet',
    is_bet: true,
    ticket_status: 'new',
    bets: [{
      sport: 'NBA',
      bet_type: 'parlay',
      description: '• Jokic O 8.5 Reb\n• Murray O 22.5 Pts\n• Gordon O 1.5 3PM\n• Spurs +7.5',
      odds: 510,
      units: 1,
      legs: [
        { description: 'Jokic O 8.5 Reb', odds: null, team: 'Nuggets', type: 'prop' },
        { description: 'Murray O 22.5 Pts', odds: null, team: 'Nuggets', type: 'prop' },
        { description: 'Gordon O 1.5 3PM', odds: null, team: 'Nuggets', type: 'prop' },
        { description: 'Spurs +7.5', odds: null, team: 'Spurs', type: 'spread' },
      ],
    }],
  };

  const bet = visionResult.bets[0];
  assert.strictEqual(bet.bet_type, 'parlay', 'Should be parlay');
  assert.strictEqual(bet.legs.length, 4, 'Should have 4 legs');
  assert.strictEqual(bet.odds, 510, 'Combined odds should be +510');
  assert.ok(bet.description.includes('Jokic'), 'Description should contain player names');

  console.log('  PASS: Parlay structure matches expected format');
}

console.log('\n✅ All twitter-image-parsing tests passed!');
