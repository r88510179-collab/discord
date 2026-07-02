# 2026-07-02 — Pre-gate shadow regrade (read-only audit)

**What:** all **491** pre-gate AI-graded settled straights (`grader_version` NULL era, exported to
`prompts/pregate-export.json`) shadow-regraded against the deterministic grading layer by
[`scripts/shadow-regrade-pregate.js`](../../scripts/shadow-regrade-pregate.js). Input was the local
export file only — no production resource was opened.

> **NO corrections applied.** This run is report-only; any result/PU writes are a separate
> operator-gated step after this report is reviewed. (Backlog context: this executes and closes
> item (b) of the "No-selection gradeability guard + pre-gate hallucinated-grade audit" P1 —
> the n=15 hallucinated-entity sample was 0/15, so the audit was downgraded to this
> wrong-game/wrong-math shadow pass per plan.)

## Controls

Both mandatory controls agreed before the full run:

| control | stored | shadow | evidence |
|---|---|---|---|
| `6de36407` Minnesota Timberwolves ML | win | WIN | MIN 112, DEN 96 — ESPN NBA scoreboard 2026-04-25 |
| `8f3087b1` Chicago Cubs Houston Astros O7.5 | loss | LOSS | HOU 3, CHC 0 (total 3 < 7.5) — statsapi 2026-05-23 |

## Totals

| | count | share |
|---|---|---|
| **Agree** | 327 | 66.6% |
| **Disagree** | 71 | 14.5% |
| **Unresolved** | 93 | 18.9% |

Disagreement directions: **25 stored-loss → shadow-WIN**, **46 stored-win → shadow-LOSS**.
Net P/L delta if every suggested correction were applied: **-21.61u** (stored results overstate P/L).
High-confidence subset only (see flags below): 24 rows, net **1.79u**.

### Sport × market

| sport (used) | market | agree | disagree | unresolved |
|---|---|---|---|---|
| MLB | ML | 84 | 32 | 3 |
| MLB | game_total | 19 | 5 | 0 |
| MLB | mlb_prop | 10 | 0 | 1 |
| MLB | multi_market | 0 | 0 | 1 |
| MLB | other | 0 | 0 | 10 |
| MLB | spread | 21 | 12 | 0 |
| MLB | team_total | 0 | 1 | 0 |
| NBA | ML | 26 | 1 | 2 |
| NBA | game_total | 17 | 5 | 4 |
| NBA | multi_market | 0 | 0 | 18 |
| NBA | nba_prop | 7 | 1 | 1 |
| NBA | other | 0 | 0 | 20 |
| NBA | spread | 87 | 10 | 11 |
| NBA | team_total | 1 | 0 | 0 |
| NHL | ML | 34 | 1 | 11 |
| NHL | game_total | 9 | 2 | 2 |
| NHL | multi_market | 0 | 0 | 1 |
| NHL | nhl_prop | 1 | 0 | 0 |
| NHL | other | 0 | 0 | 8 |
| NHL | spread | 11 | 1 | 0 |

(`sport (used)` is the sport the shadow actually graded under — 3 rows were deterministically
rerouted off a wrong stored sport label, e.g. "Bam Adebayo Under 20.5 Points" stored as MLB;
none of the rerouted rows disagreed.)

## Failure patterns in the stored grades

The pre-gate AI grader's errors cluster into four classes, all visible in the table below:

1. **Same-game arithmetic/direction errors** — the AI cites the same final the shadow found and
   still grades it wrong. E.g. `ac1e6589` "Suns Rockets O220.5": AI cites 105–119 (= 224 > 220.5)
   and grades loss; `07cec57a` "Miami Heat +5.5": AI cites Hornets 127–126 (a 1-pt loss, easy
   cover) and grades loss; `8a06e80c` "Lakers Thunder O223.5": AI cites "123-87" (= 210) and
   grades win; `ca373563` grades the SPREAD from the wrong side's perspective.
2. **Wrong-day / wrong-game grades** — same matchup, different game of the series
   (`6f371722` Mariners ML: AI grades a 0–5 loss; statsapi shows 7–3 win on the bet's ET day), or
   a game days away (`d1bb4b57` Bulls -6.5 created Apr 9, AI grades the Apr 3 Knicks blowout).
3. **Reversed team–score assignment** — `4e1c67ae` Dodgers -159: AI "dodgers 0, giants 3";
   statsapi has Dodgers 3, Giants 0.
4. **Team total graded with game-total math** — `913416b4` "Athletics Team Total UNDER 4.5":
   AI graded "Total 9 > 4.5" (both teams' runs); the Athletics scored 4 → WIN. This is a second
   in-the-wild instance of the exact confusion that produced the already-corrected false WIN
   `b6065d701c` (excluded from this export).

There is also a cross-wired-evidence pair: `ef2da05e` (Cubs ML, Apr 7) was graded with a
Cubs–Guardians score, while `3f37ccd7` (Cubs -135, Apr 13) was graded with the Apr 7 Cubs–Rays
9–2 final — each bet appears to carry the other era's evidence.

## Disagreement table (71 rows)

Flags: **LC** = low-confidence date anchor (no event_date AND batch-imported created_at /
created 00:00–07:59 ET / slate shifted ±1 day) — 47 of 71 rows, listed after the
24 high-confidence rows. **±1d** = graded off an adjacent day's slate. **batch** = created_at
shared by ≥3 export rows (twitter scrape batch — timestamp is scrape time, not post time).
**default-odds** = suggested_pu uses 0.909×units because stored odds are empty.

| id | sport | market | description | stored / pu | shadow | suggested_pu | flags | evidence |
|---|---|---|---|---|---|---|---|---|
| `9ab2ddf8` | MLB | game_total | DODGERS / DBACKS OVER 9 | loss / -3 | WIN | 2.73 | default-odds | Total 11 > 9 (over). Los Angeles Dodgers 6, Arizona Diamondbacks 5 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-06-02 |
| `f0402e60` | MLB | game_total | Athletics / Giants Under 9.5 | win / 3.64 | LOSS | -4 | — | Total 10 > 9.5 (under). San Francisco Giants 6, Athletics 4 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-16 |
| `5668fb16` | MLB | ML | LockedIn Los Angeles Dodgers -120 | loss / -1 | WIN | 0.83 | — | Los Angeles Dodgers 6, Arizona Diamondbacks 5 (ML). Los Angeles Dodgers 6, Arizona Diamond — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-06-02 |
| `6a6a7585` | MLB | ML | Dodgers ML | loss / -2 | WIN | 1.67 | — | Los Angeles Dodgers 9, Philadelphia Phillies 1 (ML). Philadelphia Phillies 1, Los Angeles  — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-31 |
| `6f371722` | MLB | ML | Mariners ML | loss / -5 | WIN | 4.55 | — | Seattle Mariners 7, Texas Rangers 3 (ML). Texas Rangers 3, Seattle Mariners 7 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-18 |
| `8e5a432d` | MLB | ML | Pittsburgh Pirates ML | win / 0.77 | LOSS | -1 | — | Pittsburgh Pirates 7, Tampa Bay Rays 8 (ML). Tampa Bay Rays 8, Pittsburgh Pirates 7 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-18 |
| `90a1dc1b` | MLB | ML | Red Sox ML | win / 3.64 | LOSS | -4 | — | Boston Red Sox 6, Atlanta Braves 7 (ML). Atlanta Braves 7, Boston Red Sox 6 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-26 |
| `fd1e117f` | MLB | ML | LockedIn Atlanta Braves -135 | win / 0.74 | LOSS | -1 | — | Atlanta Braves 4, Cincinnati Reds 6 (ML). Atlanta Braves 4, Cincinnati Reds 6 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-31 |
| `30f94776` | MLB | spread | New York Yankees -1.5 -105 | win / 0.95 | LOSS | -1 | — | New York Yankees 0 + (-1.5) vs Athletics 1 (missed). Athletics 1, New York Yankees 0 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-09 |
| `313a8f64` | MLB | spread | LockedIn Cincinnati Reds -1.5 | win / 0.91 | LOSS | -1 | — | Cincinnati Reds 2 + (-1.5) vs Kansas City Royals 9 (missed). Kansas City Royals 9, Cincinn — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-06-01 |
| `415eee8d` | MLB | spread | LockedIn Los Angeles Dodgers -1.5 | loss / -1 | WIN | 0.91 | — | Los Angeles Dodgers 9 + (-1.5) vs Philadelphia Phillies 1 (covered). Philadelphia Phillies — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-31 |
| `5eabd576` | MLB | spread | GNP Royals +1.5 | loss / -2 | WIN | 1.82 | — | Kansas City Royals 9 + (1.5) vs Cincinnati Reds 2 (covered). Kansas City Royals 9, Cincinn — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-06-01 |
| `a498c100` | MLB | spread | Angels +1.5 | loss / -1 | WIN | 0.87 | — | Los Angeles Angels 10 + (1.5) vs New York Yankees 11 (covered). Los Angeles Angels 10, New — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-13 |
| `e8aef1d0` | MLB | spread | LockedIn New York Yankees -1.5 | loss / -1 | WIN | 0.91 | — | New York Yankees 13 + (-1.5) vs Athletics 8 (covered). New York Yankees 13, Athletics 8 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-31 |
| `ff6350ec` | MLB | spread | LockedIn Tampa Bay Rays -1.5 | win / 0.91 | LOSS | -1 | — | Tampa Bay Rays 9 + (-1.5) vs Detroit Tigers 10 (missed). Detroit Tigers 10, Tampa Bay Rays — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-06-01 |
| `913416b4` | MLB | team_total | Athletics Team Total UNDER 4.5 | loss / -2 | WIN | 1.82 | default-odds | Athletics team total 4 vs 4.5 (under). St. Louis Cardinals 5, Athletics 4 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-14 |
| `6ed630f9` | NBA | game_total | Minnesota Timberwolves / San Antonio Spurs UNDER 218.5 | win / 3.64 | LOSS | -4 | — | Total 223 > 218.5 (under). Minnesota Timberwolves 97, San Antonio Spurs 126 — site.api.espn.com/apis/site/v2/sports/basketball/nba/scorebo |
| `c3c0726d` | NBA | game_total | New York Knicks Philadelphia 76ers O214 | win / 0.91 | LOSS | -1 | — | Total 202 < 214 (over). New York Knicks 108, Philadelphia 76ers 94 — site.api.espn.com/apis/site/v2/sports/basketball/nba/scorebo |
| `f694f90a` | NBA | ML | Timberwolves ML | loss / -3 | WIN | 2.73 | default-odds | Minnesota Timberwolves 110, Denver Nuggets 98 (ML). Denver Nuggets 98, Minnesota Timberwol — site.api.espn.com/apis/site/v2/sports/basketball/nba/scorebo |
| `0a965916` | NBA | nba_prop | Jayson Tatum O 30.5 Points | win / 3.07 | LOSS | -1 | — | Jayson Tatum had 25 points (line: over 30.5). — site.api.espn.com/apis/site/v2/sports/basketball/nba/scorebo |
| `07cec57a` | NBA | spread | Miami Heat +5.5 | loss / -1 | WIN | 0.91 | — | Miami Heat 126 + (5.5) vs Charlotte Hornets 127 (covered). Miami Heat 126, Charlotte Horne — site.api.espn.com/apis/site/v2/sports/basketball/nba/scorebo |
| `223d9043` | NBA | spread | 🏀 Here’s all the data you need to win money on the play-in  | win / 0.91 | LOSS | -1 | — | Orlando Magic 97 + (-1) vs Philadelphia 76ers 109 (missed). Orlando Magic 97, Philadelphia — site.api.espn.com/apis/site/v2/sports/basketball/nba/scorebo |
| `1dfe1ffa` | NHL | game_total | Dallas Stars Wild O5.5 | loss / -1 | WIN | 0.91 | — | Total 7 > 5.5 (over). Stars 2, Wild 5 — api-web.nhle.com/v1/score/2026-04-30 |
| `f3411adc` | NHL | ML | Ottawa Senators ML | win / 0.77 | LOSS | -1 | — | Senators 3, Devils 4 (ML). Senators 3, Devils 4 — api-web.nhle.com/v1/score/2026-04-12 |
| `04cec75f` | MLB | game_total | Los Angeles Dodgers Toronto Blue Jays Bluejays Over 8 | win / 0.91 | LOSS | -1 | LC batch | Total 5 < 8 (over). Los Angeles Dodgers 4, Toronto Blue Jays 1 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-07 |
| `26c39d5a` | MLB | game_total | Tigers vs Boston Red Sox O8.5 | win / 0.91 | LOSS | -1 | LC ±1d batch | Total 4 < 8.5 (over). Boston Red Sox 4, Detroit Tigers 0 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-06 |
| `f8554e78` | MLB | game_total | Brewers/Los Angeles Dodgers Under 9 | loss / -1 | WIN | 0.91 | LC | Total 6 < 9 (under). Los Angeles Dodgers 5, Milwaukee Brewers 1 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-24 |
| `017a7405` | MLB | ML | Orioles -150 | win / 0.67 | LOSS | -1 | LC batch | Baltimore Orioles 3, Arizona Diamondbacks 4 (ML). Arizona Diamondbacks 4, Baltimore Oriole — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-14 |
| `13aab780` | MLB | ML | Orioles +108 | win / 1.08 | LOSS | -1 | LC batch | Baltimore Orioles 5, Kansas City Royals 6 (ML). Baltimore Orioles 5, Kansas City Royals 6 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-21 |
| `1b645904` | MLB | ML | Atlanta Braves -150 | win / 0.67 | LOSS | -1 | LC batch | Atlanta Braves 2, Boston Red Sox 3 (ML). Boston Red Sox 3, Atlanta Braves 2 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-16 |
| `2097dde8` | MLB | ML | Chicago Cubs -148 | win / 0.91 | LOSS | -1 | LC batch | Chicago Cubs 7, Philadelphia Phillies 13 (ML). Chicago Cubs 7, Philadelphia Phillies 13 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-13 |
| `24d776b4` | MLB | ML | Atlanta Braves Atlanta Braves -105 | win / 0.91 | LOSS | -1 | LC batch | Atlanta Braves 0, Miami Marlins 12 (ML). Atlanta Braves 0, Miami Marlins 12 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-18 |
| `3d59bfc1` | MLB | ML | LockedIn New York Yankees -155 | loss / -1 | WIN | 0.65 | LC | New York Yankees 13, Athletics 8 (ML). New York Yankees 13, Athletics 8 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-31 |
| `3ef8b7ce` | MLB | ML | Miami Marlins -135 | loss / -1 | WIN | 0.74 | LC batch | Miami Marlins 4, Baltimore Orioles 3 (ML). Baltimore Orioles 3, Miami Marlins 4 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-07 |
| `3f37ccd7` | MLB | ML | Chicago Cubs -135 | win / 0.74 | LOSS | -1 | LC batch | Chicago Cubs 7, Philadelphia Phillies 13 (ML). Chicago Cubs 7, Philadelphia Phillies 13 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-13 |
| `440d5f0e` | MLB | ML | Atlanta Braves -119 | win / 0.91 | LOSS | -1 | LC batch | Atlanta Braves 4, Miami Marlins 10 (ML). Miami Marlins 10, Atlanta Braves 4 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-13 |
| `4e1c67ae` | MLB | ML | Los Angeles Dodgers -159 | loss / -1 | WIN | 0.91 | LC batch | Los Angeles Dodgers 3, San Francisco Giants 0 (ML). Los Angeles Dodgers 3, San Francisco G — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-23 |
| `516de9f5` | MLB | ML | Tampa Rays +115 | win / 0.91 | LOSS | -1 | LC batch | Tampa Bay Rays 0, Boston Red Sox 2 (ML). Tampa Bay Rays 0, Boston Red Sox 2 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-08 |
| `56446dae` | MLB | ML | St. Louis Cardinals -115 | win / 0.91 | LOSS | -1 | LC batch | St. Louis Cardinals 0, Kansas City Royals 2 (ML). Kansas City Royals 2, St. Louis Cardinal — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-17 |
| `587fe4cd` | MLB | ML | Chicago Cubs -140 | win / 0.71 | LOSS | -1 | LC batch | Chicago Cubs 0, Texas Rangers 6 (ML). Chicago Cubs 0, Texas Rangers 6 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-09 |
| `60d9a04c` | MLB | ML | Chicago Cubs -110 | win / 0.91 | LOSS | -1 | LC batch | Chicago Cubs 3, Chicago White Sox 8 (ML). Chicago Cubs 3, Chicago White Sox 8 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-16 |
| `796f91fc` | MLB | ML | Guardians -120 | win / 0.83 | LOSS | -1 | LC batch | Cleveland Guardians 1, Minnesota Twins 2 (ML). Minnesota Twins 2, Cleveland Guardians 1 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-09 |
| `8b2a475d` | MLB | ML | LockedIn Los Angeles Dodgers -125 | loss / -1 | WIN | 0.8 | LC | Los Angeles Dodgers 9, Philadelphia Phillies 1 (ML). Philadelphia Phillies 1, Los Angeles  — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-31 |
| `978d283f` | MLB | ML | New York Yankees -125 | win / 0.8 | LOSS | -1 | LC batch | New York Yankees 3, New York Mets 6 (ML). New York Yankees 3, New York Mets 6 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-16 |
| `9c46740c` | MLB | ML | Atlanta Braves -139 | win / 0.72 | LOSS | -1 | LC batch | Atlanta Braves 5, Philadelphia Phillies 8 (ML). Philadelphia Phillies 8, Atlanta Braves 5 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-25 |
| `dd6fc5ee` | MLB | ML | Atlanta Braves -143 | loss / -1 | WIN | 0.91 | LC batch | Atlanta Braves 11, Cleveland Guardians 5 (ML). Cleveland Guardians 5, Atlanta Braves 11 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-10 |
| `e09e8ac0` | MLB | ML | Arizona Diamondbacks -140 | win / 0.71 | LOSS | -1 | LC batch | Arizona Diamondbacks 2, Colorado Rockies 4 (ML). Arizona Diamondbacks 2, Colorado Rockies  — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-16 |
| `e6389714` | MLB | ML | New York Yankees -142 | win / 0.91 | LOSS | -1 | LC batch | New York Yankees 0, Milwaukee Brewers 6 (ML). New York Yankees 0, Milwaukee Brewers 6 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-08 |
| `ef2da05e` | MLB | ML | Chicago Cubs ML | loss / -1 | WIN | 1.1 | LC batch | Chicago Cubs 9, Tampa Bay Rays 2 (ML). Chicago Cubs 9, Tampa Bay Rays 2 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-07 |
| `f2841a58` | MLB | ML | Toronto Blue Jays -133 | win / 0.75 | LOSS | -1 | LC batch | Toronto Blue Jays 1, Minnesota Twins 7 (ML). Toronto Blue Jays 1, Minnesota Twins 7 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-30 |
| `f2949896` | MLB | ML | Blue Jays ML | loss / -10 | WIN | 9.09 | LC | Toronto Blue Jays 5, Tampa Bay Rays 3 (ML). Tampa Bay Rays 3, Toronto Blue Jays 5 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-13 |
| `f32e98d8` | MLB | ML | Los Angeles Dodgers -120 | loss / -1 | WIN | 0.91 | LC batch | Los Angeles Dodgers 11, Milwaukee Brewers 3 (ML). Los Angeles Dodgers 11, Milwaukee Brewer — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-23 |
| `ff474722` | MLB | ML | LockedIn Houston Astros -110 | win / 0.91 | LOSS | -1 | LC | Houston Astros 0, Milwaukee Brewers 2 (ML). Milwaukee Brewers 2, Houston Astros 0 — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-31 |
| `7cee7844` | MLB | spread | San Diego Padres +1.5 | win / 1.33 | LOSS | -2 | LC | San Diego Padres 0 + (1.5) vs Los Angeles Angels 8 (missed). San Diego Padres 0, Los Angel — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-17 |
| `8082960d` | MLB | spread | Brewers -1.5 | win / 0.91 | LOSS | -1 | LC batch | Milwaukee Brewers 3 + (-1.5) vs Washington Nationals 7 (missed). Washington Nationals 7, M — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-10 |
| `85169896` | MLB | spread | Los Angeles Dodgers -1.5 | win / 0.91 | LOSS | -1 | LC batch | Los Angeles Dodgers 8 + (-1.5) vs Texas Rangers 7 (missed). Texas Rangers 7, Los Angeles D — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-10 |
| `993fb7fe` | MLB | spread | Houston Astros -1.5 | win / 0.87 | LOSS | -1 | LC batch | Houston Astros 1 + (-1.5) vs Colorado Rockies 5 (missed). Houston Astros 1, Colorado Rocki — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-07 |
| `e7da7c4d` | MLB | spread | Los Angeles Dodgers -1.5 | loss / -1 | WIN | 0.91 | LC batch | Los Angeles Dodgers 4 + (-1.5) vs Toronto Blue Jays 1 (covered). Los Angeles Dodgers 4, To — statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-04-07 |
| `6d0edfbe` | NBA | game_total | Los Angeles Lakers Golden State Warriors O225.5 | win / 0.91 | LOSS | -1 | LC batch | Total 222 < 225.5 (over). Los Angeles Lakers 119, Golden State Warriors 103 — site.api.espn.com/apis/site/v2/sports/basketball/nba/scorebo |
| `8a06e80c` | NBA | game_total | Los Angeles Lakers Oklahoma City Thunder O223.5 | win / 0.91 | LOSS | -1 | LC batch | Total 210 < 223.5 (over). Oklahoma City Thunder 123, Los Angeles Lakers 87 — site.api.espn.com/apis/site/v2/sports/basketball/nba/scorebo |
| `ac1e6589` | NBA | game_total | Phoenix Suns Houston Rockets O220.5 | loss / -1 | WIN | 0.91 | LC batch | Total 224 > 220.5 (over). Houston Rockets 119, Phoenix Suns 105 — site.api.espn.com/apis/site/v2/sports/basketball/nba/scorebo |
| `24b4dcaa` | NBA | spread | Houston Rockets -17 | win / 0.91 | LOSS | -1 | LC ±1d batch | Houston Rockets 117 + (-17) vs Golden State Warriors 116 (missed). Houston Rockets 117, Go — site.api.espn.com/apis/site/v2/sports/basketball/nba/scorebo |
| `3b58bb35` | NBA | spread | Oklahoma City Thunder Oklahoma City Thunder +12.5 | win / 0.91 | LOSS | -1 | LC batch | Oklahoma City Thunder 107 + (12.5) vs Denver Nuggets 127 (missed). Oklahoma City Thunder 1 — site.api.espn.com/apis/site/v2/sports/basketball/nba/scorebo |
| `65a4ddb3` | NBA | spread | Charlotte Hornets -5.5 | win / 0.91 | LOSS | -1 | LC batch | Charlotte Hornets 100 + (-5.5) vs Detroit Pistons 118 (missed). Detroit Pistons 118, Charl — site.api.espn.com/apis/site/v2/sports/basketball/nba/scorebo |
| `6b665dd5` | NBA | spread | 76ers -2 | win / 0.91 | LOSS | -1 | LC batch | Philadelphia 76ers 102 + (-2) vs San Antonio Spurs 115 (missed). Philadelphia 76ers 102, S — site.api.espn.com/apis/site/v2/sports/basketball/nba/scorebo |
| `75b0e8f9` | NBA | spread | Cleveland Cavaliers -3 | win / 0.91 | LOSS | -1 | LC batch | Cleveland Cavaliers 104 + (-3) vs Toronto Raptors 126 (missed). Cleveland Cavaliers 104, T — site.api.espn.com/apis/site/v2/sports/basketball/nba/scorebo |
| `a0787a09` | NBA | spread | Golden State Warriors -4.5 | win / 0.91 | LOSS | -1 | LC batch | Golden State Warriors 103 + (-4.5) vs Los Angeles Lakers 119 (missed). Los Angeles Lakers  — site.api.espn.com/apis/site/v2/sports/basketball/nba/scorebo |
| `d1bb4b57` | NBA | spread | Chicago Bulls -6.5 | loss / -1 | WIN | 0.91 | LC batch | Chicago Bulls 119 + (-6.5) vs Washington Wizards 108 (covered). Chicago Bulls 119, Washing — site.api.espn.com/apis/site/v2/sports/basketball/nba/scorebo |
| `d3c24164` | NBA | spread | Houston Rockets -10.5 | win / 0.91 | LOSS | -1 | LC batch | Houston Rockets 132 + (-10.5) vs Minnesota Timberwolves 136 (missed). Minnesota Timberwolv — site.api.espn.com/apis/site/v2/sports/basketball/nba/scorebo |
| `1155e21f` | NHL | game_total | Penguins Caps O6.5 | win / 0.91 | LOSS | -1 | LC ±1d batch | Total 3 < 6.5 (over). Penguins 0, Capitals 3 — api-web.nhle.com/v1/score/2026-04-12 |
| `3a2b1755` | NHL | spread | Colorado Avalanche +1.5 (-135) 3u | loss / -1 | WIN | 0.74 | LC ±1d | Avalanche 1 + (1.5) vs Golden Knights 2 (covered). Avalanche 1, Golden Knights 2 — api-web.nhle.com/v1/score/2026-05-26 |

## Unresolved (93)

| reason | count |
|---|---|
| ambiguous_date | 29 |
| multi_market | 20 |
| unparseable | 19 |
| player_prop | 7 |
| segment_market | 7 |
| no_side_named | 4 |
| no_game_found | 3 |
| player_not_found_in_games_on_date | 2 |
| sgp_description | 1 |
| no_team_found | 1 |

Notes: `ambiguous_date` = the named team(s) played adjacent days with conflicting outcomes (or a
same-day doubleheader split) and no event_date exists to pick the game — includes `19e26415`
(Orioles -120) whose anchor-day game was POSTPONED. `multi_market` = several picks in one stored
row ("and"-compounds, multi-line capper cards) — grading any one leg would be meaningless.
`player_prop`/`unparseable`/`no_side_named`/`segment_market` = markets the deterministic layer
cannot settle from a final score (NRFI, F5/1H segments, bare matchups naming no side). The two
`player_not_found` rows are DNP candidates whose VOID was deliberately suppressed (no event_date
⇒ no date certainty ⇒ no provable absence).

## Graded-but-unpriced class

**15** of the 491 rows have `profit_units` NULL (settled but never priced). Report-only;
they need a price-or-void decision alongside any correction pass (backlog item added).

## Run + method

- Runtime **121s**, **327** network calls (+471 cache hits, 0 fetch errors), throttled ≤3 req/s:
  statsapi.mlb.com 174, site.api.espn.com 63, api-web.nhle.com 90.
- **Import vs reimplement (per the side-effect audit):**
  - **MLB** — imported `services/sportsdata/mlb.js` (player props via `gradeMlbPlayerProp`) and
    `services/espn.js` `gradeFromScore` for team markets; the statsapi schedule fetch/match is a
    thin reimplementation against the same endpoint (adds doubleheader/postponed handling).
  - **NBA** — imported `services/sportsdata/nba.js` (props) + `services/espn.js`
    (scoreboard fetch, `teamMatches`, `parseBetDescription`, `gradeFromScore`).
  - **NHL** — imported `services/sportsdata/nhl.js` (props) + `espn.gradeFromScore`; api-web
    slate fetch/match reimplemented against the adapter's endpoint.
  - **Router `services/sportsdata/index.js` NOT imported** — its shadow paths emit
    pipeline_events at call time via a lazy `require('../bets')` that loads/migrates a DB; the
    prop-vs-team + slate-date routing was reimplemented inline.
- **Date anchor:** event_date when present (2 rows), else created_at (TEXT UTC) → **ET calendar
  day** via `etParts`; no matching game on the anchor → ±1 day; conflicting candidate outcomes →
  UNRESOLVED(ambiguous_date). Matchup bets (two named teams) only match games containing BOTH.
- **Deliberate divergences from the prod layer** (all conservative): DNP/absence VOIDs suppressed;
  prop stats accepted only on exact stat-map key match (the adapters' substring fallback can
  mis-map "3PTs"→points); SGP/segment/multi-pick descriptions refused; postponed statsapi
  "finals" (no scores) excluded — undefined scores would satisfy the ML tie check and mint a
  false PUSH. Classifier extends the planned enum with nba_prop/nhl_prop (the export contains
  non-MLB props) and multi_market.

## Suggested next step (operator-gated)

Triage the 24 high-confidence disagreements first (1.79u net); treat the 47 LC rows as
leads needing a human date check (batch-scraped tweets can reference games outside the ±1-day
window). No writes until signed off.
