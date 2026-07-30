import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { Pool, type PoolClient } from 'pg';

import { runMultiOrchestratorMigrations } from '@omadia/orchestrator';

/**
 * PG-gated coverage for the MCP registry / OAuth schema in
 * `middleware/migrations` (0010 registries, 0013 registry kinds, 0014 the
 * top-level grant unique index, 0015/0016 OAuth 2.1 + PKCE).
 *
 * Context (W0-4): `middleware/migrations` was absent from the CI `schema`
 * job's MIGRATION_DOMAINS, so every MCP migration shipped without ever being
 * applied or idempotency-checked in CI, and no pg test covered MCP at all.
 * Adding the domain closes the apply/re-apply gap; this file closes the
 * behavioural gap and adds the one check CI structurally cannot make — the
 * CI gate re-applies against an EMPTY database, which cannot catch a
 * migration that is only non-idempotent once rows exist.
 *
 * Isolation: every row this suite writes carries the `w04-mcp-` tenant
 * prefix so it cannot collide with the other pg suites sharing the database.
 * The destructive re-apply check needs more than a prefix — re-running
 * 0001/0003 drops and recreates the NOTIFY triggers, taking ACCESS EXCLUSIVE
 * on shared tables — so it runs against its own schema with `public` off the
 * search_path. A scratch *database* would also isolate it, but CREATE/DROP
 * DATABASE is a cluster-wide operation: it stalled the concurrently running
 * dev-platform pg suites long enough to cancel 29 of their tests.
 * Skips when no test Postgres is reachable, mirroring the other pg tests.
 */
const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['WS5_PG_TEST_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

/** Tenant prefix — unique to this suite, see the isolation note above. */
const TENANT = 'w04-mcp-';
/** Schema the re-apply check builds its own copy of the domain in. */
const REAPPLY_SCHEMA = 'w04_mcp_reapply';

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * One capped pool for the whole file. The test runner executes files
 * concurrently and ~16 other pg suites each hold a default-sized (max 10)
 * pool, so an uncapped extra pool here is enough to exhaust
 * `max_connections` and cancel an unrelated suite mid-flight.
 */
const probePool = new Pool({
  connectionString: PG_URL,
  connectionTimeoutMillis: 2000,
  max: 2,
  idleTimeoutMillis: 1000,
});
let pgAvailable = true;
try {
  await probePool.query('SELECT 1');
} catch {
  pgAvailable = false;
  await probePool.end().catch(() => undefined);
}

async function migrationFiles(): Promise<readonly string[]> {
  return (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
}

/** Postgres error code for a statement that violated a constraint we assert on. */
async function expectRejected(pool: Pool, sql: string, params: readonly unknown[] = []) {
  try {
    await pool.query(sql, [...params]);
  } catch (err: unknown) {
    return err as { code?: string };
  }
  assert.fail(`expected the statement to be rejected: ${sql}`);
}

describe('MCP registry + OAuth schema (pg)', { skip: !pgAvailable }, () => {
  const pool = probePool;

  async function cleanup(): Promise<void> {
    // mcp_servers cascades to oauth tokens/flows and to agent_tool_grants;
    // agents cascades to its grants. Registries are referenced by
    // mcp_servers.registry_id with ON DELETE SET NULL, so order matters only
    // for readability here.
    await pool.query('DELETE FROM mcp_servers WHERE name LIKE $1', [`${TENANT}%`]);
    await pool.query('DELETE FROM agents WHERE slug LIKE $1', [`${TENANT}%`]);
    await pool.query('DELETE FROM mcp_registries WHERE name LIKE $1', [`${TENANT}%`]);
    await pool.query('DELETE FROM mcp_oauth_clients WHERE issuer LIKE $1', [`${TENANT}%`]);
  }

  before(async () => {
    await runMultiOrchestratorMigrations(pool, undefined, migrationsDir);
    await cleanup();
  });

  // The pool is shared with the re-apply suite below, so it is closed by the
  // file-level `after` hook rather than here.
  after(cleanup);

  it('seeds the official and smithery registries with their catalog kinds (0010 + 0013)', async () => {
    const { rows } = await pool.query<{ name: string; kind: string; auth_kind: string }>(
      `SELECT name, kind, auth_kind FROM mcp_registries
        WHERE name IN ('official', 'smithery') ORDER BY name`,
    );

    // 0010 seeds `official` before 0013 adds `kind`; 0013's UPDATE is what
    // lifts it off the 'generic' column default. A silent no-op there would
    // leave the official registry using the wrong catalog normalizer.
    assert.deepEqual(
      rows.map((r) => [r.name, r.kind, r.auth_kind]),
      [
        ['official', 'official', 'none'],
        ['smithery', 'smithery', 'none'],
      ],
    );
  });

  it('constrains registry kind and auth_kind to the known sets (0010 + 0013)', async () => {
    const badKind = await expectRejected(
      pool,
      `INSERT INTO mcp_registries (name, url, auth_kind, kind)
       VALUES ($1, 'https://reg.invalid', 'none', 'not-a-kind')`,
      [`${TENANT}bad-kind`],
    );
    assert.equal(badKind.code, '23514', 'unknown registry kind must fail the CHECK');

    const badAuth = await expectRejected(
      pool,
      `INSERT INTO mcp_registries (name, url, auth_kind)
       VALUES ($1, 'https://reg.invalid', 'basic')`,
      [`${TENANT}bad-auth`],
    );
    assert.equal(badAuth.code, '23514', 'unknown registry auth_kind must fail the CHECK');
  });

  it('defaults marketplace provenance to manual and detaches on registry delete (0010)', async () => {
    const registry = await pool.query<{ id: string }>(
      `INSERT INTO mcp_registries (name, url, auth_kind, kind)
       VALUES ($1, 'https://reg.invalid', 'none', 'generic') RETURNING id`,
      [`${TENANT}registry`],
    );
    const registryId = registry.rows[0]!.id;

    const server = await pool.query<{ id: string; source: string; registry_id: string | null }>(
      `INSERT INTO mcp_servers (name, transport, endpoint)
       VALUES ($1, 'http', 'https://srv.invalid/mcp')
       RETURNING id, source, registry_id`,
      [`${TENANT}server`],
    );
    assert.equal(server.rows[0]!.source, 'manual', 'pre-marketplace rows are implicitly manual');
    assert.equal(server.rows[0]!.registry_id, null);

    const badSource = await expectRejected(
      pool,
      `UPDATE mcp_servers SET source = 'somewhere-else' WHERE id = $1`,
      [server.rows[0]!.id],
    );
    assert.equal(badSource.code, '23514', 'source is restricted to manual|marketplace');

    await pool.query(`UPDATE mcp_servers SET source = 'marketplace', registry_id = $1 WHERE id = $2`, [
      registryId,
      server.rows[0]!.id,
    ]);

    // Deleting a catalog source must orphan the imported server, not delete it.
    await pool.query('DELETE FROM mcp_registries WHERE id = $1', [registryId]);
    const after = await pool.query<{ source: string; registry_id: string | null }>(
      'SELECT source, registry_id FROM mcp_servers WHERE id = $1',
      [server.rows[0]!.id],
    );
    assert.equal(after.rows[0]!.registry_id, null, 'ON DELETE SET NULL must keep the server row');
    assert.equal(after.rows[0]!.source, 'marketplace');
  });

  it('rejects a duplicate top-level MCP grant but not the sub-agent equivalent (0014)', async () => {
    const agent = await pool.query<{ id: string }>(
      `INSERT INTO agents (slug, name) VALUES ($1, 'W0-4 MCP Agent') RETURNING id`,
      [`${TENANT}agent`],
    );
    const server = await pool.query<{ id: string }>(
      `INSERT INTO mcp_servers (name, transport, endpoint)
       VALUES ($1, 'http', 'https://srv.invalid/mcp') RETURNING id`,
      [`${TENANT}grant-server`],
    );
    const agentId = agent.rows[0]!.id;
    const serverId = server.rows[0]!.id;
    const toolRef = `${TENANT}grant-server:ping`;

    const insertTopLevel = `INSERT INTO agent_tool_grants (agent_id, tool_kind, tool_ref, mcp_server_id)
                            VALUES ($1, 'mcp', $2, $3)`;
    await pool.query(insertTopLevel, [agentId, toolRef, serverId]);

    const dup = await expectRejected(pool, insertTopLevel, [agentId, toolRef, serverId]);
    assert.equal(dup.code, '23505', 'the partial unique index must block a repeat grant');

    // The index is scoped to `agent_id IS NOT NULL AND tool_kind = 'mcp'`:
    // a native grant on the same agent must stay unaffected.
    await pool.query(
      `INSERT INTO agent_tool_grants (agent_id, tool_kind, tool_ref) VALUES ($1, 'native', $2)`,
      [agentId, toolRef],
    );
    await pool.query(
      `INSERT INTO agent_tool_grants (agent_id, tool_kind, tool_ref) VALUES ($1, 'native', $2)`,
      [agentId, toolRef],
    );

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM agent_tool_grants WHERE agent_id = $1',
      [agentId],
    );
    assert.equal(rows[0]!.count, '3', 'one mcp grant plus two unconstrained native grants');
  });

  it('binds an OAuth flow to its authorize-time endpoints and cascades on server delete (0015 + 0016)', async () => {
    const server = await pool.query<{ id: string }>(
      `INSERT INTO mcp_servers (name, transport, endpoint)
       VALUES ($1, 'http', 'https://oauth.invalid/mcp') RETURNING id`,
      [`${TENANT}oauth-server`],
    );
    const serverId = server.rows[0]!.id;
    const issuer = `${TENANT}https://issuer.invalid`;

    await pool.query(
      `INSERT INTO mcp_oauth_clients (issuer, client_id, registered_via) VALUES ($1, 'cid', 'dcr')`,
      [issuer],
    );
    const badRegistration = await expectRejected(
      pool,
      `INSERT INTO mcp_oauth_clients (issuer, client_id, registered_via) VALUES ($1, 'cid', 'guessed')`,
      [`${TENANT}https://issuer2.invalid`],
    );
    assert.equal(badRegistration.code, '23514', 'registered_via is restricted to dcr|manual');

    await pool.query(
      `INSERT INTO mcp_oauth_tokens (server_id, user_key, access_token_ref)
       VALUES ($1, $2, 'vault://access')`,
      [serverId, `${TENANT}user`],
    );
    // 0016: the token endpoint is persisted at authorize time so the callback
    // cannot be redirected to a re-discovered (attacker-swapped) endpoint.
    await pool.query(
      `INSERT INTO mcp_oauth_flows
         (state, server_id, user_key, issuer, code_verifier, redirect_uri,
          token_endpoint, authorization_endpoint)
       VALUES ($1, $2, $3, $4, 'verifier', 'https://cb.invalid',
               'https://issuer.invalid/token', 'https://issuer.invalid/authorize')`,
      [`${TENANT}state`, serverId, `${TENANT}user`, issuer],
    );

    const flow = await pool.query<{ token_endpoint: string; authorization_endpoint: string }>(
      'SELECT token_endpoint, authorization_endpoint FROM mcp_oauth_flows WHERE state = $1',
      [`${TENANT}state`],
    );
    assert.equal(flow.rows[0]!.token_endpoint, 'https://issuer.invalid/token');
    assert.equal(flow.rows[0]!.authorization_endpoint, 'https://issuer.invalid/authorize');

    // Deleting the server must not leave live credentials or pending flows behind.
    await pool.query('DELETE FROM mcp_servers WHERE id = $1', [serverId]);
    const tokens = await pool.query('SELECT 1 FROM mcp_oauth_tokens WHERE server_id = $1', [serverId]);
    const flows = await pool.query('SELECT 1 FROM mcp_oauth_flows WHERE server_id = $1', [serverId]);
    assert.equal(tokens.rowCount, 0, 'tokens must cascade with the server');
    assert.equal(flows.rowCount, 0, 'pending flows must cascade with the server');
  });
});

describe('middleware/migrations idempotency under data (pg)', { skip: !pgAvailable }, () => {
  /**
   * Runs against a dedicated schema on a single pinned connection, with
   * `public` deliberately absent from the search_path: the migrations name
   * every object unqualified, so they build a private copy of the domain here
   * and never touch — or lock — the shared tables the other pg suites use.
   */
  let client: PoolClient | undefined;

  before(async () => {
    client = await probePool.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${REAPPLY_SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${REAPPLY_SCHEMA}`);
    await client.query(`SET search_path = ${REAPPLY_SCHEMA}`);
  });

  after(async () => {
    if (!client) return;
    await client.query('RESET search_path').catch(() => undefined);
    await client.query(`DROP SCHEMA IF EXISTS ${REAPPLY_SCHEMA} CASCADE`).catch(() => undefined);
    client.release();
  });

  it('re-applies every migration cleanly with rows present', async () => {
    const pool = client!;
    const files = await migrationFiles();
    assert.ok(files.length > 0, 'expected migrations to be discovered');

    // Pass 1 — virgin schema. `middleware/migrations` needs no extensions
    // (gen_random_uuid is core since pg13) and has no cross-domain FKs, which
    // is why this domain can be applied standalone.
    for (const file of files) {
      await pool.query(await readFile(join(migrationsDir, file), 'utf8'));
    }

    // Guard the isolation itself: if search_path had leaked to `public` the
    // migrations would have been no-ops against the shared tables and every
    // assertion below would pass vacuously.
    const built = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = $1`,
      [REAPPLY_SCHEMA],
    );
    assert.ok(
      Number(built.rows[0]!.count) > 25,
      `expected the domain to be built inside ${REAPPLY_SCHEMA}, saw ${built.rows[0]!.count} tables`,
    );

    // Seed the MCP + dev-platform surfaces so the re-apply runs against real
    // rows — the case the CI gate cannot reach, since it re-applies empty.
    const server = await pool.query<{ id: string }>(
      `INSERT INTO mcp_servers (name, transport, endpoint)
       VALUES ($1, 'http', 'https://srv.invalid/mcp') RETURNING id`,
      [`${TENANT}reapply-server`],
    );
    const agent = await pool.query<{ id: string }>(
      `INSERT INTO agents (slug, name) VALUES ($1, 'W0-4 Scratch') RETURNING id`,
      [`${TENANT}reapply-agent`],
    );
    await pool.query(
      `INSERT INTO mcp_registries (name, url, auth_kind, kind)
       VALUES ($1, 'https://reg.invalid', 'none', 'generic')`,
      [`${TENANT}reapply-registry`],
    );
    await pool.query(
      `INSERT INTO agent_tool_grants (agent_id, tool_kind, tool_ref, mcp_server_id)
       VALUES ($1, 'mcp', $2, $3)`,
      [agent.rows[0]!.id, `${TENANT}reapply-server:ping`, server.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO mcp_oauth_clients (issuer, client_id, registered_via)
       VALUES ($1, 'cid', 'manual')`,
      [`${TENANT}https://reapply-issuer.invalid`],
    );
    await pool.query(
      `INSERT INTO mcp_oauth_tokens (server_id, user_key, access_token_ref)
       VALUES ($1, $2, 'vault://access')`,
      [server.rows[0]!.id, `${TENANT}user`],
    );

    // Pass 2 — the CI idempotency gate, but with the rows above in place.
    for (const file of files) {
      await pool.query(await readFile(join(migrationsDir, file), 'utf8'));
    }

    // The seeded rows must survive, and the seed INSERTs in 0010/0013 must not
    // have duplicated their registries.
    const registries = await pool.query<{ name: string }>(
      `SELECT name FROM mcp_registries WHERE name IN ('official', 'smithery')`,
    );
    assert.equal(registries.rowCount, 2, 'ON CONFLICT DO NOTHING keeps the seed rows unique');

    const grants = await pool.query('SELECT 1 FROM agent_tool_grants WHERE agent_id = $1', [
      agent.rows[0]!.id,
    ]);
    assert.equal(grants.rowCount, 1, 're-applying must not drop or duplicate existing grants');

    const tokens = await pool.query('SELECT 1 FROM mcp_oauth_tokens WHERE server_id = $1', [
      server.rows[0]!.id,
    ]);
    assert.equal(tokens.rowCount, 1, 're-applying must not disturb stored OAuth token refs');
  });
});

// Both suites share the single capped pool, so it is closed once, here.
after(async () => {
  if (pgAvailable) await probePool.end().catch(() => undefined);
});
