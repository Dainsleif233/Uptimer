import { describe, expect, it } from 'vitest';

import {
  bucketStartFor,
  readCheckRollupBucketSeconds,
  toCheckRollupBindings,
} from '../src/scheduler/check-rollups';
import type { CompletedDueMonitor } from '../src/scheduler/scheduled';

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
});
