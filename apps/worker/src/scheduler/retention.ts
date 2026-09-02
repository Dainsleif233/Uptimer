import type { Env } from '../env';

import { readSettings } from '../settings';
import { acquireLease } from './lock';

const LOCK_NAME = 'retention:check_results';
const LOCK_LEASE_SECONDS = 10 * 60;

// Keep delete batches bounded to avoid long-running SQLite statements.
const DELETE_BATCH_SIZE = 5_000;
const MAX_DELETED_ROWS = 200_000;
// Safety bound for the monitor-id walk below (one indexed seek per step).
const MAX_MONITOR_SCAN_STEPS = 10_000;

// Walk the distinct `monitor_id` values present in `check_results` with keyset
// seeks. `idx_check_results_monitor_time` starts with `monitor_id`, so each step
// is a single indexed lookup instead of a scan, and monitors whose rows were
// orphaned by an incomplete cascade delete are still visited.
const NEXT_MONITOR_ID_SQL = `
  SELECT monitor_id
  FROM check_results
  WHERE monitor_id > ?1
  ORDER BY monitor_id
  LIMIT 1
`;

// Deleting per monitor keeps the subquery on the leading index column, so D1
// only reads the rows that are actually removed. A `checked_at`-only predicate
// has no usable index and would scan the whole table on every batch.
// `id` is the rowid alias for `check_results`.
const DELETE_EXPIRED_FOR_MONITOR_SQL = `
  DELETE FROM check_results
  WHERE id IN (
    SELECT id
    FROM check_results
    WHERE monitor_id = ?1
      AND checked_at < ?2
    LIMIT ?3
  )
`;

export async function runRetention(env: Env, controller: ScheduledController): Promise<void> {
  const now = Math.floor((controller.scheduledTime ?? Date.now()) / 1000);

  const acquired = await acquireLease(env.DB, LOCK_NAME, now, LOCK_LEASE_SECONDS);
  if (!acquired) return;

  const settings = await readSettings(env.DB);
  const retentionDays = settings.retention_check_results_days;

  const cutoff = now - retentionDays * 86400;
  if (!Number.isFinite(cutoff) || cutoff <= 0) return;

  const nextMonitorIdStatement = env.DB.prepare(NEXT_MONITOR_ID_SQL);
  const deleteStatement = env.DB.prepare(DELETE_EXPIRED_FOR_MONITOR_SQL);

  let totalDeleted = 0;
  let monitorCount = 0;
  // Monitor ids are positive autoincrement integers, so 0 is a safe walk start.
  let monitorId = 0;

  for (let step = 0; step < MAX_MONITOR_SCAN_STEPS; step += 1) {
    const row = await nextMonitorIdStatement.bind(monitorId).first<{ monitor_id: number }>();
    const nextMonitorId = row?.monitor_id;
    if (typeof nextMonitorId !== 'number' || !Number.isFinite(nextMonitorId)) {
      break;
    }
    monitorId = nextMonitorId;
    monitorCount += 1;

    while (totalDeleted < MAX_DELETED_ROWS) {
      const batchSize = Math.min(DELETE_BATCH_SIZE, MAX_DELETED_ROWS - totalDeleted);
      const result = await deleteStatement.bind(monitorId, cutoff, batchSize).run();

      const deleted = result.meta.changes ?? 0;
      totalDeleted += deleted;

      if (deleted < batchSize) break;
    }

    if (totalDeleted >= MAX_DELETED_ROWS) break;
  }

  console.log(
    `retention: deleted=${totalDeleted} monitors=${monitorCount} cutoff=${cutoff} days=${retentionDays}`,
  );
}
