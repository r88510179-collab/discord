-- Per-capper unit calibration based on median wager analysis
ALTER TABLE cappers ADD COLUMN calibrated_unit_size REAL;
ALTER TABLE cappers ADD COLUMN calibration_median REAL;
ALTER TABLE cappers ADD COLUMN calibration_p25 REAL;
ALTER TABLE cappers ADD COLUMN calibration_p75 REAL;
ALTER TABLE cappers ADD COLUMN calibration_stddev REAL;
ALTER TABLE cappers ADD COLUMN calibration_cv REAL;
ALTER TABLE cappers ADD COLUMN calibration_sample_size INTEGER DEFAULT 0;
ALTER TABLE cappers ADD COLUMN calibration_status TEXT DEFAULT 'insufficient_data';
ALTER TABLE cappers ADD COLUMN calibrated_at TEXT;
