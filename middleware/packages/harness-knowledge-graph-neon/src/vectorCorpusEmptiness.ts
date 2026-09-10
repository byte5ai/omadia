import type { Pool } from 'pg';

import { hasAnyVector } from './vectorColumnCatalog.js';
import type { GovernedVectorColumn } from './embeddingModelGate.js';

/**
 * OM-98 — is there anything in these vector columns to lose?
 *
 * The width migration in `vectorColumnMigration.ts` is documented as
 * destructive because it drops and re-adds the column. That is only true when
 * the column holds something: on a fresh install every governed
 * `vector(n)` column is EMPTY, and the rewrite then discards nothing at all.
 *
 * The beta report this answers: a keyless (384d) adapter cannot be brought up
 * on an existing install whose columns are 768-wide and empty. The only path
 * that may rewrite a column is an operator-confirmed PROVIDER SWITCH, and
 * #1053 removes the second provider at boot — so there is no second provider
 * to switch to and nothing to confirm. The deployment dead-ends on
 * `blocked/column-width-mismatch` with an empty corpus.
 *
 * WHY IT RETURNS `undefined` RATHER THAN FALSE ON FAILURE. The caller uses
 * this to decide whether it may skip the discard confirmation. "Could not
 * establish" and "there are vectors" both have to keep the confirmation in
 * place, but only one of them is a fact — folding them together would have the
 * log tell an operator their corpus is non-empty when the truth is that the
 * count timed out.
 */
export async function areGovernedColumnsEmpty(
  pool: Pool,
  columns: readonly GovernedVectorColumn[],
  tenantId: string,
  statementTimeoutMs: number,
): Promise<boolean | undefined> {
  if (columns.length === 0) return true;
  const targets = columns.map((c) => ({ table: c.table, column: c.column }));
  const client = await pool.connect();
  try {
    // Own transaction with its own timeout, exactly like `countVectors`: a
    // probe run for a decision must never be able to wedge the evaluation it
    // is informing.
    await client.query('BEGIN');
    await client.query(
      `SET LOCAL statement_timeout = ${String(Math.max(1, Math.floor(statementTimeoutMs)))}`,
    );
    const has = await hasAnyVector(client, targets, tenantId);
    await client.query('COMMIT');
    return !has;
  } catch {
    try {
      await client.query('ROLLBACK');
    } catch {
      // A connection this broken fails loudly on the caller's next statement.
    }
    return undefined;
  } finally {
    client.release();
  }
}
