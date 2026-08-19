/**
 * #575 phase 2 — the grant store's failure semantics.
 *
 * The round-trip behaviour is exercised against a real Postgres in
 * `postgresGrantStore.pg.test.ts`. This file covers the two properties that
 * matter more and that a database cannot easily be made to demonstrate: what
 * happens when the store **cannot answer**.
 *
 * Both are load-bearing in the same direction. `GrantStore`'s contract says a
 * store that cannot answer must throw, because `resolveCapabilities` converts a
 * throw into an `unresolved` audience member and closes the floor WITH A REASON.
 * A store that swallowed the failure and returned `[]` would hand the floor a
 * perfectly well-formed smaller capability set instead — the room would narrow
 * silently, and an operator reading "the floor forbids it" would have no way to
 * discover that Postgres was unreachable or that the store had not been
 * hydrated yet.
 *
 * So these are not "error handling" tests. They pin the difference between a
 * closed door with a sign on it and a closed door without one.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { makePrincipal, resolveCapabilities, RoleSourceRegistry } from '@omadia/channel-sdk';
import type { Principal } from '@omadia/channel-sdk';
import type { Pool } from 'pg';

import { createLateBoundGrantStore, GrantStoreNotReadyError } from '../src/audience/lateBoundGrantStore.js';
import { PostgresGrantStore } from '../src/audience/postgresGrantStore.js';

const ALICE = makePrincipal('user', 'Alice@Example.com') as Principal;

/** A pool whose every query rejects — stands in for "Postgres is unreachable". */
function failingPool(message = 'connection terminated unexpectedly'): Pool {
  return {
    query: async (): Promise<never> => {
      throw new Error(message);
    },
  } as unknown as Pool;
}

/** A pool that records the SQL + params it was handed and returns fixed rows. */
function recordingPool(rows: Array<Record<string, unknown>>): {
  pool: Pool;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe('#575 PostgresGrantStore — an unreachable store must throw, not answer', () => {
  it('propagates a database failure out of directGrants', async () => {
    const store = new PostgresGrantStore(failingPool());
    await assert.rejects(
      () => store.directGrants(ALICE),
      /connection terminated/,
      'a database failure must reach the caller; returning [] would read as "no grants"',
    );
  });

  it('propagates a database failure out of roleGrants', async () => {
    const store = new PostgresGrantStore(failingPool());
    await assert.rejects(() => store.roleGrants('Approver'), /connection terminated/);
  });

  it('a failing store closes the floor instead of shrinking it', async () => {
    // The end-to-end consequence, stated as a test so the chain cannot be
    // broken silently: resolveCapabilities turns the throw into `undefined`
    // (an unresolved member), which the floor reads as "close, with a reason".
    // If the store returned [] instead, this would be a RESOLVED member with an
    // empty capability set — indistinguishable from a deliberate policy.
    const member = await resolveCapabilities(
      ALICE,
      new RoleSourceRegistry(),
      new PostgresGrantStore(failingPool()),
    );
    assert.equal(member, undefined);
  });
});

describe('#575 late-bound grant store — unhydrated is an outage, not an empty answer', () => {
  it('throws while the backing store is still unset', async () => {
    const store = createLateBoundGrantStore(() => undefined);
    await assert.rejects(() => store.directGrants(ALICE), GrantStoreNotReadyError);
    await assert.rejects(() => store.roleGrants('Approver'), GrantStoreNotReadyError);
  });

  it('delegates once the backing store arrives', async () => {
    // The forward reference the kernel fills in after `graphPool` resolves.
    let backing: PostgresGrantStore | undefined;
    const store = createLateBoundGrantStore(() => backing);

    await assert.rejects(() => store.directGrants(ALICE), GrantStoreNotReadyError);

    const { pool } = recordingPool([{ capability: 'tool:send_email' }]);
    backing = new PostgresGrantStore(pool);

    assert.deepEqual([...(await store.directGrants(ALICE))], ['tool:send_email']);
  });

  it('resolves the holder on every call rather than latching the first answer', async () => {
    // A store swapped out later (a pool rebuilt, a backend switched) must be
    // seen. Capturing the resolved value once would pin the floor to whatever
    // existed at publish time — which, published before plugin activation, is
    // nothing.
    const first = recordingPool([{ capability: 'memory:recall' }]);
    const second = recordingPool([{ capability: 'attachment:read' }]);
    let backing = new PostgresGrantStore(first.pool);
    const store = createLateBoundGrantStore(() => backing);

    assert.deepEqual([...(await store.roleGrants('Approver'))], ['memory:recall']);
    backing = new PostgresGrantStore(second.pool);
    assert.deepEqual([...(await store.roleGrants('Approver'))], ['attachment:read']);
  });
});

describe('#575 PostgresGrantStore — canonicalisation matches the lookup that honours it', () => {
  it('lower-cases a user reference on read, so a differently-cased id still finds its grants', async () => {
    const { pool, calls } = recordingPool([]);
    await new PostgresGrantStore(pool).directGrants(ALICE);
    assert.equal(calls.length, 1);
    // #333 phase 1: user refs canonicalise to lower case. Querying the raw
    // spelling would miss every grant written through the admin API.
    assert.deepEqual(calls[0]?.params, ['user', 'alice@example.com']);
  });

  it('does NOT lower-case a role key', async () => {
    const { pool, calls } = recordingPool([]);
    await new PostgresGrantStore(pool).roleGrants('  Approver  ');
    // `conductor_roles.key` is written verbatim by `createRole`, so lower-casing
    // here would miss every mixed-case role — while still trimming whitespace.
    assert.deepEqual(calls[0]?.params, ['Approver']);
  });

  it('refuses an empty capability rather than storing a row that can never match', async () => {
    const { pool } = recordingPool([]);
    const store = new PostgresGrantStore(pool);
    // The floor skips empty capabilities when building its set, so such a row
    // would show up in the admin list while granting nothing.
    await assert.rejects(() => store.grantToPrincipal(ALICE, '   ', 'operator'), /must not be empty/);
    await assert.rejects(() => store.grantToRole('Approver', '', 'operator'), /must not be empty/);
  });
});
