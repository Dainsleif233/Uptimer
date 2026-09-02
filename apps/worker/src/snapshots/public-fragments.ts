// The `generated_at` guard prevents stale overwrites. The `body_json` guard makes the
// write a no-op when the fragment content is byte-identical and not newer, which is the
// steady state for idle ticks: the pipeline re-seeds every fragment from an unchanged
// snapshot each minute, and only `updated_at` would have moved. Fragment freshness is
// decided by `generated_at` everywhere it is read, so skipping those writes is safe and
// removes O(monitors) rows_written per idle tick.
const UPSERT_FRAGMENT_SQL = `
  INSERT INTO public_snapshot_fragments (
    snapshot_key,
    fragment_key,
    generated_at,
    body_json,
    updated_at
  )
  VALUES (?1, ?2, ?3, ?4, ?5)
  ON CONFLICT(snapshot_key, fragment_key) DO UPDATE SET
    generated_at = excluded.generated_at,
    body_json = excluded.body_json,
    updated_at = excluded.updated_at
  WHERE excluded.generated_at > public_snapshot_fragments.generated_at
     OR (
       excluded.generated_at = public_snapshot_fragments.generated_at
       AND excluded.body_json <> public_snapshot_fragments.body_json
     )
`;

const READ_FRAGMENTS_SQL = `
  SELECT fragment_key, generated_at, body_json, updated_at
  FROM public_snapshot_fragments
  WHERE snapshot_key = ?1
  ORDER BY fragment_key
`;

// Keyset pagination. `OFFSET` makes SQLite walk and discard every skipped row, so
// paging N fragments in batches of R scanned ~N^2/(2R) rows per pass. Seeking on the
// primary key `(snapshot_key, fragment_key)` reads only the rows returned.
const READ_FRAGMENTS_AFTER_KEY_SQL = `
  SELECT fragment_key, generated_at, body_json, updated_at
  FROM public_snapshot_fragments
  WHERE snapshot_key = ?1
    AND fragment_key > ?2
  ORDER BY fragment_key
  LIMIT ?3
`;

const upsertFragmentStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const readFragmentsStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();
const readFragmentsAfterKeyStatementByDb = new WeakMap<D1Database, D1PreparedStatement>();

export type PublicSnapshotFragmentWrite = {
  snapshotKey: string;
  fragmentKey: string;
  generatedAt: number;
  bodyJson: string;
  updatedAt: number;
};

export type PublicSnapshotFragmentRow = {
  fragment_key: string;
  generated_at: number;
  body_json: string;
  updated_at: number | null;
};

function assertFragmentText(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`public snapshot fragment ${label} must not be empty`);
  }
}

function assertFiniteTimestamp(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`public snapshot fragment ${label} must be a non-negative integer`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`public snapshot fragment ${label} must be a positive integer`);
  }
}

export function preparePublicSnapshotFragmentWrite(
  db: D1Database,
  fragment: PublicSnapshotFragmentWrite,
): D1PreparedStatement {
  assertFragmentText(fragment.snapshotKey, 'snapshotKey');
  assertFragmentText(fragment.fragmentKey, 'fragmentKey');
  assertFragmentText(fragment.bodyJson, 'bodyJson');
  assertFiniteTimestamp(fragment.generatedAt, 'generatedAt');
  assertFiniteTimestamp(fragment.updatedAt, 'updatedAt');

  const cached = upsertFragmentStatementByDb.get(db);
  const statement = cached ?? db.prepare(UPSERT_FRAGMENT_SQL);
  if (!cached) {
    upsertFragmentStatementByDb.set(db, statement);
  }

  return statement.bind(
    fragment.snapshotKey,
    fragment.fragmentKey,
    fragment.generatedAt,
    fragment.bodyJson,
    fragment.updatedAt,
  );
}

export async function writePublicSnapshotFragments(
  db: D1Database,
  fragments: PublicSnapshotFragmentWrite[],
): Promise<D1Result[]> {
  if (fragments.length === 0) {
    return [];
  }

  const statements = fragments.map((fragment) => preparePublicSnapshotFragmentWrite(db, fragment));
  return await db.batch(statements);
}

export async function readPublicSnapshotFragments(
  db: D1Database,
  snapshotKey: string,
): Promise<PublicSnapshotFragmentRow[]> {
  assertFragmentText(snapshotKey, 'snapshotKey');

  const cached = readFragmentsStatementByDb.get(db);
  const statement = cached ?? db.prepare(READ_FRAGMENTS_SQL);
  if (!cached) {
    readFragmentsStatementByDb.set(db, statement);
  }

  const { results } = await statement.bind(snapshotKey).all<PublicSnapshotFragmentRow>();
  return results ?? [];
}

export async function readPublicSnapshotFragmentsAfterKey(
  db: D1Database,
  snapshotKey: string,
  opts: { afterFragmentKey: string; limit: number },
): Promise<PublicSnapshotFragmentRow[]> {
  assertFragmentText(snapshotKey, 'snapshotKey');
  assertPositiveInteger(opts.limit, 'limit');

  const cached = readFragmentsAfterKeyStatementByDb.get(db);
  const statement = cached ?? db.prepare(READ_FRAGMENTS_AFTER_KEY_SQL);
  if (!cached) {
    readFragmentsAfterKeyStatementByDb.set(db, statement);
  }

  const { results } = await statement
    .bind(snapshotKey, opts.afterFragmentKey, opts.limit)
    .all<PublicSnapshotFragmentRow>();
  return results ?? [];
}
