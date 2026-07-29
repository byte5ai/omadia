import type { PoolClient } from 'pg';

/**
 * #440 — catalog probes used by the runtime vector-column width migration.
 *
 * Split out of `vectorColumnMigration.ts` so that file stays about the
 * ORDER and the GUARDS of a destructive operation, and this one about reading
 * the truth out of `pg_catalog`. Everything here is read-only.
 */

/** Identifiers come from the catalog, but quoting them costs nothing and
 *  removes the question entirely. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export interface VectorColumnTarget {
  table: string;
  column: string;
}

export interface ColumnCatalogInfo {
  /** `public.vector` — schema-qualified exactly as `ADD COLUMN` needs it. */
  baseType: string;
  declaredDimensions: number | undefined;
}

/**
 * Base type plus declared width, straight from the catalog.
 *
 * `format_type(oid, NULL)` is the type WITHOUT its modifier, which is exactly
 * what `ADD COLUMN … <type>(<n>)` needs — and it is schema-qualified whenever
 * the type's schema is not on the search_path, which is the normal case for a
 * `vector` type living in `public` while the app runs in its own schema.
 */
export async function readColumnInfo(
  client: PoolClient,
  target: VectorColumnTarget,
): Promise<ColumnCatalogInfo | undefined> {
  const result = await client.query<{ base_type: string; declared_type: string }>(
    `SELECT format_type(a.atttypid, NULL)           AS base_type,
            format_type(a.atttypid, a.atttypmod)    AS declared_type
       FROM pg_attribute a
       JOIN pg_class     c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = $1
        AND a.attname = $2
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND n.nspname = ANY (current_schemas(false))`,
    [target.table, target.column],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const match = /\((\d+)\)\s*$/.exec(row.declared_type);
  const dims = match?.[1] !== undefined ? Number(match[1]) : Number.NaN;
  return {
    baseType: row.base_type,
    declaredDimensions: Number.isInteger(dims) && dims > 0 ? dims : undefined,
  };
}

/**
 * Every index that references the column, as executable DDL.
 *
 * `pg_get_indexdef` emits a schema-qualified, fully-formed `CREATE INDEX`
 * including the operator class, `WITH (…)` storage parameters and any partial
 * predicate. Replaying it verbatim is the only way to be sure the rebuilt
 * index is the one that was there: the HNSW opclass does not encode the vector
 * dimension, so the same text is valid at the new width — while
 * hand-assembling the SQL from catalog columns silently drops whichever detail
 * the author did not think of (`m`, `ef_construction`, a WHERE predicate, a
 * second key column).
 *
 * Constraint-backed indexes are excluded: `DROP INDEX` refuses them, and no
 * sane schema hangs a UNIQUE/PK constraint off an embedding column.
 */
export async function captureIndexDefs(
  client: PoolClient,
  target: VectorColumnTarget,
): Promise<string[]> {
  const result = await client.query<{ index_def: string }>(
    `SELECT pg_get_indexdef(x.indexrelid) AS index_def
       FROM pg_index     x
       JOIN pg_class     i ON i.oid = x.indexrelid
       JOIN pg_class     t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.relname = $1
        AND n.nspname = ANY (current_schemas(false))
        AND NOT EXISTS (
              SELECT 1 FROM pg_constraint con WHERE con.conindid = x.indexrelid
            )
        AND EXISTS (
              SELECT 1
                FROM unnest(x.indkey) AS k(attnum)
                JOIN pg_attribute a
                  ON a.attrelid = x.indrelid AND a.attnum = k.attnum
               WHERE a.attname = $2
            )
      ORDER BY i.relname`,
    [target.table, target.column],
  );
  return result.rows.map((r) => r.index_def);
}

/** `CREATE [UNIQUE] INDEX name ON schema.table …` → the index name exactly as
 *  Postgres printed it (quoted when it needs to be), so it can be dropped
 *  before the column goes away. */
export function indexNameOf(def: string): string | undefined {
  const match =
    /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?("(?:[^"]|"")+"|\S+)\s+ON\s/i.exec(
      def,
    );
  return match?.[1];
}

/**
 * How many vectors this migration is about to destroy.
 *
 * Best-effort by design: the number exists for the operator-facing WARN log,
 * so a `statement_timeout` on a huge table degrades to "unknown" rather than
 * aborting a migration that is otherwise fine. Runs in its own transaction so
 * the timeout cannot leak into the DDL that follows.
 */
export async function countVectors(
  client: PoolClient,
  target: VectorColumnTarget,
  tenantId: string,
  statementTimeoutMs: number,
): Promise<number | undefined> {
  try {
    await client.query('BEGIN');
    await client.query(
      `SET LOCAL statement_timeout = ${String(Math.max(1, Math.floor(statementTimeoutMs)))}`,
    );
    const result = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${quoteIdent(target.table)}
        WHERE tenant_id = $1 AND ${quoteIdent(target.column)} IS NOT NULL`,
      [tenantId],
    );
    await client.query('COMMIT');
    const n = Number(result.rows[0]?.n ?? Number.NaN);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    try {
      await client.query('ROLLBACK');
    } catch {
      // A connection this broken fails loudly on the caller's next statement.
    }
    return undefined;
  }
}

/**
 * Does the corpus still hold vectors in ANY of the columns about to be
 * dropped? This is the predicate the anti-oscillation cooldown rests on, so it
 * spans every target rather than just the first — a tenant whose vectors live
 * only in `processes` would otherwise read as "nothing to lose".
 */
export async function hasAnyVector(
  client: PoolClient,
  targets: ReadonlyArray<VectorColumnTarget>,
  tenantId: string,
): Promise<boolean> {
  if (targets.length === 0) return false;
  const probes = targets
    .map(
      (t) =>
        `EXISTS (SELECT 1 FROM ${quoteIdent(t.table)} WHERE tenant_id = $1 AND ${quoteIdent(t.column)} IS NOT NULL)`,
    )
    .join('\n          OR ');
  const result = await client.query<{ has_vectors: boolean }>(
    `SELECT (${probes}) AS has_vectors`,
    [tenantId],
  );
  return result.rows[0]?.has_vectors === true;
}
