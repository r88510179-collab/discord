-- GET /api/admin/drops (routes/admin.js) filters pipeline_events on
-- event_type='DROP' AND created_at >= ?. No existing index leads with
-- event_type (idx_pipeline_events_stage_type leads with stage; the partial
-- drop_reason index needs a drop_reason predicate), so both the counts and
-- rows queries were full table scans + temp B-tree sorts — synchronous
-- (better-sqlite3) on the bot's event loop, on a table with no retention
-- pruning. This index lets both queries seek on event_type + created_at.
CREATE INDEX IF NOT EXISTS idx_pipeline_events_event_type_created
  ON pipeline_events(event_type, created_at);
