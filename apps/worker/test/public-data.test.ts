import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  computeHeartbeatSinceCheckedAt,
  computeTodayPartialUptimeBatch,
  listHeartbeatsByMonitorId,
} from '../src/public/data';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

describe('public/data', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('chunks today partial uptime SQL to stay within the D1 bind limit', async () => {
    const rangeStart = 1_776_172_800;
    const now = rangeStart + 600;
    const monitors = Array.from({ length: 26 }, (_, index) => ({
      id: index + 1,
      interval_sec: 60,
      created_at: rangeStart - 3_600,
      last_checked_at: now - 30,
    }));

    const sqlChunkArgLengths: number[] = [];
    const sqlChunkIds: number[][] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'with input(monitor_id, interval_sec, created_at, last_checked_at) as (',
        all: (args) => {
          sqlChunkArgLengths.push(args.length);

          const ids: number[] = [];
          for (let index = 2; index < args.length; index += 4) {
            const id = args[index];
            if (typeof id === 'number') ids.push(id);
          }
          sqlChunkIds.push(ids);

          return ids.map((id) => ({
            monitor_id: id,
            start_at: rangeStart,
            total_sec: now - rangeStart,
            downtime_sec: 0,
            unknown_sec: 0,
          }));
        },
      },
    ];

    const result = await computeTodayPartialUptimeBatch(
      createFakeD1Database(handlers),
      monitors,
      rangeStart,
      now,
    );

    expect(warnSpy).not.toHaveBeenCalled();
    expect(sqlChunkArgLengths).toEqual([98, 10]);
    expect(Math.max(...sqlChunkArgLengths)).toBeLessThanOrEqual(100);
    expect(sqlChunkIds).toEqual([Array.from({ length: 24 }, (_, index) => index + 1), [25, 26]]);
    expect(result.size).toBe(26);
    expect(result.get(1)).toMatchObject({
      total_sec: 600,
      downtime_sec: 0,
      unknown_sec: 0,
      uptime_sec: 600,
      uptime_pct: 100,
    });
    expect(result.get(26)).toMatchObject({
      total_sec: 600,
      downtime_sec: 0,
      unknown_sec: 0,
      uptime_sec: 600,
      uptime_pct: 100,
    });
  });

  it('listHeartbeatsByMonitorId excludes rows older than sinceCheckedAt', async () => {
    const now = 1_776_172_800;
    const limit = 60;
    const sinceCheckedAt = computeHeartbeatSinceCheckedAt(now, 60, limit);
    expect(sinceCheckedAt).toBeLessThan(now);

    const recentTs = now - 10;
    const oldTs = sinceCheckedAt - 1000;

    const captured: { args: unknown[]; sql: string }[] = [];
    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from check_results',
        all: (args, sql) => {
          captured.push({ args: args as unknown[], sql });
          const boundSince = args[args.length - 1] as number;
          const rows = [
            { monitor_id: 1, checked_at: recentTs, status: 'up', latency_ms: 12 },
            { monitor_id: 1, checked_at: oldTs, status: 'down', latency_ms: 50 },
          ]
            .filter((r) => r.checked_at >= boundSince)
            .sort((a, b) => b.checked_at - a.checked_at)
            .slice(0, limit);
          return rows;
        },
      },
    ];

    const result = await listHeartbeatsByMonitorId(createFakeD1Database(handlers), [1], limit, {
      sinceCheckedAt,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].sql).toContain('checked_at >= ?');
    expect(captured[0].args[captured[0].args.length - 1]).toBe(sinceCheckedAt);

    const heartbeats = result.get(1);
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats?.[0]).toMatchObject({ checked_at: recentTs, status: 'up', latency_ms: 12 });
  });

  it('listHeartbeatsByMonitorId defaults to an unbounded scan when sinceCheckedAt is omitted', async () => {
    const now = 1_776_172_800;
    const limit = 60;
    const oldTs = 100;

    const captured: { args: unknown[]; sql: string }[] = [];
    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'from check_results',
        all: (args, sql) => {
          captured.push({ args: args as unknown[], sql });
          const boundSince = args[args.length - 1] as number;
          const rows = [
            { monitor_id: 1, checked_at: now - 5, status: 'up', latency_ms: 7 },
            { monitor_id: 1, checked_at: oldTs, status: 'down', latency_ms: 99 },
          ].filter((r) => r.checked_at >= boundSince);
          return rows;
        },
      },
    ];

    const result = await listHeartbeatsByMonitorId(createFakeD1Database(handlers), [1], limit);

    expect(captured).toHaveLength(1);
    // Default lower bound is 0, a no-op filter that preserves the unbounded behavior.
    expect(captured[0].args[captured[0].args.length - 1]).toBe(0);
    const heartbeats = result.get(1);
    expect(heartbeats).toHaveLength(2);
  });
});
