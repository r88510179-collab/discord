// ═══════════════════════════════════════════════════════════
// Resolver stat mapper — free-text → resolver stat key.
//
// Contract:
//   - Input is whatever text the slip parser produced for a stat.
//   - Output is a resolver key (e.g. "home_runs") or null.
//   - Bare "strikeouts" maps to batter (strikeouts_batter). If the
//     bet context is pitching, callers MUST rewrite the freeText to
//     something like "pitching strikeouts" / "strikeouts pitched"
//     BEFORE calling this mapper. See gradeSingleBet for the
//     description-based rewrite.
// ═══════════════════════════════════════════════════════════

const STAT_MAP = {
  'hit': 'hits', 'hits': 'hits',
  'run': 'runs', 'runs': 'runs',
  'rbi': 'rbis', 'rbis': 'rbis',
  'home run': 'home_runs', 'home runs': 'home_runs', 'hr': 'home_runs', 'hrs': 'home_runs',
  'total base': 'total_bases', 'total bases': 'total_bases', 'tb': 'total_bases',
  'walk': 'walks', 'walks': 'walks', 'bb': 'walks', 'base on balls': 'walks',
  'strikeout': 'strikeouts_batter', 'strikeouts': 'strikeouts_batter', 'k': 'strikeouts_batter', 'ks': 'strikeouts_batter',
  'stolen base': 'stolen_bases', 'stolen bases': 'stolen_bases', 'sb': 'stolen_bases',
  'pitching strikeout': 'strikeouts_pitcher', 'pitching strikeouts': 'strikeouts_pitcher',
  'strikeouts pitched': 'strikeouts_pitcher', 'pitching k': 'strikeouts_pitcher', 'pitching ks': 'strikeouts_pitcher',
  'hits allowed': 'hits_allowed',
  'runs allowed': 'runs_allowed',
  'earned run': 'earned_runs', 'earned runs': 'earned_runs', 'er': 'earned_runs',
  'ip': 'innings_pitched', 'innings pitched': 'innings_pitched', 'inning': 'innings_pitched', 'innings': 'innings_pitched',
  'pitching out': 'outs_recorded', 'pitching outs': 'outs_recorded', 'outs recorded': 'outs_recorded',
  'h+r+rbi': 'hits+runs+rbis', 'hits+runs+rbis': 'hits+runs+rbis',
  'hits + runs + rbis': 'hits+runs+rbis', 'hits + runs + rbi': 'hits+runs+rbis',
  'hits runs rbis': 'hits+runs+rbis', 'hitter fs': 'hits+runs+rbis', 'hitter fantasy score': 'hits+runs+rbis',
};

function mapToResolverStat(freeText) {
  const s = (freeText || '').toLowerCase()
    .replace(/^(to |player to )?(record|score|have|get|hit|collect) /, '')
    .replace(/^(over |under )/, '')
    .replace(/\+$/, '')
    .trim();

  return STAT_MAP[s] || null;
}

module.exports = { mapToResolverStat, STAT_MAP };
