// ═══════════════════════════════════════════════════════════
// Per-capper unit calibration — median wager analysis
// Enables ROI comparison across cappers who bet different $
// ═══════════════════════════════════════════════════════════

const { db } = require('./database');

const MIN_SAMPLE_SIZE = 10;
const MAX_CV = 0.5; // Coefficient of variation threshold

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const weight = idx - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function stddev(arr, mean) {
  const sqDiffs = arr.map(v => (v - mean) ** 2);
  return Math.sqrt(sqDiffs.reduce((a, b) => a + b, 0) / arr.length);
}

function calibrateCapper(capperId) {
  const wagers = db.prepare(
    `SELECT wager FROM bets WHERE capper_id = ? AND wager IS NOT NULL AND wager > 0`
  ).all(capperId).map(r => r.wager);

  const sample_size = wagers.length;

  if (sample_size < MIN_SAMPLE_SIZE) {
    db.prepare(`
      UPDATE cappers SET
        calibration_status = 'insufficient_data',
        calibration_sample_size = ?,
        calibrated_at = datetime('now')
      WHERE id = ?
    `).run(sample_size, capperId);
    return { capperId, status: 'insufficient_data', sample_size };
  }

  const mean = wagers.reduce((a, b) => a + b, 0) / sample_size;
  const sd = stddev(wagers, mean);
  const cv = sd / mean;

  if (cv > MAX_CV) {
    db.prepare(`
      UPDATE cappers SET
        calibration_status = 'volatile',
        calibration_sample_size = ?,
        calibration_stddev = ?,
        calibration_cv = ?,
        calibrated_at = datetime('now')
      WHERE id = ?
    `).run(sample_size, sd, cv, capperId);
    return { capperId, status: 'volatile', sample_size, cv };
  }

  const med = median(wagers);
  const p25 = percentile(wagers, 0.25);
  const p75 = percentile(wagers, 0.75);

  db.prepare(`
    UPDATE cappers SET
      calibrated_unit_size = ?,
      calibration_median = ?,
      calibration_p25 = ?,
      calibration_p75 = ?,
      calibration_stddev = ?,
      calibration_cv = ?,
      calibration_sample_size = ?,
      calibration_status = 'calibrated',
      calibrated_at = datetime('now')
    WHERE id = ?
  `).run(med, med, p25, p75, sd, cv, sample_size, capperId);

  return { capperId, status: 'calibrated', sample_size, unitSize: med, cv };
}

function calibrateAllCappers() {
  const cappers = db.prepare('SELECT id, display_name FROM cappers').all();
  const results = { calibrated: 0, volatile: 0, insufficient: 0, details: [] };
  for (const capper of cappers) {
    const result = calibrateCapper(capper.id);
    result.name = capper.display_name;
    results.details.push(result);
    if (result.status === 'calibrated') results.calibrated++;
    else if (result.status === 'volatile') results.volatile++;
    else results.insufficient++;
  }
  console.log(`[Calibration] Calibrated ${results.calibrated}, volatile ${results.volatile}, insufficient ${results.insufficient}`);
  return results;
}

module.exports = { calibrateCapper, calibrateAllCappers };
