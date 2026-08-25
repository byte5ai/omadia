import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { SERVICE_USER_KEY } from '../src/services/mcpDelegation.js';

/**
 * Migration 0031 (W0-1, D2) — the delegation BACKFILL predicate, against a REAL
 * Postgres.
 *
 * ─── What went wrong ────────────────────────────────────────────────────────
 *
 * The backfill's stated intent (0031's own header) is "existing rows that
 * already hold an operator token keep today's shared behaviour". The SQL tested
 * for ANY token row:
 *
 *     WHERE EXISTS (SELECT 1 FROM mcp_oauth_tokens t WHERE t.server_id = s.id)
 *
 * `mcp_oauth_tokens` is keyed `(server_id, user_key)`, so a server holding only
 * `user_key = 'alice@corp.com'` matched and was flipped to `delegation =
 * 'service'`. That is a silent identity change: `resolveMcpUserKey` then hands
 * the shared `operator` key to EVERY caller of that server. The immediate
 * symptom is fail-closed breakage (no operator token exists to resolve), but the
 * lasting one is worse — once anyone completes a re-auth, the minted operator
 * token is shared by every caller, including the unmapped channel users the
 * confused-deputy fix exists to stop.
 *
 * ─── Isolation rules this file obeys ────────────────────────────────────────
 *
 *  1. A dedicated SCHEMA, never a scratch DATABASE. `CREATE/DROP DATABASE` are
 *     cluster-wide and abort other connections; a previous run cancelled 29
 *     tests in concurrent files that way.
 *  2. A dedicated tenant id in the schema name — the suites here share one
 *     cluster and run concurrently, and the migration-runner advisory lock is
 *     database-wide.
 *  3. `search_path` pinned as a CONNECTION OPTION, not via `SET`. A `SET` binds
 *     only the pooled client that served it, so the next query would silently
 *     resolve against `public`.
 *
 * Only the tables 0031 touches are hand-built, at migrations 0003/0009/0015
 * shapes — not the whole chain. What is under test is 0031's own DML.
 *
 * ─── The migration text is used verbatim ────────────────────────────────────
 *
 * 0031 used to guard its backfill with `to_regclass('public.mcp_oauth_tokens')`
 * — the one schema-QUALIFIED reference in a file that is otherwise entirely
 * unqualified. Under rule 1 the tables live in the tenant schema, so that guard
 * answered about a table this migration never touches, and this file had to
 * rewrite the literal before running it. The guard is now unqualified and
 * resolves through `search_path` like everything else, so the file is applied
 * AS SHIPPED and `migrationSql()` fails loudly if an executable `public.`-
 * qualified reference is ever reintroduced — a silent short-circuit would
 * otherwise make every assertion below pass vacuously.
 */

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'mcpDelegationBackfillMigration',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

/** Dedicated tenant id → dedicated schema. See rule 2 above. */
const TENANT = `w4_deleg_${process.pid}_${Date.now().toString(36)}`;

const MIGRATION_PATH = new URL('../migrations/0031_mcp_oauth_iss_delegation.sql', import.meta.url);

function stripWholeLineSqlComments(sql: string): string {
  // Whole-line `--` stripping is sufficient for this file: the migration's
  // false positives live in prose comments, and its executable statements do
  // not use trailing `--` comments that would need SQL-aware parsing.
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/** The migration text, applied verbatim. See the header for why no rewrite is
 *  needed, and what the public-qualified guard protects. */
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

describe('migration 0031 — delegation backfill predicate (pg)', { skip: !pgAvailable }, () => {
  let admin: Pool;
  let pool: Pool;

  before(async () => {
    admin = new Pool({ connectionString: PG_URL });
    await admin.query(`CREATE SCHEMA "${TENANT}"`);
    pool = new Pool({ connectionString: PG_URL, options: `-c search_path=${TENANT}` });

    // The tables 0031 alters, at their pre-0031 shapes.
    await pool.query(`
      CREATE TABLE mcp_servers (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name       TEXT NOT NULL UNIQUE,
        transport  TEXT NOT NULL CHECK (transport IN ('stdio', 'http', 'sse')),
        endpoint   TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE mcp_oauth_tokens (
        server_id        UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        user_key         TEXT NOT NULL,
        access_token_ref TEXT NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (server_id, user_key)
      );
      CREATE TABLE mcp_oauth_flows (
        state         TEXT PRIMARY KEY,
        server_id     UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        user_key      TEXT NOT NULL,
        issuer        TEXT NOT NULL,
        code_verifier TEXT NOT NULL,
        redirect_uri  TEXT NOT NULL
      );
      CREATE TABLE mcp_call_log (
        id          BIGSERIAL PRIMARY KEY,
        server_name TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        ok          BOOLEAN NOT NULL,
        duration_ms INTEGER NOT NULL
      );
    `);

    // Four servers spanning the whole predicate space. Populated BEFORE the
    // migration runs, so the backfill is proven on a non-empty table.
    await pool.query(`
      INSERT INTO mcp_servers (name, transport, endpoint) VALUES
        ('operator-only',  'http', 'https://a.example'),
        ('per-user-only',  'http', 'https://b.example'),
        ('mixed',          'http', 'https://c.example'),
        ('no-tokens',      'http', 'https://d.example')
    `);
    await pool.query(
      `INSERT INTO mcp_oauth_tokens (server_id, user_key, access_token_ref)
       SELECT s.id, k.user_key, 'vault://' || s.name || '/' || k.user_key
         FROM mcp_servers s
         JOIN (VALUES
                 ('operator-only', $1),
                 ('per-user-only', 'alice@corp.com'),
                 ('mixed',         'bob@corp.com'),
                 ('mixed',         $1)
              ) AS k(server_name, user_key) ON k.server_name = s.name`,
      [SERVICE_USER_KEY],
    );

    await pool.query(await migrationSql());
  });

  after(async () => {
    // Schema-scoped teardown. No CREATE/DROP DATABASE anywhere.
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${TENANT}" CASCADE`);
    await admin.end();
  });

  async function delegationOf(name: string): Promise<string | undefined> {
    const { rows } = await pool.query<{ delegation: string }>(
      `SELECT delegation FROM mcp_servers WHERE name = $1`,
      [name],
    );
    return rows[0]?.delegation;
  }

  async function applyMigration(): Promise<void> {
    await pool.query(await migrationSql());
  }

  async function hasDelegationConstraint(): Promise<boolean> {
    const { rows } = await pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_constraint
          WHERE conname = 'mcp_servers_delegation_chk'
            AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)
            AND conrelid = 'mcp_servers'::regclass
       ) AS present`,
      [TENANT],
    );
    return rows[0]?.present ?? false;
  }

  async function ensureDelegationConstraint(): Promise<void> {
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'mcp_servers_delegation_chk'
             AND conrelid = 'mcp_servers'::regclass
        ) THEN
          ALTER TABLE mcp_servers
            ADD CONSTRAINT mcp_servers_delegation_chk
            CHECK (delegation IN ('per_user', 'service'));
        END IF;
      END $$;
    `);
  }

  it('does NOT flip a server holding only a NON-operator token', async () => {
    // THE regression. The broad `EXISTS (… WHERE server_id = s.id)` predicate
    // matched this row and handed every future caller the shared operator key.
    assert.equal(
      await delegationOf('per-user-only'),
      'per_user',
      'a per-user server was silently converted to a shared service identity',
    );
  });

  it('DOES flip a server holding an operator token — the grandfathering still works', async () => {
    // The other half. Narrowing the predicate must not break the compatibility
    // the migration exists to provide: these installs work TODAY only because of
    // the `?? operator` fallback D2 removes.
    assert.equal(await delegationOf('operator-only'), 'service');
  });

  it('flips a MIXED server — one operator token is enough, other user keys do not veto it', async () => {
    assert.equal(await delegationOf('mixed'), 'service');
  });

  it('leaves a token-less server on the safe per_user default', async () => {
    assert.equal(await delegationOf('no-tokens'), 'per_user');
  });

  it('uses the SAME literal the runtime resolves as the shared key', async () => {
    // The migration cannot import `SERVICE_USER_KEY`, so the two literals can
    // drift. If they ever do, the backfill grandfathers a different set of
    // servers than the runtime can actually resolve tokens for.
    const executable = stripWholeLineSqlComments(await readFile(MIGRATION_PATH, 'utf8'));
    assert.equal(SERVICE_USER_KEY, 'operator');
    assert.match(executable, new RegExp(`user_key\\s*=\\s*'${SERVICE_USER_KEY}'`));
  });

  // These two used to be a documented NOT-TESTED hole. 0031 guarded its ALTER
  // with `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = …)` — no
  // relation and no namespace filter, so the lookup was cluster-wide. Under the
  // per-suite schema isolation this file requires, a CONCURRENT pg suite that
  // created the constraint in ITS schema made the guard true here and the
  // constraint was skipped in ours: the assertion passed in isolation and failed
  // in the full-suite run. The guard is now anchored on
  // `conrelid = 'mcp_servers'::regclass`, so the coverage is real, and the
  // assertions below are scoped to THIS suite's schema for the same reason.

  it('creates the delegation CHECK in THIS schema, not merely somewhere in the cluster', async () => {
    assert.equal(
      await hasDelegationConstraint(),
      true,
      'the CHECK was skipped in this schema — the guard matched a constraint owned by another schema',
    );
  });

  it('the created CHECK actually constrains — an unknown delegation mode is rejected', async () => {
    // Existence alone would still pass if the constraint were created empty or
    // over the wrong column. This proves the predicate 0031 claims to install.
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO mcp_servers (name, transport, endpoint, delegation)
           VALUES ('bad-delegation', 'http', 'https://e.example', 'telepathy')`,
        ),
      (err: unknown) => {
        const pgErr = err as { code?: string; constraint?: string };
        assert.equal(pgErr.code, '23514');
        assert.equal(pgErr.constraint, 'mcp_servers_delegation_chk');
        return true;
      },
      'delegation accepted a value outside (per_user, service)',
    );
  });

  it('re-applying preserves an operator opt-in from service back to per_user', async () => {
    try {
      await pool.query(`UPDATE mcp_servers SET delegation = 'per_user' WHERE name = 'operator-only'`);
      await applyMigration();
      assert.equal(
        await delegationOf('operator-only'),
        'per_user',
        're-applying 0031 silently overrode an operator opt-in back to service',
      );
    } finally {
      await pool.query(`UPDATE mcp_servers SET delegation = 'service' WHERE name = 'operator-only'`);
    }
  });

  it('re-applying recreates the delegation CHECK even when the column already exists', async () => {
    let dropped = false;
    try {
      await pool.query(`ALTER TABLE mcp_servers DROP CONSTRAINT mcp_servers_delegation_chk`);
      dropped = true;
      assert.equal(await hasDelegationConstraint(), false);
      await applyMigration();
      assert.equal(
        await hasDelegationConstraint(),
        true,
        'the top-level CHECK guard stopped repairing a table that already had the delegation column',
      );
    } finally {
      if (dropped) {
        await ensureDelegationConstraint();
      }
    }
  });

  it('is idempotent — re-applying flips nothing further', async () => {
    // A second run must be a no-op, not a second chance to convert a per-user
    // server (e.g. if one acquired an operator token in between, that is a real
    // change; if not, nothing may move).
    await applyMigration();
    assert.equal(await delegationOf('per-user-only'), 'per_user');
    assert.equal(await delegationOf('operator-only'), 'service');
    assert.equal(await delegationOf('no-tokens'), 'per_user');
  });
});

/**
 * ─── W0c schema-fit gate (#860) — per-agent grants need NO migration ────────
 *
 * Epic #860's per-agent capability UIs (#861 plugins/tool grants, #862 MCP
 * assignment) build on the schema AS IT STANDS:
 *
 *   • `agent_tool_grants` (0003) is the per-agent MCP assignment — one row per
 *     grant, identity `(agent_id, mcp_server_id, tool_ref)` made unique for
 *     top-level MCP grants by 0014.
 *   • `plugin_mcp_grants` (0012) is the plugin sibling (plugins have no
 *     agents-table row — decision recorded on #458).
 *   • `delegation` lives on `mcp_servers` ONLY (0031). #862's literal wording
 *     "delegation choice per assignment" would require per-(agent, server)
 *     storage that does not exist; the coordinator resolved that drift:
 *     delegation STAYS per-server, the assignment UI displays it read-only and
 *     links to the per-server setting, whose global effect must be labeled.
 *
 * These tests pin that decision. If one fails, someone widened delegation to
 * per-assignment (or moved the grant tables) — that is a design change with
 * its own migration and review, not something a UI wave may do as a side
 * effect. Static file scans only, so the gate holds even where no Postgres is
 * reachable and the suite above is skipped.
 */
describe('W0c schema-fit gate — delegation stays per-server (#860)', () => {
  const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);

  async function executableMigrations(): Promise<ReadonlyMap<string, string>> {
    const names = (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort();
    const entries = await Promise.all(
      names.map(async (name): Promise<readonly [string, string]> => {
        const raw = await readFile(new URL(name, MIGRATIONS_DIR), 'utf8');
        return [name, stripWholeLineSqlComments(raw)];
      }),
    );
    return new Map(entries);
  }

  it('no migration but 0031 touches `delegation` — no per-assignment storage exists', async () => {
    const migrations = await executableMigrations();
    const mentioning = [...migrations]
      .filter(([, sql]) => /\bdelegation\b/i.test(sql))
      .map(([name]) => name);
    assert.deepEqual(
      mentioning,
      ['0031_mcp_oauth_iss_delegation.sql'],
      'a migration beyond 0031 introduces delegation DDL — the #860 per-server decision was overturned without a design pass',
    );
  });

  it('0031 attaches `delegation` to mcp_servers and never to a grant table', async () => {
    const sql = (await executableMigrations()).get('0031_mcp_oauth_iss_delegation.sql');
    assert.ok(sql, 'migration 0031 is missing');
    assert.match(sql, /ALTER TABLE mcp_servers\s+ADD COLUMN delegation TEXT NOT NULL DEFAULT 'per_user'/);
    assert.doesNotMatch(
      sql,
      /agent_tool_grants|plugin_mcp_grants/,
      '0031 must not reach into the grant tables — delegation is a server property',
    );
  });

  it('agent_tool_grants (0003) carries the per-agent MCP assignment — and no delegation column', async () => {
    const sql = (await executableMigrations()).get('0003_agent_builder_graph.sql');
    assert.ok(sql, 'migration 0003 is missing');
    const createTable = /CREATE TABLE IF NOT EXISTS agent_tool_grants \(([^;]+)\);/.exec(sql)?.[1];
    assert.ok(createTable, '0003 no longer creates agent_tool_grants');
    for (const column of ['agent_id', 'subagent_id', 'tool_kind', 'tool_ref', 'mcp_server_id']) {
      assert.match(createTable, new RegExp(`\\b${column}\\b`), `agent_tool_grants lost the ${column} column`);
    }
    assert.doesNotMatch(
      createTable,
      /\bdelegation\b/i,
      'agent_tool_grants gained a delegation column — per-assignment delegation needs its own design pass, not this table',
    );
  });

  it('plugin_mcp_grants (0012) is keyed (plugin_id, mcp_server_id) — and no delegation column', async () => {
    const sql = (await executableMigrations()).get('0012_plugin_mcp_grants.sql');
    assert.ok(sql, 'migration 0012 is missing');
    assert.match(sql, /PRIMARY KEY \(plugin_id, mcp_server_id\)/);
    assert.doesNotMatch(sql, /\bdelegation\b/i);
  });

  it('0014 pins the grant identity the per-agent UI builds on: (agent_id, mcp_server_id, tool_ref)', async () => {
    const sql = (await executableMigrations()).get('0014_mcp_grant_unique.sql');
    assert.ok(sql, 'migration 0014 is missing');
    assert.match(
      sql,
      /ON agent_tool_grants \(agent_id, mcp_server_id, tool_ref\)\s+WHERE agent_id IS NOT NULL AND tool_kind = 'mcp'/,
      'the top-level MCP grant identity changed — #861/#862 assignment semantics must be re-reviewed',
    );
  });
});
