-- Drop the redundant explicit index on `check_rollups`.
--
-- 0016 created `idx_check_rollups_monitor_time` on (monitor_id, bucket_start),
-- but the table's PRIMARY KEY is already exactly (monitor_id, bucket_start), so
-- SQLite maintains a unique index for the PK and the explicit index is a
-- duplicate: every UPSERT pays double index maintenance and the table doubles
-- its index storage. `check_rollups` is the highest-volume table once wired in,
-- so dropping the duplicate directly serves the goal of this migration series
-- (minimizing D1 rows_written).
--
-- Safe for both states: if 0016 was applied, this drops the redundant index;
-- on a fresh apply it is a no-op.

DROP INDEX IF NOT EXISTS idx_check_rollups_monitor_time;
