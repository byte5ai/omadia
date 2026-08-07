import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

/**
 * Migration 0032 (W2-4, issue #546) against a REAL Postgres.
 *
 * Two isolation rules this file obeys deliberately, both learned the hard way:
 *
 *  1. **A dedicated SCHEMA, never a scratch DATABASE.** `CREATE DATABASE` /
 *     `DROP DATABASE` are cluster-wide operations: they take locks that abort
 *     other connections to the cluster, and a previous run of this repo's pg
 *     suites cancelled 29 tests in concurrent files that way. A schema is
 *     namespaced, cheap, and droppable with `CASCADE` without touching anyone
 *     else's tables.
 *  2. **A dedicated tenant id in the schema name.** The suites in this repo
 *     share one cluster and run concurrently, so a fixed schema name would let
 *     two runs collide. The id is per-file, not per-test, because `before`
 *     builds the schema once.
 *
 * The migration is applied to a MINIMAL hand-built `mcp_oauth_clients` matching
 * migration 0015's shape — not the whole 31-migration chain. What is under test
 * is 0032's own DDL: does the CHECK constraint admit 'cimd', does it still
 * reject junk, and does `client_metadata_url` exist and accept NULL.
 */

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'mcpOAuthCimdMigration',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

/** Dedicated tenant id → dedicated schema. See rule 2 above. */
const TENANT = `w24_cimd_${process.pid}_${Date.now().toString(36)}`;

const MIGRATION_PATH = new URL('../migrations/0032_mcp_oauth_cimd.sql', import.meta.url);

describe('migration 0032 — mcp_oauth_clients CIMD (pg)', { skip: !pgAvailable }, () => {
  /** Creates and drops the tenant schema. Separate from `pool` because the
   *  schema must exist before a search_path-scoped connection can resolve. */
  let admin: Pool;
  /** Every query in the suite runs here. The search_path is pinned as a
   *  CONNECTION OPTION, not via a `SET` statement: a `SET` binds only the one
   *  pooled client that happened to serve it, so the next query — on a
   *  different client — would silently fall back to `public`. That bug made two
   *  of these tests fail on the first run, which is exactly the kind of
   *  cross-connection leakage a scratch database would have hidden. */
  let pool: Pool;

  before(async () => {
    admin = new Pool({ connectionString: PG_URL });
    await admin.query(`CREATE SCHEMA "${TENANT}"`);
    pool = new Pool({ connectionString: PG_URL, options: `-c search_path=${TENANT}` });
    // Migration 0015's table shape, verbatim in the parts 0032 alters.
    await pool.query(`
      CREATE TABLE mcp_oauth_clients (
        issuer            TEXT PRIMARY KEY,
        client_id         TEXT NOT NULL,
        client_secret_ref TEXT,
        registered_via    TEXT NOT NULL CHECK (registered_via IN ('dcr', 'manual')),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // A pre-existing row, so the migration is proven to run on a NON-empty
    // table — an ALTER that only works on an empty one is not a migration.
    await pool.query(
      `INSERT INTO mcp_oauth_clients (issuer, client_id, registered_via)
       VALUES ('https://legacy.example', 'legacy-cid', 'manual')`,
    );
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    await pool.query(sql);
  });

  after(async () => {
    // Schema-scoped teardown. No CREATE/DROP DATABASE anywhere — those are
    // cluster-wide and abort other connections to the same cluster.
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${TENANT}" CASCADE`);
    await admin.end();
  });

  it("admits registered_via = 'cimd' after the migration", async () => {
    await pool.query(
      `INSERT INTO mcp_oauth_clients (issuer, client_id, registered_via, client_metadata_url)
       VALUES ('https://broker.example', 'https://omadia.example/.well-known/omadia-mcp-client',
               'cimd', 'https://omadia.example/.well-known/omadia-mcp-client')`,
    );
    const { rows } = await pool.query<{ registered_via: string; client_metadata_url: string }>(
      `SELECT registered_via, client_metadata_url FROM mcp_oauth_clients
        WHERE issuer = 'https://broker.example'`,
    );
    assert.equal(rows[0]?.registered_via, 'cimd');
    assert.equal(
      rows[0]?.client_metadata_url,
      'https://omadia.example/.well-known/omadia-mcp-client',
    );
  });

  it("still admits 'dcr' and 'manual' — neither mode is retired", async () => {
    await pool.query(
      `INSERT INTO mcp_oauth_clients (issuer, client_id, registered_via)
       VALUES ('https://dcr.example', 'd', 'dcr'), ('https://manual.example', 'm', 'manual')`,
    );
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM mcp_oauth_clients WHERE registered_via IN ('dcr','manual')`,
    );
    // The pre-migration 'manual' row plus the two just inserted.
    assert.equal(rows[0]?.n, '3');
  });

  it('still REJECTS an unknown acquisition mode (the CHECK was widened, not dropped)', async () => {
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO mcp_oauth_clients (issuer, client_id, registered_via)
           VALUES ('https://bogus.example', 'b', 'telepathy')`,
        ),
      (err: unknown) => (err as { code?: string }).code === '23514',
      'a widened CHECK must still constrain',
    );
  });

  it('leaves client_metadata_url NULL for the pre-existing manual row', async () => {
    const { rows } = await pool.query<{ client_metadata_url: string | null }>(
      `SELECT client_metadata_url FROM mcp_oauth_clients WHERE issuer = 'https://legacy.example'`,
    );
    assert.equal(rows[0]?.client_metadata_url, null);
  });

  it('is idempotent — re-applying changes nothing and raises nothing', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    await pool.query(sql);
    await pool.query(
      `INSERT INTO mcp_oauth_clients (issuer, client_id, registered_via)
       VALUES ('https://again.example', 'a', 'cimd')`,
    );
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_constraint
        WHERE conname = 'mcp_oauth_clients_registered_via_chk'
          AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)`,
      [TENANT],
    );
    assert.equal(rows[0]?.n, '1', 'the named constraint must exist exactly once');
  });
});
