import { describe, expect, it } from 'vitest';

import {
  readPublicSnapshotFragments,
  readPublicSnapshotFragmentsAfterKey,
  writePublicSnapshotFragments,
} from '../src/snapshots/public-fragments';
import { createFakeD1Database } from './helpers/fake-d1';

describe('snapshots/public-fragments', () => {
  it('writes public snapshot fragments in a D1 batch', async () => {
    const writes: unknown[][] = [];
    const db = createFakeD1Database([
      {
        match: 'insert into public_snapshot_fragments',
        run: (args) => {
          writes.push(args);
          return { meta: { changes: 1 } };
        },
      },
    ]);

    const results = await writePublicSnapshotFragments(db, [
      {
        snapshotKey: 'status',
        fragmentKey: 'monitor:1',
        generatedAt: 200,
        bodyJson: '{"id":1}',
        updatedAt: 205,
      },
      {
        snapshotKey: 'status',
        fragmentKey: 'monitor:2',
        generatedAt: 200,
        bodyJson: '{"id":2}',
        updatedAt: 205,
      },
    ]);

    expect(results).toHaveLength(2);
    expect(writes).toEqual([
      ['status', 'monitor:1', 200, '{"id":1}', 205],
      ['status', 'monitor:2', 200, '{"id":2}', 205],
    ]);
  });

  it('reads public snapshot fragments ordered by fragment key', async () => {
    const db = createFakeD1Database([
      {
        match: 'from public_snapshot_fragments',
        all: (args) => {
          expect(args).toEqual(['status']);
          return [
            {
              fragment_key: 'monitor:1',
              generated_at: 200,
              body_json: '{"id":1}',
              updated_at: 205,
            },
          ];
        },
      },
    ]);

    await expect(readPublicSnapshotFragments(db, 'status')).resolves.toEqual([
      {
        fragment_key: 'monitor:1',
        generated_at: 200,
        body_json: '{"id":1}',
        updated_at: 205,
      },
    ]);
  });

  it('skips the upsert when the fragment body is unchanged at the same generated_at', async () => {
    const sqlSeen: string[] = [];
    const db = createFakeD1Database([
      {
        match: 'insert into public_snapshot_fragments',
        run: (_args, normalizedSql) => {
          sqlSeen.push(normalizedSql);
          // Idle tick: identical body at the same generated_at, so no row changes.
          return { meta: { changes: 0 } };
        },
      },
    ]);

    await writePublicSnapshotFragments(db, [
      {
        snapshotKey: 'homepage:monitors',
        fragmentKey: 'monitor:1',
        generatedAt: 200,
        bodyJson: '{"id":1}',
        updatedAt: 260,
      },
    ]);

    expect(sqlSeen).toHaveLength(1);
    // Newer generated_at always wins; equal generated_at only writes on a body change.
    expect(sqlSeen[0]).toContain(
      'where excluded.generated_at > public_snapshot_fragments.generated_at',
    );
    expect(sqlSeen[0]).toContain(
      'excluded.body_json <> public_snapshot_fragments.body_json',
    );
  });

  it('reads fragment pages with a keyset seek instead of OFFSET', async () => {
    const args: unknown[][] = [];
    const db = createFakeD1Database([
      {
        match: 'from public_snapshot_fragments',
        all: (received, normalizedSql) => {
          args.push(received);
          expect(normalizedSql).toContain('and fragment_key > ?2');
          expect(normalizedSql).not.toContain('offset');
          return [
            {
              fragment_key: 'monitor:4',
              generated_at: 200,
              body_json: '{"id":4}',
              updated_at: 205,
            },
          ];
        },
      },
    ]);

    await expect(
      readPublicSnapshotFragmentsAfterKey(db, 'status', {
        afterFragmentKey: 'monitor:3',
        limit: 2,
      }),
    ).resolves.toHaveLength(1);
    expect(args).toEqual([['status', 'monitor:3', 2]]);
  });

  it('rejects empty fragment identifiers before preparing SQL', async () => {
    const db = createFakeD1Database([]);

    await expect(
      writePublicSnapshotFragments(db, [
        {
          snapshotKey: 'status',
          fragmentKey: '',
          generatedAt: 200,
          bodyJson: '{"id":1}',
          updatedAt: 205,
        },
      ]),
    ).rejects.toThrow('fragmentKey must not be empty');
  });
});
