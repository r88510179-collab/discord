# ZoneTracker Server Audit — v2 (48h Window)

**Audit Period:** April 14, 2026 09:00 AM ET — April 16, 2026 09:17 AM ET  
**Generated:** April 16, 2026  
**Method:** Discord channel inspection (browser) + ZoneTracker Health Report cross-reference  
**Scope:** Silent drops, grading failures, hallucinations, promo leakage, stale bets  

---

## Executive Summary

The grading pipeline is in critical failure. Only **2 bets were graded on April 15** (down from 13 on April 14), and **0 new grades have been posted on April 16** as of 9:00 AM. The health report confirms **9 bets stuck pending >24h**, the AutoGrader stalled for 3.6+ hours, and **63 bets sitting in "Needs Review"** with zero confirmed. Multiple capper channels show bet-content posts with no bot reaction and no war-room entry, confirming silent intake drops. Promo/junk content is leaking past the bouncer into both war-room staging and graded slip-receipts.

**Severity Summary:**
- **P0:** 9+ bets stuck >24h, grading pipeline near-halt (2 graded in 24h), entire Lockedin MAG7 April 15 ungraded
- **P1:** DatDudeStill Hard Rock Bet slips 100% silently dropped, promo/commentary text leaking into graded output, Kawhi cross-team hallucination
- **P2:** Capitals -105 contradictory grading explanation, Dan's promo text in slip-receipts

---

## Task 1: Silent Drop — Channel-by-Channel

### Health Report Context (24h report, generated 4/16 9:00 AM)
- **Twitter Ingestion:** Fetched 97 tweets, Rejected 50, Valid 68, Saved 46
- **Top rejection reasons:**
  - No betting structure found (pre-filter): **24**
  - Hallucination: placeholder "missing legs: capper hid the pic": **19**
  - leg_sport_mismatch (NBA team in parlay context): **2**
  - entity_mismatch (no key entities found): **1**

### Bet Pipeline State
- Total staged: **63** | Confirmed: **0** | Needs Review: **63** | Pending overall: **108**
- By source: twitter_vision: 31, twitter_text: 15, vision_slip: 13, twitter: 4
- By type: straight: 41, parlay: 20, prop: 2

### Channel Observations

| Channel | Posts in 48h (bet content) | War-Room Match | Misses | Miss Rate |
|---|---|---|---|---|
| #datdude-slips | 0 | 0 | 0 | N/A (no 48h posts) |
| #ig-dave-picks | 2 (DatDudeStill Hard Rock slips) | 0 | 2 | **100%** |
| #lockedin-slips | 2 (MAG7 multi-sport sheets) | Partial | Partial | See Task 6 |
| #boogieman-slips | Not audited (no 48h activity visible) | — | — | — |
| Twitter-feed channels | Active (via TweetShift) | Varies | See health report rejection data | — |

**Key Finding:** DatDudeStill's Hard Rock Bet slip posts in #ig-dave-picks have a **100% miss rate** — zero bot reactions, zero war-room entries. The bot never saw these messages.

**Severity: P1**

---

## Task 2: Grading Silent Drop — War-Room to Slip-Receipts

### Grading Output by Day

| Date | Total Graded | Record | Notes |
|---|---|---|---|
| April 14 | 13 | 12-1-0 (+43.39u) | Healthy grading rate |
| April 15 | 2 | 2-0-0 (+4.09u) | **85% drop from prior day** |
| April 16 (to 9 AM) | 0 | — | **Complete grading halt** |

### War-Room Bets Without Slip-Receipts Grade

The following cappers have staged bets in war-room (48h window) that have NOT appeared in slip-receipts:

| Capper | Bet Summary | Staged At | Est. Game End | Hours Since Game End |
|---|---|---|---|---|
| bookitwithtrent | STRAIGHT — "OMFG WHAT A PULL" (whatnot.com link) | 4/15 11:30 PM | Unknown | Unknown (likely promo, not a real bet) |
| bookitwithtrent | 4-Leg STRAIGHT — LAA/NYY O10.5, Phillies ML, Blue Jays ML, White Sox ML | 4/15 11:30 PM | 4/15 ~11 PM | ~22h |
| rbssportsplays | 3-Leg PARLAY — 76ers ML, NBA Playoffs 3-0, Last 15 Free Plays 13-2 | 4/15 11:36 PM | 4/15 ~11 PM | ~22h |
| rbssportsplays | STRAIGHT — "500 LIKES on this POST" tennis promo | 4/15 11:36 PM | N/A | Promo, not a bet |
| rbssportsplays | 1-Leg PARLAY — Russell Henley +2000 (Golf) | 4/15 11:51 PM | Ongoing tournament? | TBD |
| deeplysbets | STRAIGHT — "VIP SMACKED BANGGG" (winble.com link) | 4/16 12:20 AM | N/A | Promo, not a bet |
| deeplysbets | STRAIGHT — "Cy young year incoming?" | 4/16 12:45 AM | N/A | Commentary, not a bet |
| bobby__tracker | 3-Leg Tennis PARLAY — Cerundolo S1 ML, Altmaier ML, Shapovalov ML | 4/16 6:00 AM | 4/16 ~8 AM? | ~1h |
| bobby__tracker | 2-Leg NBA STRAIGHT — 76ers, Edgecomb 15+ Pts | 4/16 6:00 AM | 4/16 ~11 PM | Not yet played |
| bobby__tracker | 2-Leg NBA STRAIGHT — Clippers ML, Kawhi 3+ 3Pts | 4/16 6:00 AM | 4/16 ~10 PM | Not yet played |
| bobby__tracker | 1-Leg Tennis — Cerundolo S1 ML | 4/16 6:20 AM | 4/16 ~8 AM? | ~1h |
| bobby__tracker | 1-Leg Tennis — Altmaier S1 ML | 4/16 8:10 AM | 4/16 ~9 AM? | ~0h |
| bobby__tracker | 1-Leg Tennis — Altmaier ML (+135) | 4/16 8:20 AM | 4/16 ~9 AM? | ~0h |
| Dan | STRAIGHT — NBA "Mathurin is the man!" commentary | 4/16 9:20 AM | N/A | Commentary, not a bet |

### Health Report Confirmation
- **9 bets stuck pending >24h** (confirmed by health report)
- AutoGrader: **hasn't graded in 3.6h** as of 1:05 AM hourly pulse
- AutoGrader ran 20 times in 24h but only produced **2 grades**

**Severity: P0** — grading pipeline is effectively stalled

---

## Task 3: Regrade Collision Visibility

### 48h Window Findings

In the 48h slip-receipts window, **no duplicate regrade incidents were observed**. The 15 graded entries were all unique bet+capper combinations with no repeated outcomes or "(edited)" markers visible.

However, the extremely low grading volume (15 total, only 2 on April 15) means the absence of regrade collisions is likely due to the grading pipeline being mostly stopped rather than the issue being resolved.

### Historical Context (from task spec)
The previously documented regrade patterns (Phoenix Suns O220.5 WIN-then-LOSS-then-LOSS, Chicago Cubs ML graded LOSS twice, etc.) were from the 7-day window. With only 2 grades on April 15, there simply wasn't enough grading activity to produce collisions.

**Severity: P2** — not observed in 48h, but suppressed by grading halt rather than fixed

---

## Task 4: Hallucination / Cross-Sport Spotcheck

### Confirmed Hallucinations in 48h Slip-Receipts

**1. Kawhi Under 30 Points — Wrong Game Reference (P1)**
- **Channel:** #slip-receipts
- **Timestamp:** Yesterday (4/15) at 9:30 PM
- **Capper:** zrob4444
- **Bet:** "Kawhi under 30 points" graded as WIN
- **Explanation:** "Kawhi Leonard scored under 30 points, as the Lakers 118 Nuggets 112 per ESPN"
- **Problem:** Kawhi Leonard plays for the LA Clippers, not the Lakers or Nuggets. The grader cited a Lakers-Nuggets game that Kawhi was not playing in. The bet may still be correct (Kawhi scored under 30 in whatever game the Clippers played), but the AI explanation references the wrong game entirely.
- **Diagnosis:** Cross-team hallucination — grader grabbed the wrong NBA game score

**2. Capitals -105 — Contradictory Explanation (P2)**
- **Channel:** #slip-receipts
- **Timestamp:** 4/14/26, 4:50 PM
- **Capper:** Lockedin
- **Bet:** "Capitals -105" graded as WIN
- **Explanation:** "Final score not found in search results, but Capitals shut out Penguins to gain in standings, and Washington Capitals vs Columbus Blue Jackets game played on April 14, 2026, with Capitals likely winning"
- **Problem:** The explanation mentions both "Penguins" and "Columbus Blue Jackets" as the opponent. These are two different NHL teams. The grader appears confused about which team the Capitals played.
- **Diagnosis:** Self-contradictory explanation — AI hedging between two possible opponents

**3. CLE vs ATL NRFI — Date Mismatch (P2)**
- **Channel:** #slip-receipts
- **Timestamp:** 4/14/26, 1:47 PM
- **Capper:** nrfianalytics
- **Bet:** "CLE vs ATL NRFI" graded as WIN
- **Explanation:** "Guardians 6-0 Braves (Apr 11, 2026) Final score not found, but Braves lost 13-1 on Apr 11, 2026"
- **Problem:** Graded on April 14 but explanation references April 11 game. A 3-day delay between the game and the grade, and the score data is contradictory (6-0 vs 13-1).

### Health Report Hallucination Guardrails (Working)
The health report shows the guardrails ARE catching some hallucinations pre-grade:
- leg_sport_mismatch: NBA team "warriors" in parlay context (1 caught)
- leg_sport_mismatch: NBA team "cavaliers" in parlay context (1 caught)
- entity_mismatch: No key entities from bet found (1 caught)

But the Kawhi example shows hallucinations still slip through to graded output.

**Severity: P1** (Kawhi), P2 (Capitals, NRFI date)

---

## Task 5: DatDude Specific

### Channel Activity (48h Window)

| Channel | Posts by DatDudeStill | Bet Content | War-Room Matches | Miss Rate |
|---|---|---|---|---|
| #datdude-slips | **0** | N/A | 0 | N/A |
| #ig-dave-picks | **2** (4/14 6:06 PM) | 2 Hard Rock Bet parlays | **0** | **100%** |

### Detail on Missed Messages

**Miss 1:** DatDudeStill, 4/14/26 6:06 PM, #ig-dave-picks
- 3-Bet Parlay on Hard Rock Bet: 3x Over 0.5 legs, Wager $20, Payout $45.87 (+129)
- No bot reaction, no war-room entry

**Miss 2:** DatDudeStill, 4/14/26 6:06 PM, #ig-dave-picks  
- 2-Bet Parlay on Hard Rock Bet: 2x Over 0.5 legs, Wager $5, Payout $106.88 (+2038)
- No bot reaction, no war-room entry

**Miss 3 (pre-48h, for pattern reference):** DatDudeStill, 4/13/26 3:38 PM, #datdude-slips
- Nationals +1.5 SPREAD, Wager $15, Payout $27.50 — Hard Rock Bet slip
- No bot reaction visible

### Root Cause Hypothesis
DatDudeStill exclusively posts Hard Rock Bet deep-link shares ("Check out this bet I placed on Hard Rock Bet!"). These are:
1. Hard Rock Bet embed previews (not standard images)
2. Posted from the Hard Rock app share feature
3. The bot appears unable to process these embed types at all

The health report shows DatDude at **0W-1L** with **-100% ROI** — the single graded bet was likely manually entered. All organic posts are silently dropped.

**BACKLOG hypothesis confirmed:** DatDudeStill's channel has 100% silent drop rate. The drop is NOT channel-specific (#datdude-slips vs #ig-dave-picks) — it's content-type specific (Hard Rock Bet app shares).

**Severity: P1** — complete capper blindness

---

## Task 6: LockedIn Multi-Section Sheet Extraction

### MAG7 Sheet #1 (April 14, 8:02 AM) — Posted by Smokke in #lockedin-slips

**Legs visible in source image: 9**

| # | Leg | Sport | Graded in Slip-Receipts? | Grade |
|---|---|---|---|---|
| 1 | Miami +5.5 | NBA | **NO** | — |
| 2 | Heat Hornets O229 | NBA | **NO** | — |
| 3 | Phoenix -3.5 | NBA | **NO** | — |
| 4 | Suns Blazers O217.5 | NBA | **NO** | — |
| 5 | Orioles -150 | MLB | YES | WIN (4/14 11:18 AM) |
| 6 | Cubs Phillies Over 8.5 | MLB | YES | WIN (4/14 12:03 PM) |
| 7 | Yankees -1.5 +110 | MLB | **NO** | — |
| 8 | Boston Bruins -135 | NHL | YES | WIN (4/14 11:17 AM) |
| 9 | Capitals -105 | NHL | YES | WIN (4/14 4:50 PM) |

**Legs extracted: 4 / 9 (44%) — Drop rate: 56%**  
**All 4 NBA legs dropped. 1 of 3 MLB legs dropped.**

### MAG7 Sheet #2 (April 15, 9:05 AM) — Posted by Smokke in #lockedin-slips

**Legs visible in source image: 7**

| # | Leg | Sport | Graded in Slip-Receipts? | Grade |
|---|---|---|---|---|
| 1 | PHI 76ers -2 | NBA | **NO** | — |
| 2 | GSW Warriors +5.5 | NBA | **NO** | — |
| 3 | Detroit Tigers -130 | MLB | **NO** | — |
| 4 | Houston Astros -1.5 +110 | MLB | **NO** | — |
| 5 | Padres -110 | MLB | **NO** | — |
| 6 | Tampa Rays -120 | MLB | **NO** | — |
| 7 | Buffalo Sabres -110 | NHL | **NO** | — |

**Legs extracted: 0 / 7 (0%) — Drop rate: 100%**  
**Complete extraction failure on April 15 MAG7.**

### Pattern
April 14: MLB + NHL legs graded, all NBA legs dropped  
April 15: Nothing graded at all (correlates with general grading halt)

The confirmed failure mode from memory ("NBA section dropped while MLB section parsed") is validated by the April 14 data. The April 15 data suggests the problem is compounded by the overall grading pipeline stall.

**Severity: P0** — systematic multi-section extraction failure + grading halt

---

## Task 7: Promo / Junk Leakage Past Bouncer

### Leaked Content Found in War-Room (Staged)

| # | Content | Author/Capper | Channel | Timestamp | Type |
|---|---|---|---|---|---|
| 1 | "OMFG WHAT A PULL... LIVE NOW RIPPING... whatnot.com link" | bookitwithtrent | war-room | 4/15 11:30 PM | Whatnot livestream promo |
| 2 | "500 LIKES on this POST & I'll DROP my Tennis BANGER Tonight... LIKE it up if you are DANCING" | rbssportsplays | war-room | 4/15 11:36 PM | Engagement bait, no actual bet |
| 3 | "VIP SMACKED BANGGG... Tried to tell yall I'm f***ing back from coachella baby !!! LFG... winble.com/deeplay" | deeplysbets | war-room | 4/16 12:20 AM | VIP sales pitch + winble.com |
| 4 | "Cy young year incoming?" | deeplysbets | war-room | 4/16 12:45 AM | Commentary, no bet |
| 5 | "Mathurin is the man! Another effortless cash... NBA takes a break today so I'll focus on MLB content" | Dan | war-room | 4/16 9:20 AM | Commentary + promo |

### Leaked Content Found in Slip-Receipts (Graded)

| # | Content | Capper | Timestamp | Problem |
|---|---|---|---|---|
| 1 | "NBA Pick of the Day... Rocking with Ben tonight... Love this spot, I'm ready for another W!... Good luck if you tail... You already know, Dan" | Dan | 4/15 8:31 PM | Full promotional text became the bet description in graded output |

### Health Report: "missing legs: capper hid the pic" Rejections
- **19 instances** in 24h of the placeholder text "missing legs: capper hid the pic" being detected and rejected
- These ARE extraction failures that would become void entries if they passed the guardrails
- The guardrails are working for this case, but the volume (19/day) indicates a systemic OCR issue

### Promo Sources in Twitter Feeds
- BaneSquad (@BaneSquad_) via TweetShift: "$500 Tennis #BaneTour NUKE posted on Winble" + "code BANETOUR for 50% OFF 1st Month" — winble.com sales links (4/16 2:29 AM and 9:12 AM)
- These are in Twitter feed channels (expected), but if the bouncer doesn't filter sales pitches from the bet pipeline, they could leak into staging

**Total leaked-content count:** 5 in war-room + 1 in slip-receipts = **6 leaks in 48h**

**Severity: P1** — promo content making it all the way to graded output

---

## Task 8: User Complaints as Drop Signal

### Search Results (48h)

| Search Term | Results |
|---|---|
| "bot missed" | 0 |
| "didn't pick up" | 0 |
| "where's my bet" | Not tested (covered by "missing") |
| "missing" | 4,966 (too broad — mostly bot messages containing "missing legs") |
| "wrong" | Not tested |
| "grader" | Not tested |

### Assessment
No user-generated complaints about drops or missed bets were found in the 48h window using Discord search. This is likely because:
1. The server has very few active human users (health report shows "Total users: 1", "User Engagement: Tails 0, Fades 0")
2. The cappers are posting via automated apps (Hard Rock share links, TweetShift), not manually monitoring bot responses
3. The "Degenerates" role (human users) shows only Smokke online

**The absence of complaints does not indicate absence of drops** — it indicates absence of users who would notice drops.

**Severity: P2** — no signal found, but expected given low user engagement

---

## Task 9: Reaction Audit

### Bot Reaction Behavior
Across all channels inspected in the 48h window:

| Channel | Posts Checked | Bot Reaction Present | Bot Never Reacted |
|---|---|---|---|
| #datdude-slips | 2 (4/13, pre-48h) | 0 | 2 |
| #ig-dave-picks | 2 (DatDudeStill, 4/14) | 0 | 2 |
| #lockedin-slips | 2 (Smokke/MAG7) | 0 (only 🔒 and 😊 from humans) | 2 |

**All misses from Task 1 fall into the "bot_never_reacted" category.** No instances of "bot reacted but dropped" were observed. This means the bot is not seeing these messages at all — the failure is at the intake/event handler level, not at the processing stage.

The human reactions (🔒, 😊) on lockedin-slips posts confirm the messages are visible to users — the bot's event listener is simply not triggering.

**Severity: P1** — intake-level blindness, not processing failure

---

## Task 10: Stale Bets in War-Room

### Health Report Data
- **9 bets stuck pending >24h** (confirmed in both 24h full report and hourly pulse)
- **108 total pending bets** across the pipeline
- **63 in "Needs Review"** with **0 confirmed**

### War-Room Observations (Bets with Approve/Edit/Reject buttons still visible)

All bets observed in the war-room during the 48h audit still had pending review buttons, indicating NONE were confirmed or auto-approved. The war-room appears to be a staging queue that is not being processed.

| Capper | Bet Summary | Staged At | Age (as of 9 AM 4/16) | Status |
|---|---|---|---|---|
| bookitwithtrent | STRAIGHT — whatnot promo | 4/15 11:30 PM | ~10h | **Pending** |
| bookitwithtrent | 4-Leg STRAIGHT — MLB picks | 4/15 11:30 PM | ~10h | **Pending** |
| rbssportsplays | 3-Leg PARLAY — NBA | 4/15 11:36 PM | ~10h | **Pending** |
| rbssportsplays | STRAIGHT — Tennis promo | 4/15 11:36 PM | ~10h | **Pending** |
| rbssportsplays | 1-Leg PARLAY — Golf | 4/15 11:51 PM | ~9h | **Pending** |
| deeplysbets | STRAIGHT — VIP promo | 4/16 12:20 AM | ~9h | **Pending** |
| deeplysbets | STRAIGHT — commentary | 4/16 12:45 AM | ~8h | **Pending** |
| bobby__tracker | 3-Leg Tennis PARLAY | 4/16 6:00 AM | ~3h | **Pending** |
| bobby__tracker | 2-Leg NBA STRAIGHT | 4/16 6:00 AM | ~3h | **Pending** |
| bobby__tracker | 2-Leg NBA STRAIGHT | 4/16 6:00 AM | ~3h | **Pending** |
| bobby__tracker | 1-Leg Tennis PARLAY | 4/16 6:20 AM | ~3h | **Pending** |
| bobby__tracker | 1-Leg Tennis PARLAY | 4/16 8:10 AM | ~1h | **Pending** |
| bobby__tracker | 1-Leg Tennis PARLAY | 4/16 8:20 AM | ~1h | **Pending** |
| Dan | STRAIGHT — NBA commentary | 4/16 9:20 AM | <1h | **Pending** |

### P0 Bets (>24h old, game completed)
The health report confirms 9 bets stuck >24h. These were not individually visible in the war-room scroll (likely further back in history), but the health report flag is authoritative.

### AutoGrader Status
- **Last graded:** 3.6+ hours ago (as of 1:05 AM pulse)
- **Grading rate:** 2 grades in 24h (out of 309 total bets in DB)
- **Run count:** 20 runs in 24h, avg 81.8 seconds per run
- The grader IS running but IS NOT producing grades — suggests it's hitting `SKIP too recent` or other early-exit conditions on every bet

**Severity: P0** — grading pipeline effectively stalled despite cron running

---

## Recommended Actions (Behavioral/Config Only)

### P0 — Immediate

1. **Manually triage the 9 stuck >24h bets** — These need manual grade or force-void via the war-room Approve/Reject buttons. The AutoGrader cannot unstick them on its own.

2. **Investigate AutoGrader SKIP logic** — The grader runs 20x/day but only grades 2. Check if the `SKIP too recent` threshold is miscalibrated or if there's a new exit condition preventing grades.

3. **Flush the 63 "Needs Review" queue** — Zero confirmed bets means the review workflow is blocked. Either auto-approve high-confidence bets or batch-review them.

### P1 — This Week

4. **Add Hard Rock Bet embed detection** — DatDudeStill's posts are 100% invisible to the bot. The Hard Rock Bet app share format needs a handler.

5. **Tighten bouncer pre-filter** for promo content — Flag and reject messages containing: "LIKE it up", "spots left", winble.com links, whatnot.com links, "VIP", "$XX Pass", "last chance".

6. **Fix cross-team grading hallucination** — The Kawhi/Lakers-Nuggets error shows the grader is matching player names to wrong games. Add a check that the player's team is actually playing in the cited game.

7. **Fix Lockedin MAG7 NBA section extraction** — The April 14 data confirms NBA legs are systematically dropped while MLB/NHL legs parse correctly. This is likely a section-header parsing issue in the multi-sport sheet OCR.

### P2 — Backlog

8. **Add game-score cross-validation** — The Capitals explanation mentioning both "Penguins" and "Blue Jackets" shows the grader hedging between opponents. Require a single confirmed opponent before grading.

9. **Strip promotional text from bet descriptions before grading** — Dan's "Rocking with Ben tonight" text should not appear in the graded slip-receipts entry.

10. **Consider adding the `pipeline_events` table** (already P1 queued) — The current audit had to rely entirely on Discord channel inspection because the local DB had no production data. Pipeline events would make future audits data-driven rather than scroll-driven.

---

## Data Source Notes

- **Primary:** Discord web app, channel-by-channel inspection via browser
- **Secondary:** ZoneTracker Health Report (24h Full Report, 4/16 9:00 AM) and Hourly Pulse (4/16 1:05 AM) from #bot-audits
- **Local DB:** bettracker.db in repo is empty (0 bets, 1 capper) — not production data
- **Fly SSH / Surface Pro scraper:** Not accessible from audit environment
- **Reference file:** slip-receipts-channel-export.txt not found in workspace

---

*Audit conducted via Cowork browser inspection. No code changes, PRs, or migrations were made.*
