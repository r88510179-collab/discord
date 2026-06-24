// ═══════════════════════════════════════════════════════════
// MLB team/total grader must REFUSE mis-routed PLAYER props.
//
// Severity: HIGH (live +P&L corruption). A leg shaped
// "Team vs Team Over 0.5 PLAYER - HITS" (and variants) fails player-prop
// routing — its subject canonicalizes to a team, or the name isn't
// recognized — and falls through to mlb.gradeMlbBet, the GAME-total grader.
// That grader read the "Over 0.5" as a run-total line, saw the real game
// total (always > 0.5), and returned WIN — ignoring the player entirely.
// Six bets (DatDude ×5, IgDave ×1) were manually corrected from false
// win/void to LOSS, a −74.42u swing.
//
// Fix (guard only — routing is NOT changed in this PR): gradeMlbBet refuses to
// grade a description as a game total when a whole-word scan of the WHOLE
// description finds a non-run PLAYER-stat token — hits, walks, strikeouts, RBI,
// total bases, home runs, stolen bases, outs, earned runs, plus the standard book
// abbrevs ks/k/so, bb, sb, er, po, hr (all \b-anchored, collision-free vs the 30
// teams; "tb" alone is excluded = Tampa Bay). The scan is over the whole text, NOT
// the prop parser's resolved stat: in "Team vs Team Over 0.5 PLAYER STAT" the player
// name sits in the stat field where the parser's loose resolveStat picks a stray
// letter (the 'r' in "Tarik"/"Cruz" → "runs") and would MISS the prop. There is no
// line/marker check — a high-line prop ("Over 5.5 Strikeouts") must still be refused,
// and no real run total carries a player-stat word. A bare single-letter "H" is too
// collision-prone to scan for directly, so it is caught by a parser fallback (parses
// as a prop + subject canonicalizes to a team + non-run stat). "runs"/"r" is excluded
// so real game totals and inning/NRFI "Under 0.5 Runs" lines still grade. Two
// adversarial-review passes found the walks/earned-runs/outs, then K/SO/SB/H, and
// high-line holes that this approach all closes. On refuse it returns {resolved:false,
// reason:'player_prop_misrouted_to_total'} so the caller falls through to ESPN+AI /
// manual review instead of auto-winning. The guard runs BEFORE any network fetch,
// so the refusal half of this test is fully offline.
//
// Pre-fix this file is RED: the helper is undefined (unit section throws) and
// gradeMlbBet hits the throwing fetch instead of refusing (returns no refusal).
// ═══════════════════════════════════════════════════════════

const mlb = require('../services/sportsdata/mlb');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}${detail !== undefined ? ` — ${detail}` : ''}`); fail++; }
}

console.log('mlb-prop-total-guard:');

(async () => {
  // ── Pure helper: positives (mis-routed player props) ──────────────────────
  console.log(' looksLikeMisroutedPlayerProp → TRUE (mis-routed prop):');
  const misrouted = [
    'St. Louis Cardinals vs Pirates Over 0.5 NOLAN GORMAN - HITS',
    'Angels vs Athletics Over 0.5 Zach Neto - HITS',
    'Diamondbacks vs Giants Over 0.5 Matt Chapman - HITS',
    'St. Louis Cardinals vs Pirates Over 0.5 MASYN WINN - HITS',
    // NOTE: post the word-boundary canonicalize fix, the single-player clean form
    // "Masyn Winn …" no longer canonicalizes to a team, so in the LIVE path it routes
    // to the player-prop grader (looksLikePlayerProp=true) — it is no longer mis-routed
    // to gradeMlbBet. looksLikeMisroutedPlayerProp still returns true for it via the
    // whole-text PLAYER_STAT_TOKEN_RX scan (a harmless backstop if it ever reached the
    // team grader). The genuine mis-route targets are the matchup-prefixed (team-subject)
    // forms above, where the subject canonicalizes to a team and looksLikePlayerProp=false.
    'Masyn Winn Over 0.5 Hits',                                   // "hits" token
    'Cardinals vs Pirates Over 0.5 Nolan Gorman - TO RECORD 1+ HITS', // variant phrasing
    'Tigers vs Guardians Over 0.5 Tarik Skubal Ks',              // strikeouts (Ks)
    'Yankees vs Red Sox Over 0.5 Aaron Judge - RBI',             // rbi
    'Dodgers vs Padres Over 0.5 Mookie Betts - Total Bases',     // total bases
    'Mets vs Braves Over 0.5 Pete Alonso Home Run',             // home run
    'Reds vs Cubs Over 0.5 Elly De La Cruz - Stolen Base',       // stolen base
    // ── Holes an earlier narrower draft missed (adversarial review): every non-run
    //    STAT_MAP stat is now a token, so the whole-text scan catches each one (these
    //    single-player forms route to the prop grader live — see the NOTE above; the
    //    helper's true verdict here is the token-scan backstop, not a canonicalize hit).
    'Masyn Winn Over 0.5 Walks',                                 // baseOnBalls
    'Masyn Winn Over 0.5 BB',                                    // baseOnBalls (abbrev)
    'Masyn Winn Over 0.5 Earned Runs',                           // earnedRuns
    'Masyn Winn Over 0.5 ER',                                    // earnedRuns (abbrev)
    'Masyn Winn Over 0.5 Outs',                                  // outs
    // ── High line (≥4.5): the old line-marker would have let these false-WIN; the
    //    scan keys on the player stat, not the line, so they are caught.
    'Masyn Winn Over 5.5 Strikeouts',                            // strikeOuts, high line
    'Masyn Winn Over 1.5 Total Bases',                           // totalBases, line ≥1.5
    'Masyn Winn Over 5.5 Total Bases',                           // totalBases, high line
    // ── Abbreviation holes a 2nd review pass found (K/SO/SB) — all collision-free:
    'Masyn Winn Over 0.5 K',                                     // strikeOuts (bare K)
    'Masyn Winn Over 0.5 SO',                                    // strikeOuts (SO)
    'Cardinals vs Pirates Over 0.5 Nolan Gorman - K',           // team-vs-team bare K
    'Masyn Winn Over 0.5 SB',                                    // stolenBases (SB)
    // ── Bare single-letter "H": caught by the parser fallback (subject canonicalizes to a
    //    team + non-run stat), not a free-floating \bh\b. Post the word-boundary canonicalize
    //    fix this fires ONLY for the matchup (team-subject) form — the single-player
    //    "Masyn Winn Over 0.5 H" now routes to the prop grader (looksLikePlayerProp=true),
    //    so it is no longer a mis-route and is intentionally NOT asserted true here.
    'Cardinals vs Pirates Over 0.5 Nolan Gorman - H',           // team-vs-team bare H
  ];
  for (const d of misrouted) {
    check(`misrouted: "${d}"`, mlb.looksLikeMisroutedPlayerProp(d) === true);
  }

  // ── Pure helper: negatives (real totals / non-stat legs must NOT trip) ─────
  console.log(' looksLikeMisroutedPlayerProp → FALSE (real total / not a stat prop):');
  const realTotals = [
    'New York Mets vs St. Louis Cardinals Under 8.5 Total Runs', // parses → stat "runs" → allowed
    'Yankees Red Sox Over 8.5',                                  // no stat after the line → not a prop shape
    'Los Angeles Dodgers Over 8.5 Runs',                        // game total → stat "runs" → allowed
    'Atlanta Braves ML',                                        // moneyline → no O/U+stat shape
    'New York Yankees -1.5',                                    // run line → no O/U+stat shape
    'Yankees vs Red Sox 1st Inning Under 0.5 Runs',             // "runs" is allowed → still a total (low line OK)
    'Yankees vs Red Sox NRFI',                                  // no O/U+stat shape
    'Padres vs Dodgers Over 7.5 Total',                         // "Total" alone resolves to no stat → not a prop
    'Astros vs Mariners Over 6.5 Total Runs',                   // stat "runs", low-ish line → still allowed
    // ── Collision probes: team names / abbrevs must NOT false-trip a stat token ──
    'Tampa Bay Rays vs Boston Red Sox Over 8.5',                // "tb" EXCLUDED (= Tampa Bay); "so" ≠ "sox"
    'TB vs BOS Over 8.5 Total Runs',                            // literal "TB" team abbrev, not "total bases"
    'Texas Rangers vs Detroit Tigers Over 9.5',                 // "rangers"/"tigers" — no standalone "er"
    'San Diego Padres ML',                                      // "padres" — no standalone "po"
    'Red Sox vs White Sox Over 8.5',                            // "\bso\b" must NOT match "sox"
    'KC Royals vs OAK Athletics Over 9.5',                      // "\bk\b" must NOT match "KC"/"OAK"
    'Yankees @ H Astros Over 8.5',                              // stray standalone "H": no bare \bh\b, no prop shape
  ];
  for (const d of realTotals) {
    check(`real total: "${d}"`, mlb.looksLikeMisroutedPlayerProp(d) === false);
  }

  // null/empty safety
  check('null → false, no throw',
    (() => { try { return mlb.looksLikeMisroutedPlayerProp(null) === false; } catch (e) { return false; } })());
  check('"" → false, no throw',
    (() => { try { return mlb.looksLikeMisroutedPlayerProp('') === false; } catch (e) { return false; } })());

  // ── gradeMlbBet refuses the mis-routed prop BEFORE any network fetch ───────
  // Any fetch means the guard did NOT short-circuit first → fail loudly.
  console.log(' gradeMlbBet refuses before fetch:');
  let networkAttempted = false;
  global.fetch = async () => { networkAttempted = true; throw new Error('network must not be called for a mis-routed player prop'); };

  const refuseCases = [
    'St. Louis Cardinals vs Pirates Over 0.5 NOLAN GORMAN - HITS',
    'Angels vs Athletics Over 0.5 Zach Neto - HITS',
    'Diamondbacks vs Giants Over 0.5 Matt Chapman - HITS',
  ];
  for (const d of refuseCases) {
    let r;
    try { r = await mlb.gradeMlbBet(d, '2026-05-01'); } catch (e) { r = { error: e.message }; }
    check(`refused (resolved:false, player_prop_misrouted_to_total): "${d}"`,
      r && r.resolved === false && r.reason === 'player_prop_misrouted_to_total',
      JSON.stringify(r));
  }
  check('no network was attempted for any refused prop (guard runs before fetch)', networkAttempted === false);

  // ── Real game totals STILL grade (mocked final game) — no over-broad refusal ─
  // Mock the MLB schedule + live feed so a real total resolves to a terminal grade.
  console.log(' real game totals still resolve (mocked final game):');
  const SCHEDULE = {
    dates: [{
      games: [{
        gamePk: 999,
        status: { abstractGameState: 'Final', detailedState: 'Final' },
        teams: {
          away: { team: { name: 'New York Mets' }, score: 3, isWinner: false },
          home: { team: { name: 'St. Louis Cardinals' }, score: 5, isWinner: true },
        },
      }],
    }],
  };
  global.fetch = async (url) => ({
    ok: true,
    json: async () => SCHEDULE,
  });
  // Total runs = 3 + 5 = 8. Under 8.5 → WIN; Over 8.5 → LOSS.
  let rt = await mlb.gradeMlbBet('New York Mets vs St. Louis Cardinals Under 8.5 Total Runs', '2026-05-01');
  check('"...Under 8.5 Total Runs" resolves (not refused)', rt && rt.resolved === true && rt.status === 'WIN', JSON.stringify(rt));
  let rt2 = await mlb.gradeMlbBet('New York Mets St. Louis Cardinals Over 8.5', '2026-05-01');
  check('normal full-game total resolves (not refused)', rt2 && rt2.resolved === true && rt2.status === 'LOSS', JSON.stringify(rt2));

  console.log(`\n${pass} passed / ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
