/**
 * #575 phase 2 — the grant store against a real Postgres.
 *
 * The failure semantics (throw rather than answer) are pinned in
 * `audienceGrantStore.test.ts` with a fake pool, because an unreachable
 * database is easier to fake than to arrange. What a fake pool CANNOT prove is
 * that the SQL is right: that the primary keys make a re-grant idempotent
 * rather than a 23505, that a delete reports whether it removed anything, and
 * that a grant written through the admin path is found by the lookup the floor
 * actually calls.
 *
 * That last one is the point of the whole file. Writes and reads canonicalise
 * independently — user references lower-case, role keys keep their case (#333
 * phase 1) — and if those two ever disagree, every test that only checks one
 * side stays green while the floor silently stops honouring grants an operator
 * can plainly see in the admin list.
 *
 * Skips cleanly (issue #572: no hardcoded default port) when no test database
 * is configured.
 */

import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { makePrincipal, resolveCapabilities, RoleSourceRegistry } from '@omadia/channel-sdk';
import type { Principal } from '@omadia/channel-sdk';
import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { PostgresGrantStore } from '../src/audience/postgresGrantStore.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'postgresGrantStore',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

/** The two tables from migration 0035, created directly so this suite does not
 *  depend on the multi-orchestrator migrator having run against the test DB. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS audience_direct_grants (
  principal_kind TEXT        NOT NULL,
  principal_ref  TEXT        NOT NULL,
  capability     TEXT        NOT NULL,
  granted_by     TEXT        NOT NULL,
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_kind, principal_ref, capability)
);
CREATE TABLE IF NOT EXISTS audience_role_grants (
  role_key   TEXT        NOT NULL,
  capability TEXT        NOT NULL,
  granted_by TEXT        NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role_key, capability)
);`;

describe('#575 PostgresGrantStore against a real Postgres', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: PostgresGrantStore;
  // Unique per run so concurrent test files cannot collide on shared tables.
  const mark = randomUUID().slice(0, 8);
  const alice = makePrincipal('user', `Alice-${mark}@Example.com`) as Principal;
  const roleKey = `Approver-${mark}`;

  before(async () => {
    pool = new Pool({ connectionString: PG_URL, max: 4 });
    await pool.query(SCHEMA);
    store = new PostgresGrantStore(pool);
  });

  after(async () => {
    await pool.query(`DELETE FROM audience_direct_grants WHERE principal_ref LIKE $1`, [
      `%${mark}%`,
    ]);
    await pool.query(`DELETE FROM audience_role_grants WHERE role_key LIKE $1`, [`%${mark}%`]);
    await pool.end();
  });

  it('a grant written through the admin path is found by the floor lookup', async () => {
    await store.grantToPrincipal(alice, 'tool:send_email', 'operator@example.com');
    assert.deepEqual([...(await store.directGrants(alice))], ['tool:send_email']);
  });

  it('finds the grant through a differently-cased spelling of the same user', async () => {
    // The whole reason canonicalisation is applied on BOTH sides: a channel may
    // hand over `ALICE@EXAMPLE.COM` where the operator typed `Alice@…`.
    const shouty = makePrincipal('user', `ALICE-${mark}@EXAMPLE.COM`) as Principal;
    assert.deepEqual([...(await store.directGrants(shouty))], ['tool:send_email']);
  });

  it('re-granting is idempotent and refreshes the trail rather than failing', async () => {
    await store.grantToPrincipal(alice, 'tool:send_email', 'second-operator@example.com');
    const rows = (await store.listDirectGrants()).filter((r) => r.principalRef.includes(mark));
    assert.equal(rows.length, 1, 'the primary key must collapse a repeat grant into one row');
    assert.equal(rows[0]?.grantedBy, 'second-operator@example.com');
  });

  it('keeps a role key case-sensitive, matching conductor_roles', async () => {
    await store.grantToRole(roleKey, 'memory:recall', 'operator@example.com');
    assert.deepEqual([...(await store.roleGrants(roleKey))], ['memory:recall']);
    // Lower-casing role keys would make this find the grant — it must not.
    assert.deepEqual([...(await store.roleGrants(roleKey.toLowerCase()))], []);
  });

  it('reports honestly whether a revoke removed anything', async () => {
    assert.equal(await store.revokeFromRole(roleKey, 'never:granted'), false);
    assert.equal(await store.revokeFromRole(roleKey, 'memory:recall'), true);
    assert.deepEqual([...(await store.roleGrants(roleKey))], []);
  });

  it('feeds resolveCapabilities the union of what it stored', async () => {
    // End to end through the real consumer, with no role sources registered:
    // direct grants alone must produce a RESOLVED member (not `undefined`),
    // because an empty role registry is a complete answer, not a partial one.
    await store.grantToPrincipal(alice, 'memory:recall', 'operator@example.com');
    const member = await resolveCapabilities(alice, new RoleSourceRegistry(), store);
    assert.ok(member, 'a reachable store with no role sources must resolve');
    assert.deepEqual(
      [...member.capabilities].sort(),
      ['memory:recall', 'tool:send_email'],
    );
  });

  it('revokes a direct grant', async () => {
    assert.equal(await store.revokeFromPrincipal(alice, 'memory:recall'), true);
    assert.equal(await store.revokeFromPrincipal(alice, 'memory:recall'), false);
    assert.deepEqual([...(await store.directGrants(alice))], ['tool:send_email']);
  });
});
