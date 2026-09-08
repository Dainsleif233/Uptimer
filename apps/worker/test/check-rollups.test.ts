import { describe, expect, it } from 'vitest';

import {
  CHECK_ROLLUP_BINDINGS_PER_ROW,
  bucketStartFor,
  getUpsertCheckRollupStatement,
  readCheckRollupBucketSeconds,
  toCheckRollupBindings,
} from '../src/scheduler/check-rollups';
import type { CompletedDueMonitor } from '../src/scheduler/scheduled';

/** Minimal D1 mock: only prepare() is exercised by getUpsertCheckRollupStatement. */
function makeFakeDb() {
  const prepared: { sql: string }[] = [];
  const db = {
    prepare(sql: string) {
      const stmt = { sql, bind: () => stmt, run: () => Promise.resolve({}) };
      prepared.push(stmt);
      return stmt;
    },
  } as unknown as D1Database;
  return { db, prepared };
}

function makeCompleted(id: number, checkedAt: number, status: string, latencyMs: number | null) {
  return {
    row: { id } as never,
    checkedAt,
    outcome: { status, latencyMs, httpStatus: 200, error: null, attempts: 1 } as never,
  } as CompletedDueMonitor;
}

describe('scheduler/check-rollups', () => {
  it('aligns check timestamps to the bucket boundary', () => {
    expect(bucketStartFor(90, 60)).toBe(60);
    expect(bucketStartFor(120, 60)).toBe(120);
    expect(bucketStartFor(299, 300)).toBe(0);
    expect(bucketStartFor(300, 300)).toBe(300);
    expect(bucketStartFor(1_760_000_350, 300)).toBe(1_760_000_100);
  });

  it('clamps the configured bucket width into a sane range', () => {
    const env = (value: string | undefined) => ({ UPTIMER_CHECK_ROLLUP_BUCKET_SECONDS: value });
    expect(readCheckRollupBucketSeconds(env(undefined))).toBe(300);
    expect(readCheckRollupBucketSeconds(env('120'))).toBe(120);
    expect(readCheckRollupBucketSeconds(env('1'))).toBe(60); // below floor
    expect(readCheckRollupBucketSeconds(env('100000'))).toBe(86400); // above ceiling
    expect(readCheckRollupBucketSeconds(env('not-a-number'))).toBe(300);
  });

  it('flattens a batch into one rollup row per check with correct counts', () => {
    const bindings = toCheckRollupBindings(
      [
        makeCompleted(1, 70, 'up', 42),
        makeCompleted(2, 130, 'down', null),
        makeCompleted(3, 200, 'unknown', 7),
        makeCompleted(1, 250, 'up', 50),
      ],
      300,
    );

    expect(bindings).toEqual([
      1, 0, 300, 1, 1, 0, 0, 42, 42, 42, 70, 'up', 42,
      2, 0, 300, 1, 0, 1, 0, 0, null, null, 130, 'down', null,
      3, 0, 300, 1, 0, 0, 1, 7, 7, 7, 200, 'unknown', 7,
      1, 0, 300, 1, 1, 0, 0, 50, 50, 50, 250, 'up', 50,
    ]);
  });

  it('groups checks into distinct buckets across time', () => {
    const bindings = toCheckRollupBindings(
      [makeCompleted(1, 70, 'up', 10), makeCompleted(1, 370, 'up', 20)],
      300,
    );
    // First check -> bucket 0, second -> bucket 300.
    expect(bindings[1]).toBe(0);
    expect(bindings[14]).toBe(300);
  });

  describe('getUpsertCheckRollupStatement', () => {
    it('builds a null-safe UPSERT with numbered placeholders matching rowCount * 13', () => {
      const { db, prepared } = makeFakeDb();
      const rowCount = 2;
      const stmt = getUpsertCheckRollupStatement(db, rowCount);
      expect(stmt).toBeDefined();
      expect(prepared).toHaveLength(1);
      const sql = prepared[0]?.sql ?? '';
      expect(sql).toContain('ON CONFLICT(monitor_id, bucket_start)');
      // Null-safe min/max: a null-latency batch must not clobber existing stats.
      expect(sql).toContain('latency_min = CASE');
      expect(sql).toContain('latency_max = CASE');
      expect(sql).toContain('WHEN excluded.latency_min IS NULL THEN latency_min');
      expect(sql).toContain('WHEN excluded.latency_max IS NULL THEN latency_max');
      const placeholders = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
      expect(placeholders).toEqual(
        Array.from({ length: rowCount * CHECK_ROLLUP_BINDINGS_PER_ROW }, (_, i) => i + 1),
      );
    });

    it('caches the prepared statement per (db, rowCount)', () => {
      const { db: dbA } = makeFakeDb();
      const { db: dbB } = makeFakeDb();
      const a1 = getUpsertCheckRollupStatement(dbA, 3);
      const a2 = getUpsertCheckRollupStatement(dbA, 3);
      const aOther = getUpsertCheckRollupStatement(dbA, 4);
      const b1 = getUpsertCheckRollupStatement(dbB, 3);
      expect(a2).toBe(a1); // same db + rowCount -> cached statement
      expect(aOther).not.toBe(a1); // different rowCount -> fresh statement
      expect(b1).not.toBe(a1); // different db -> separate cache
    });
  });
});
