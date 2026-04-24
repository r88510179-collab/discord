# Evidence Whitelist

Every `evidence_url` must come from a source on this list. Every `evidence_quote` must be copy-pasted verbatim from the cited URL. Do not use aggregators or search-result snippets as sole evidence.

## Tier 1 — Official league / sport sources

| Sport | Source | URL pattern | What it covers |
|---|---|---|---|
| NBA | ESPN | `espn.com/nba/game/_/gameId/{id}` | Box scores, recaps, final scores |
| NBA | NBA.com | `nba.com/game/{teams}-{game_id}/box-score` | Official box, PBP, game summary |
| NBA | NBA.com player | `nba.com/player/{id}/{name}` | Player-level stats and recent game lines |
| NBA | CBS Sports PBP | `cbssports.com/nba/gametracker/playbyplay/NBA_{YYYYMMDD}_{AWAY}@{HOME}/` | Play-by-play with timestamps — use for race-to-N, first-to-score, exact in-game timing |
| NBA | Basketball Reference | `basketball-reference.com/boxscores/{YYYYMMDD}0{HOME}.html` | Comprehensive box scores |
| MLB | ESPN | `espn.com/mlb/game/_/gameId/{id}` or `.../recap?gameId={id}` | Box, recap |
| MLB | MLB.com | `mlb.com/gameday/{id}` | Official gameday, box, PBP |
| MLB | Baseball Savant | `baseballsavant.mlb.com` | Pitch-level data, Statcast — use for HR / exit velocity / spray verification |
| NHL | NHL.com | `nhl.com/gamecenter/{teams}/{YYYY}/{MM}/{DD}/{game_id}` | Official game summary |
| NHL | ESPN | `espn.com/nhl/game/_/gameId/{id}` | Box, recap |
| NHL | NHL recap pages | `nhl.com/{team}/news/...` | Official team recaps with scoring timestamps |
| Soccer | ESPN FC | `espn.com/soccer/match/_/gameId/{id}` | Match stats |
| Soccer | Premier League / La Liga official | `premierleague.com` / `laliga.com` | Official stats |
| Tennis | ATP Tour | `atptour.com/en/scores/current/{tourney}/{id}/results` | Official match results, set scores |
| Tennis | WTA | `wtatennis.com` | Women's matches |
| Tennis | Tennis Abstract | `tennisabstract.com` | Match-level detail when ATP is down |
| UFC/MMA | UFC.com | `ufc.com/event/{slug}` | Official results |
| UFC/MMA | ESPN MMA | `espn.com/mma/fightcenter/_/id/{id}` | Fight recaps |
| Golf | PGA Tour | `pgatour.com/tournaments/{year}/{slug}` | Live leaderboards, cuts |
| Golf | ESPN Golf | `espn.com/golf/leaderboard` | Results |

## Tier 2 — Player-stat aggregators (acceptable with a same-day recap cite)

| Source | URL pattern | Notes |
|---|---|---|
| RotoWire | `rotowire.com/basketball/player/...` | Usually sources from ESPN/team. Good for player game logs. Cite as `espn_nba` if the snippet quotes ESPN. |
| FanDuel Research | `fanduel.com/research/...` | Aggregator but often the cleanest quick-look. |
| CBS Sports player page | `cbssports.com/{sport}/players/{id}/{name}/` | Recent-games tables |
| StatMuse | `statmuse.com/{sport}/player/{name}` | Player game logs |

## Tier 3 — Avoid as sole evidence

- Reddit / Twitter posts (unless they ARE the capper's post being graded)
- Wikipedia (snapshots, can be stale)
- Forum posts, blogs, gambling tipster sites
- Search engine snippets without clicking through to the source
- Odds aggregator sites (odds.com, OddsShark) as PRIMARY evidence — fine as supporting context

## Sport-specific extraction tips

### NBA PBP for race-to-N / first-basket
CBS Sports `playbyplay` URL gives timestamped plays with running score. To determine who reached N points first, walk through the 1st-quarter plays in order, tracking each team's running score. The first team whose score crosses `>= N` wins the race. Example in context: Portland reached 20 at 6:22 Q1 (Avdija 3PT takes them from 17 to 22); Sacramento reached 20 at 5:35 Q1 (Achiuwa FT). Blazers won the race-to-20 by 47 seconds.

### MLB box scores for HR props
ESPN recap pages list HR batters explicitly in the `HR` line. To verify "Player X HR" leg:
1. Find the target game(s)
2. Search the recap/box for the HR line (usually formatted `HR Vargas (2, 5th inning off Rogers), Basallo (3, 2nd inning off Kelly)`)
3. If the player's name is NOT in the HR line, they did not hit one (assuming they played)

### NHL 1st-period scoring
NHL.com recap pages include scoring summaries with timestamps. Count goals with `P1` / `1st` designation. Example: "Hischier gave the Devils a 1-0 lead when he cleaned up a rebound from the slot at 5:12 of the first period" → that's P1 goal #1.

### Tennis set/game handicap math
For "Player +N.5 sets" in a best-of-3: apply N.5 to the set score. If actual is 0-2 sets and handicap is +1.5 → adjusted 1.5 vs 2 → LOSS. If handicap is +2.5 → adjusted 2.5 vs 2 → WIN.

For "Player +N.5 games" in match: sum all games across all sets. Apply handicap to the game total.

## When a primary source is unreachable

If ESPN / NBA.com / etc. are down or the specific page returns 404:
1. Try a mirror in Tier 2
2. Try searching the player name + date on a Tier 1 alternative
3. If neither works, mark `unknown` with `grade_reason` noting the source was unreachable

Do NOT substitute a Tier 3 source. Do NOT guess. `unknown` is a valid outcome.
