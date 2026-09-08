-- Aggregate per-check results into fixed time buckets so the highest-volume
-- table no longer stores one row per check.
--
-- Why: every check currently INSERTs one `check_results` row (T/day) and later
-- ages out via retention DELETE (also ~T/day). With T ~= 600K that alone is
-- ~1.2M writes/day, and it is the single largest write contributor. D1 bills
-- rows_written, so batching many checks into one bucketed row is the only way
-- to bring that component down without lowering the check count or frequency.
--
-- Bucket width is fixed per deployment (CHECK_ROLLUP_BUCKET_SECONDS in the
-- worker). For a 60s monitor a 300s bucket holds ~5 checks per row, cutting the
-- `check_results`-equivalent writes by ~5x. Uptime %, latency charts and the
-- heartbeat sparkline can all be derived from these rollups (the heartbeat
-- sparkline is already served from the runtime snapshot), so once every reader
-- of `check_results` is migrated to `check_rollups` we can stop writing raw
-- `check_results` entirely and let retention prune only the small rollup table.
--
-- NOTE: Keep this file append-only. Future schema changes must be new migrations.

CREATE TABLE IF NOT EXISTS check_rollups (
  monitor_id INTEGER NOT NULL,
  bucket_start INTEGER NOT NULL,
  bucket_sec INTEGER NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  up INTEGER NOT NULL DEFAULT 0,
  down INTEGER NOT NULL DEFAULT 0,
  unknown INTEGER NOT NULL DEFAULT 0,
  latency_sum INTEGER NOT NULL DEFAULT 0,
  latency_min INTEGER,
  latency_max INTEGER,
  last_checked_at INTEGER,
  last_status TEXT,
  last_latency_ms INTEGER,
  PRIMARY KEY (monitor_id, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_check_rollups_monitor_time
  ON check_rollups (monitor_id, bucket_start);
