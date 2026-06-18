// services/sportsdata/teamTotal.js
// Single-team "Team Total" detection, shared by the structured team graders.
//
// A "Team Total" bet is about ONE team's score, not the game total. The team
// graders (gradeMlbBet/gradeNbaBet/gradeNhlBet) only compute the GAME total
// (away + home), so grading a team total there yields a WRONG terminal result.
// They refuse it (resolved:false) and the caller falls through to ESPN+AI, which
// understands team totals. Defined once so the three adapters can't drift.
//
// Matches the realistic phrasings/renderings: "team total", "team-total",
// "teamtotal", "team tot(s)", "team totals", reversed "total team", and the
// abbreviations "TT" / "ITT". Deliberately does NOT match game totals
// ("over 220.5", "both teams total"), the "Total Bases" MLB stat, spreads, ML,
// or names that merely contain the letters "tt" (matt, pitt, ott) — those must
// still reach the team grader.
const TEAM_TOTAL_RX = /\bteam[\s-]*tot(?:al)?s?\b|\btotal\s+team\b|\bi?tt\b/i;

function isTeamTotalBet(description) {
  return TEAM_TOTAL_RX.test(String(description || ''));
}

module.exports = { isTeamTotalBet, TEAM_TOTAL_RX };
