-- D1 read-cost indexes for hot public/scheduled predicates.
--
-- Rationale (D1 bills rows_read as rows SCANNED, not returned):
--
-- 1. `incidents` had no secondary index at all. `/api/v1/public/incidents`,
--    the status/homepage fast guards and the incident CSV export all filter on
--    `status` and order/range-filter on `resolved_at` / `started_at`, so each
--    call scanned the whole table.
-- 2. `maintenance_windows` had no secondary index. The per-minute scheduler runs
--    two range queries over it (`starts_at BETWEEN`, `ends_at BETWEEN`) plus the
--    active-window lookup, and the public routes range-filter it on every
--    request -- all full scans, 1440+ times a day.
--
-- Both tables are low-write (admin mutations only), so the extra index-write
-- cost is negligible compared to the reads they remove.
--
-- Deliberately NOT added: an index on `check_results(checked_at)`. It would add
-- one index write per inserted and per deleted row (the highest-volume table in
-- the schema) and is unnecessary now that retention deletes are scoped by
-- `monitor_id`, which uses `idx_check_results_monitor_time`.
--
-- NOTE: Keep this file append-only. Future schema changes must be new migrations.

CREATE INDEX IF NOT EXISTS idx_incidents_status_started
  ON incidents (status, started_at);

-- `(status, resolved_at)` also satisfies `ORDER BY resolved_at DESC` for the resolved
-- history previews, so the planner drops the temp b-tree sort (verified with
-- EXPLAIN QUERY PLAN).
CREATE INDEX IF NOT EXISTS idx_incidents_status_resolved
  ON incidents (status, resolved_at);

CREATE INDEX IF NOT EXISTS idx_maintenance_windows_starts_at
  ON maintenance_windows (starts_at);

CREATE INDEX IF NOT EXISTS idx_maintenance_windows_ends_at
  ON maintenance_windows (ends_at);
