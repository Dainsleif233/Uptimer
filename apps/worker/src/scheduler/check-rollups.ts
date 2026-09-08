/**
 * Bucketed aggregation of per-check results into `check_rollups`.
 *
 * This is the write-side foundation for getting D1 writes under the free-tier
 * budget without lowering the check count or frequency. Today every check
 * INSERTs one `check_results` row (T/day) and later ages out via retention
 * DELETE (~T/day); that is the single largest write contributor and it cannot
 * be batched away because D1 bills rows_written, not statements.
 *
 * `check_rollups` collapses many checks into one row per (monitor, bucket),
 * so the `check_results`-equivalent write volume drops by the bucket/interval
 * ratio. The bucket width is fixed per deployment via
 * `CHECK_ROLLUP_BUCKET_SECONDS` (overridable with
 * `UPTIMER_CHECK_ROLLUP_BUCKET_SECONDS`).
 *
 * Wiring this into `persistCompletedMonitors` is intentionally deferred: every
 * reader of `check_results` (uptime history, latency charts, heartbeat
 * sparkline, daily rollup, analytics, exports) must first be migrated to read
 * from `check_rollups` (or the runtime snapshot) before we can stop writing raw
 * `check_results`. See D1-Throughput-Analysis.md §八 / §九 (write-side plan).
 */

import type { CompletedDueMonitor } from './scheduled';

/** Default bucket width in seconds. 300s = 5min → ~5 checks/row for 60s monitors. */
export const CHECK_ROLLUP_BUCKET_SECONDS = 300;
export const CHECK_ROLLUP_BINDINGS_PER_ROW = 13;

export function readCheckRollupBucketSeconds(env: {
  UPTIMER_CHECK_ROLLUP_BUCKET_SECONDS?: string;
}): number {
  const raw = env.UPTIMER_CHECK_ROLLUP_BUCKET_SECONDS;
  if (typeof raw !== 'string') return CHECK_ROLLUP_BUCKET_SECONDS;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return CHECK_ROLLUP_BUCKET_SECONDS;
  // Keep buckets sane: >= 60s (no finer than the fastest monitor) and <= 1 day.
  return Math.max(60, Math.min(86400, parsed));
}

/** Align a check timestamp to the start of its bucket. Pure. */
export function bucketStartFor(checkedAt: number, bucketSec: number): number {
  return Math.floor(checkedAt / bucketSec) * bucketSec;
}

type RollupCounts = { up: number; down: number; unknown: number };

function classifyRollupCounts(status: string): RollupCounts {
  if (status === 'up') return { up: 1, down: 0, unknown: 0 };
  if (status === 'down') return { up: 0, down: 1, unknown: 0 };
  return { up: 0, down: 0, unknown: 1 };
}

/**
 * Flatten a batch of completed monitors into `check_rollups` bindings, one row
 * per (monitor, bucket). Pure — no D1 access — so it is directly unit-testable.
 */
export function toCheckRollupBindings(
  completed: readonly CompletedDueMonitor[],
  bucketSec: number,
): unknown[] {
  const bindings: unknown[] = [];
  for (const monitor of completed) {
    const { row, checkedAt, outcome } = monitor;
    const bucketStart = bucketStartFor(checkedAt, bucketSec);
    const latency = typeof outcome.latencyMs === 'number' ? outcome.latencyMs : null;
    const counts = classifyRollupCounts(outcome.status);
    bindings.push(
      row.id,
      bucketStart,
      bucketSec,
      1,
      counts.up,
      counts.down,
      counts.unknown,
      latency ?? 0,
      latency,
      latency,
      checkedAt,
      outcome.status,
      latency,
    );
  }
  return bindings;
}

function buildNumberedTuplePlaceholders(rowCount: number, bindingsPerRow: number): string {
  const tuples: string[] = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const base = rowIndex * bindingsPerRow;
    const placeholders = Array.from(
      { length: bindingsPerRow },
      (_, bindingIndex) => `?${base + bindingIndex + 1}`,
    );
    tuples.push(`(${placeholders.join(', ')})`);
  }
  return tuples.join(', ');
}

const upsertByRowCountByDb = new Map<D1Database, Map<number, D1PreparedStatement>>();

/**
 * Cached, row-count-keyed UPSERT that accumulates a batch of checks into their
 * buckets. Mirrors `getInsertCheckResultStatement` / `getUpsertMonitorStateStatement`
 * in `scheduled.ts`. Null-safe latency min/max: a bucket with only
 * down/unknown checks (null latency) keeps its existing latency stats.
 */
export function getUpsertCheckRollupStatement(
  db: D1Database,
  rowCount: number,
): D1PreparedStatement {
  let byRowCount = upsertByRowCountByDb.get(db);
  if (!byRowCount) {
    byRowCount = new Map<number, D1PreparedStatement>();
    upsertByRowCountByDb.set(db, byRowCount);
  }
  const cached = byRowCount.get(rowCount);
  if (cached) return cached;

  const statement = db.prepare(`
    INSERT INTO check_rollups (
      monitor_id,
      bucket_start,
      bucket_sec,
      total,
      up,
      down,
      unknown,
      latency_sum,
      latency_min,
      latency_max,
      last_checked_at,
      last_status,
      last_latency_ms
    ) VALUES ${buildNumberedTuplePlaceholders(rowCount, CHECK_ROLLUP_BINDINGS_PER_ROW)}
    ON CONFLICT(monitor_id, bucket_start) DO UPDATE SET
      total = total + excluded.total,
      up = up + excluded.up,
      down = down + excluded.down,
      unknown = unknown + excluded.unknown,
      latency_sum = latency_sum + excluded.latency_sum,
      latency_min = CASE
        WHEN excluded.latency_min IS NULL THEN latency_min
        WHEN latency_min IS NULL THEN excluded.latency_min
        ELSE MIN(latency_min, excluded.latency_min)
      END,
      latency_max = CASE
        WHEN excluded.latency_max IS NULL THEN latency_max
        WHEN latency_max IS NULL THEN excluded.latency_max
        ELSE MAX(latency_max, excluded.latency_max)
      END,
      last_checked_at = excluded.last_checked_at,
      last_status = excluded.last_status,
      last_latency_ms = excluded.last_latency_ms
  `);
  byRowCount.set(rowCount, statement);
  return statement;
}
