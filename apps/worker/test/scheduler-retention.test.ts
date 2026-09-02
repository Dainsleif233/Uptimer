import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/scheduler/lock', () => ({
  acquireLease: vi.fn(),
}));
vi.mock('../src/settings', () => ({
  readSettings: vi.fn(),
}));

import type { Env } from '../src/env';
import { readSettings } from '../src/settings';
import { acquireLease } from '../src/scheduler/lock';
import { runRetention } from '../src/scheduler/retention';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

function createEnv(handlers: FakeD1QueryHandler[]): Env {
  return { DB: createFakeD1Database(handlers) } as unknown as Env;
}

describe('scheduler/retention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-18T00:00:00.000Z'));
    vi.mocked(acquireLease).mockResolvedValue(true);
    vi.mocked(readSettings).mockResolvedValue({
      site_title: 'Uptimer',
      site_description: '',
      site_locale: 'auto',
      site_timezone: 'UTC',
      retention_check_results_days: 7,
      state_failures_to_down_from_up: 2,
      state_successes_to_up_from_down: 2,
      admin_default_overview_range: '24h',
      admin_default_monitor_range: '24h',
      uptime_rating_level: 3,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function monitorWalkHandler(monitorIds: readonly number[]): FakeD1QueryHandler {
    return {
      match: 'where monitor_id > ?1',
      first: (args) => {
        const after = typeof args[0] === 'number' ? args[0] : 0;
        const next = monitorIds.find((id) => id > after);
        return next === undefined ? null : { monitor_id: next };
      },
    };
  }

  it('skips deletion when lease is not acquired', async () => {
    vi.mocked(acquireLease).mockResolvedValue(false);
    const runCalls: unknown[][] = [];
    const env = createEnv([
      monitorWalkHandler([1]),
      {
        match: 'delete from check_results',
        run: (args) => {
          runCalls.push(args);
          return { meta: { changes: 0 } };
        },
      },
    ]);

    await runRetention(env, { scheduledTime: Date.now() } as ScheduledController);

    expect(readSettings).not.toHaveBeenCalled();
    expect(runCalls).toHaveLength(0);
  });

  it('deletes per monitor in bounded batches until the batch comes back short', async () => {
    const deletesByMonitorId = new Map<number, number[]>([
      [1, [5000, 1200]],
      [7, [10]],
    ]);
    const runCalls: unknown[][] = [];
    const env = createEnv([
      monitorWalkHandler([1, 7]),
      {
        match: 'delete from check_results',
        run: (args) => {
          runCalls.push(args);
          const monitorId = args[0] as number;
          return { meta: { changes: deletesByMonitorId.get(monitorId)?.shift() ?? 0 } };
        },
      },
    ]);

    const scheduledTime = Date.UTC(2026, 1, 18, 0, 0, 0);
    await runRetention(env, { scheduledTime } as ScheduledController);

    expect(acquireLease).toHaveBeenCalledWith(
      env.DB,
      'retention:check_results',
      Math.floor(scheduledTime / 1000),
      600,
    );
    expect(readSettings).toHaveBeenCalledTimes(1);

    const cutoff = Math.floor(scheduledTime / 1000) - 7 * 86400;
    // monitor 1 needs a second batch (first batch was full), monitor 7 only one.
    expect(runCalls).toEqual([
      [1, cutoff, 5000],
      [1, cutoff, 5000],
      [7, cutoff, 5000],
    ]);
  });

  it('binds every delete to a monitor id so the leading index column stays usable', async () => {
    const sqlSeen: string[] = [];
    const env = createEnv([
      monitorWalkHandler([3]),
      {
        match: 'delete from check_results',
        run: (_args, normalizedSql) => {
          sqlSeen.push(normalizedSql);
          return { meta: { changes: 0 } };
        },
      },
    ]);

    await runRetention(env, { scheduledTime: Date.UTC(2026, 1, 18, 0, 30, 0) } as ScheduledController);

    expect(sqlSeen).toHaveLength(1);
    expect(sqlSeen[0]).toContain('where monitor_id = ?1');
    expect(sqlSeen[0]).not.toContain('order by checked_at');
  });

  it('stops once the per-run delete cap is reached', async () => {
    const runCalls: unknown[][] = [];
    const env = createEnv([
      monitorWalkHandler(Array.from({ length: 100 }, (_, index) => index + 1)),
      {
        match: 'delete from check_results',
        run: (args) => {
          runCalls.push(args);
          return { meta: { changes: 5000 } };
        },
      },
    ]);

    await runRetention(env, { scheduledTime: Date.UTC(2026, 1, 18, 0, 30, 0) } as ScheduledController);

    // 200_000 row cap / 5_000 per batch.
    expect(runCalls).toHaveLength(40);
  });

  it('guards against invalid cutoffs', async () => {
    vi.mocked(readSettings).mockResolvedValue({
      site_title: 'Uptimer',
      site_description: '',
      site_locale: 'auto',
      site_timezone: 'UTC',
      retention_check_results_days: Number.POSITIVE_INFINITY,
      state_failures_to_down_from_up: 2,
      state_successes_to_up_from_down: 2,
      admin_default_overview_range: '24h',
      admin_default_monitor_range: '24h',
      uptime_rating_level: 3,
    });

    const runCalls: unknown[][] = [];
    const env = createEnv([
      monitorWalkHandler([1]),
      {
        match: 'delete from check_results',
        run: (args) => {
          runCalls.push(args);
          return { meta: { changes: 0 } };
        },
      },
    ]);

    await runRetention(env, { scheduledTime: 1 } as ScheduledController);
    expect(runCalls).toHaveLength(0);
  });
});
