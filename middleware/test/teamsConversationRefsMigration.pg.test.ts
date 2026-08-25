import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

/**
 * KG migration 0031 — teams_conversation_refs canonical home + per-bot key.
 *
 * The table's original DDL (graph migration "0009", #841) landed in
 * `src/services/graph/migrations/` — a directory nothing applies since graph
 * migrations were consolidated into the @omadia/knowledge-graph-neon series.
 * 0031 is the rescue (CREATE in the series that runs) plus the multi-bot
 * re-key: `bot_app_id TEXT NOT NULL DEFAULT ''` with a composite primary key
 * `(conversation_id, bot_app_id)`, where `''` is the legacy/default bot.
 *
 * What this suite proves, against a real Postgres:
 *   1. Fresh apply creates the composite-key shape.
 *   2. Apply over the LEGACY shape (single-column PK, existing rows) keeps
 *      the rows, backfills `bot_app_id = ''`, and re-keys the PK.
 *   3. The migration is idempotent — a second apply is a no-op, not a 42710.
 *   4. The composite key does what the multi-bot ref store needs: the same
 *      conversation can hold one row per bot.
 *
 * Isolation follows mcpDelegationBackfillMigration.pg.test.ts: a dedicated
 * schema per run, `search_path` pinned as a connection option, and the
 * migration text applied verbatim (no schema-qualified references).
 */

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'teamsConversationRefsMigration',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const TENANT = `w0a_refs_${process.pid}_${Date.now().toString(36)}`;

const MIGRATION_PATH = new URL(
  '../packages/harness-knowledge-graph-neon/src/migrations/0031_teams_conversation_refs.sql',
  import.meta.url,
);

function stripWholeLineSqlComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

async function migrationSql(): Promise<string> {
  const raw = await readFile(MIGRATION_PATH, 'utf8');
  const executable = stripWholeLineSqlComments(raw);
  assert.equal(
    /\bpublic\s*\.|"public"\s*\./i.test(executable),
    false,
    'migration 0031 gained an executable public-qualified reference — it must resolve through search_path, ' +
      'or this suite runs it against tables it does not own and passes vacuously',
  );
  return raw;
}

async function pkColumns(pool: Pool): Promise<string[]> {
  const res = await pool.query<{ attname: string }>(
    `SELECT a.attname
       FROM pg_constraint c
       JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.conrelid = 'teams_conversation_refs'::regclass
        AND c.contype = 'p'
      ORDER BY k.ord`,
  );
  return res.rows.map((r) => r.attname);
}

describe('migration 0031 — teams_conversation_refs (pg)', { skip: !pgAvailable }, () => {
  let admin: Pool;
  let pool: Pool;

  before(async () => {
    admin = new Pool({ connectionString: PG_URL });
    await admin.query(`CREATE SCHEMA "${TENANT}"`);
    pool = new Pool({ connectionString: PG_URL, options: `-c search_path=${TENANT}` });
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${TENANT}" CASCADE`);
    await admin?.end();
  });

  it('fresh apply creates the composite-key shape, twice (idempotent)', async () => {
    const sql = await migrationSql();
    await pool.query(sql);
    await pool.query(sql); // second apply must be a no-op, not 42710
    assert.deepEqual(await pkColumns(pool), ['conversation_id', 'bot_app_id']);
  });

  it('upgrades the legacy shape: rows kept, bot_app_id backfilled to the default-bot sentinel, PK re-keyed', async () => {
    await pool.query('DROP TABLE teams_conversation_refs');
    // The exact shape the orphaned 0009 file (or a hand-created rescue) left behind.
    await pool.query(`
      CREATE TABLE teams_conversation_refs (
        conversation_id TEXT PRIMARY KEY,
        ref             JSONB NOT NULL,
        teams_type      TEXT,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pool.query(
      `INSERT INTO teams_conversation_refs (conversation_id, ref, teams_type)
       VALUES ('19:legacy@thread.v2', '{"serviceUrl":"https://smba.trafficmanager.net/de/"}', 'channel')`,
    );

    const sql = await migrationSql();
    await pool.query(sql);
    await pool.query(sql); // idempotent over the upgraded shape too

    assert.deepEqual(await pkColumns(pool), ['conversation_id', 'bot_app_id']);
    const row = await pool.query(
      `SELECT bot_app_id FROM teams_conversation_refs WHERE conversation_id = '19:legacy@thread.v2'`,
    );
    assert.equal(row.rowCount, 1, 'legacy row must survive the upgrade');
    assert.equal(row.rows[0]?.bot_app_id, '', "legacy row must carry the default-bot sentinel ''");
  });

  it('composite key holds one row per bot for the same conversation', async () => {
    const upsert = `
      INSERT INTO teams_conversation_refs (conversation_id, bot_app_id, ref)
      VALUES ($1, $2, $3)
      ON CONFLICT (conversation_id, bot_app_id)
      DO UPDATE SET ref = EXCLUDED.ref, updated_at = now()`;
    const ref = (tag: string) => ({ serviceUrl: `https://smba.trafficmanager.net/de/${tag}` });

    await pool.query(upsert, ['19:legacy@thread.v2', 'aaaaaaaa-1111-2222-3333-444444444444', ref('bot-a')]);
    await pool.query(upsert, ['19:legacy@thread.v2', 'bbbbbbbb-1111-2222-3333-444444444444', ref('bot-b')]);
    // updating bot A's row must not touch bot B's
    await pool.query(upsert, ['19:legacy@thread.v2', 'aaaaaaaa-1111-2222-3333-444444444444', ref('bot-a2')]);

    const rows = await pool.query<{ bot_app_id: string; ref: { serviceUrl: string } }>(
      `SELECT bot_app_id, ref FROM teams_conversation_refs
        WHERE conversation_id = '19:legacy@thread.v2' AND bot_app_id <> ''
        ORDER BY bot_app_id`,
    );
    assert.equal(rows.rowCount, 2);
    assert.match(rows.rows[0]?.ref.serviceUrl ?? '', /bot-a2$/);
    assert.match(rows.rows[1]?.ref.serviceUrl ?? '', /bot-b$/);
  });
});
