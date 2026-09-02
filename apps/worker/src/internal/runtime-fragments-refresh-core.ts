import type { Env } from '../env';
import type { Trace } from '../observability/trace';
import {
  refreshPublicMonitorRuntimeSnapshot,
  type MonitorRuntimeUpdate,
} from '../public/monitor-runtime';
import { rebuildPublicMonitorRuntimeSnapshot } from '../public/monitor-runtime-bootstrap';
import {
  readMonitorRuntimeUpdateFragments,
  readMonitorRuntimeUpdateFragmentsPage,
} from '../snapshots/public-monitor-fragments';

export const MONITOR_RUNTIME_UPDATE_FRAGMENT_MAX_AGE_SECONDS = 5 * 60;
export const MONITOR_RUNTIME_UPDATE_FRAGMENT_FUTURE_TOLERANCE_SECONDS = 60;

export type InternalRuntimeFragmentsRefreshResult = {
  ok: boolean;
  refreshed: boolean;
  updateCount: number;
  invalidCount: number;
  staleCount: number;
  skip?: 'no_updates';
  error?: boolean;
  hasMore?: boolean;
  rowCount?: number;
  updateCursor?: string | null;
  nextUpdateCursor?: string | null;
  updateLimit?: number;
};

function readBoundedPositiveIntegerEnv(
  env: Env,
  key: keyof Env,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (typeof raw !== 'string') {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function latestUpdateTimestamp(updates: readonly MonitorRuntimeUpdate[]): number | null {
  let latest: number | null = null;
  for (const update of updates) {
    if (latest === null || update.checked_at > latest) {
      latest = update.checked_at;
    }
  }
  return latest;
}

async function refreshMonitorRuntimeSnapshotFromUpdates(opts: {
  env: Env;
  now: number;
  updates: readonly MonitorRuntimeUpdate[];
  trace?: Trace | null;
}): Promise<void> {
  const refreshNow = Math.max(opts.now, latestUpdateTimestamp(opts.updates) ?? opts.now);
  await (opts.trace
    ? opts.trace.timeAsync(
        'runtime_fragments_refresh_snapshot',
        async () =>
          await refreshPublicMonitorRuntimeSnapshot({
            db: opts.env.DB,
            now: refreshNow,
            updates: [...opts.updates],
            rebuild: async () => await rebuildPublicMonitorRuntimeSnapshot(opts.env.DB, refreshNow),
          }),
      )
    : refreshPublicMonitorRuntimeSnapshot({
        db: opts.env.DB,
        now: refreshNow,
        updates: [...opts.updates],
        rebuild: async () => await rebuildPublicMonitorRuntimeSnapshot(opts.env.DB, refreshNow),
      }));
}

function readRuntimeFragmentTimeWindow(opts: { env: Env; now: number }): {
  maxAgeSeconds: number;
  minGeneratedAt: number;
  maxGeneratedAt: number;
} {
  const maxAgeSeconds = readBoundedPositiveIntegerEnv(
    opts.env,
    'UPTIMER_MONITOR_RUNTIME_UPDATE_FRAGMENT_MAX_AGE_SECONDS',
    MONITOR_RUNTIME_UPDATE_FRAGMENT_MAX_AGE_SECONDS,
    30,
    15 * 60,
  );
  return {
    maxAgeSeconds,
    minGeneratedAt: Math.max(0, opts.now - maxAgeSeconds),
    maxGeneratedAt: opts.now + MONITOR_RUNTIME_UPDATE_FRAGMENT_FUTURE_TOLERANCE_SECONDS,
  };
}

export async function refreshMonitorRuntimeSnapshotFromUpdateFragments(opts: {
  env: Env;
  now: number;
  trace?: Trace | null;
}): Promise<InternalRuntimeFragmentsRefreshResult> {
  const { maxAgeSeconds, minGeneratedAt, maxGeneratedAt } = readRuntimeFragmentTimeWindow(opts);

  try {
    opts.trace?.setLabel('route', 'internal/runtime-fragments-refresh');
    opts.trace?.setLabel('now', opts.now);
    opts.trace?.setLabel('fragment_max_age_s', maxAgeSeconds);

    const fragmentRead = opts.trace
      ? await opts.trace.timeAsync(
          'runtime_fragments_read',
          async () =>
            await readMonitorRuntimeUpdateFragments(opts.env.DB, {
              minGeneratedAt,
              maxGeneratedAt,
            }),
        )
      : await readMonitorRuntimeUpdateFragments(opts.env.DB, {
          minGeneratedAt,
          maxGeneratedAt,
        });

    opts.trace?.setLabel('runtime_update_fragment_count', fragmentRead.updates.length);
    opts.trace?.setLabel('runtime_update_fragment_invalid_count', fragmentRead.invalidCount);
    opts.trace?.setLabel('runtime_update_fragment_stale_count', fragmentRead.staleCount);

    if (fragmentRead.updates.length === 0) {
      opts.trace?.setLabel('skip', 'no_updates');
      return {
        ok: true,
        refreshed: false,
        updateCount: 0,
        invalidCount: fragmentRead.invalidCount,
        staleCount: fragmentRead.staleCount,
        skip: 'no_updates',
      };
    }

    await refreshMonitorRuntimeSnapshotFromUpdates({
      env: opts.env,
      now: opts.now,
      updates: fragmentRead.updates,
      trace: opts.trace ?? null,
    });

    return {
      ok: true,
      refreshed: true,
      updateCount: fragmentRead.updates.length,
      invalidCount: fragmentRead.invalidCount,
      staleCount: fragmentRead.staleCount,
    };
  } catch (err) {
    console.warn('internal runtime fragments refresh failed', err);
    opts.trace?.setLabel('error', '1');
    return {
      ok: false,
      refreshed: false,
      updateCount: 0,
      invalidCount: 0,
      staleCount: 0,
      error: true,
    };
  }
}

export async function refreshMonitorRuntimeSnapshotFromUpdateFragmentsPage(opts: {
  env: Env;
  now: number;
  cursor?: string | null;
  limit: number;
  trace?: Trace | null;
}): Promise<InternalRuntimeFragmentsRefreshResult> {
  const updateCursor = typeof opts.cursor === 'string' ? opts.cursor : null;
  const updateLimit = Math.max(1, Math.min(10, Math.floor(opts.limit)));
  const { maxAgeSeconds, minGeneratedAt, maxGeneratedAt } = readRuntimeFragmentTimeWindow(opts);

  try {
    opts.trace?.setLabel('route', 'internal/runtime-fragments-refresh-page');
    opts.trace?.setLabel('now', opts.now);
    opts.trace?.setLabel('fragment_max_age_s', maxAgeSeconds);
    opts.trace?.setLabel('runtime_update_cursor', updateCursor ?? '-');
    opts.trace?.setLabel('runtime_update_limit', updateLimit);

    const readPage = async () =>
      await readMonitorRuntimeUpdateFragmentsPage(opts.env.DB, {
        minGeneratedAt,
        maxGeneratedAt,
        ...(updateCursor !== null ? { afterFragmentKey: updateCursor } : {}),
        limit: updateLimit,
      });
    const fragmentRead = opts.trace
      ? await opts.trace.timeAsync('runtime_fragments_page_read', readPage)
      : await readPage();

    opts.trace?.setLabel('runtime_update_fragment_count', fragmentRead.updates.length);
    opts.trace?.setLabel('runtime_update_fragment_invalid_count', fragmentRead.invalidCount);
    opts.trace?.setLabel('runtime_update_fragment_stale_count', fragmentRead.staleCount);
    opts.trace?.setLabel('runtime_update_fragment_has_more', fragmentRead.hasMore ? 1 : 0);

    if (fragmentRead.updates.length === 0) {
      opts.trace?.setLabel('skip', 'no_updates');
      return {
        ok: true,
        refreshed: false,
        updateCount: 0,
        invalidCount: fragmentRead.invalidCount,
        staleCount: fragmentRead.staleCount,
        skip: 'no_updates',
        hasMore: fragmentRead.hasMore,
        rowCount: fragmentRead.rowCount,
        updateCursor,
        nextUpdateCursor: fragmentRead.lastFragmentKey,
        updateLimit,
      };
    }

    await refreshMonitorRuntimeSnapshotFromUpdates({
      env: opts.env,
      now: opts.now,
      updates: fragmentRead.updates,
      trace: opts.trace ?? null,
    });

    return {
      ok: true,
      refreshed: true,
      updateCount: fragmentRead.updates.length,
      invalidCount: fragmentRead.invalidCount,
      staleCount: fragmentRead.staleCount,
      hasMore: fragmentRead.hasMore,
      rowCount: fragmentRead.rowCount,
      updateCursor,
      nextUpdateCursor: fragmentRead.lastFragmentKey,
      updateLimit,
    };
  } catch (err) {
    console.warn('internal runtime fragments page refresh failed', err);
    opts.trace?.setLabel('error', '1');
    return {
      ok: false,
      refreshed: false,
      updateCount: 0,
      invalidCount: 0,
      staleCount: 0,
      error: true,
      hasMore: false,
      rowCount: 0,
      updateCursor,
      nextUpdateCursor: null,
      updateLimit,
    };
  }
}
