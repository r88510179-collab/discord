'use strict';

// ═══════════════════════════════════════════════════════════
// Pipeline instrumentation gap detector — runs once at bot
// startup. Queries pipeline_events for the last 24h and warns
// if any stage that *should* be emitting drops has zero rows.
//
// Silent stages = either the pipeline truly succeeded every
// time on that path (rare) or the instrumentation is missing.
// In a debugging session, an uninstrumented stage on the path
// makes a trace diff meaningless, so this self-check catches
// gaps before they hide a real bug.
// ═══════════════════════════════════════════════════════════

// EXPECTED_STAGES — populated from grep of real recordDrop call
// sites in services/ + handlers/, NOT from architecture diagrams.
// Verified against the schema's STAGES enum and 7d prod data:
//   • 'DROPPED'           — every ingest-side recordDrop call
//                           (handlers/messageHandler.js,
//                            services/twitter-handler.js,
//                            services/ai.js)
//   • 'GRADING_AI'        — services/grading.js:390
//                           bets.recordDrop after post-AI guard
//   • 'GRADING_DROPPED'   — services/grading.js:1633 +
//                           services/bets.js:109 (default for
//                           bets.recordDrop wrapper)
//
// Console-log-only events (slip.fallback_to_gemma, bet.dedupe_hit,
// grade.skip_too_recent) are NOT in the table by design — do not
// add them here.
const EXPECTED_STAGES = ['DROPPED', 'GRADING_AI', 'GRADING_DROPPED'];

function checkPipelineInstrumentation(db, logger = console) {
  let counts = [];
  try {
    counts = db.prepare(`
      SELECT stage, COUNT(*) AS n
      FROM pipeline_events
      WHERE created_at > strftime('%s','now','-1 day')
        AND event_type = 'DROP'
        AND drop_reason IS NOT NULL
      GROUP BY stage
    `).all();
  } catch (err) {
    (logger.error || logger.warn || console.error).call(logger, {
      event: 'PIPELINE_INSTRUMENTATION_CHECK_FAILED',
      error: err.message,
    });
    return { silentStages: [], recordedStages: [], error: err.message };
  }

  const recordedStages = new Set(counts.map(r => r.stage));
  const silentStages = EXPECTED_STAGES.filter(s => !recordedStages.has(s));

  if (silentStages.length > 0) {
    (logger.warn || console.warn).call(logger, {
      event: 'PIPELINE_INSTRUMENTATION_GAP',
      silent_stages: silentStages,
      recorded_stages: [...recordedStages],
      note: 'These stages recorded zero drop events in 24h. Either they succeed every time (rare) or instrumentation is missing. Review their early-return paths.',
    });
  } else {
    (logger.info || console.log).call(logger, {
      event: 'PIPELINE_INSTRUMENTATION_OK',
      stages_checked: EXPECTED_STAGES.length,
      recorded_stages: [...recordedStages],
    });
  }

  return { silentStages, recordedStages: [...recordedStages] };
}

module.exports = { checkPipelineInstrumentation, EXPECTED_STAGES };
