/**
 * #578 Phase 3 — `PostgresCredentialAskStore` must THROW when it cannot
 * answer, and `approve()` specifically must never leave a half-committed
 * state (an ask marked `approved` with no grant, or vice versa) when the
 * second write fails — same reasoning as `postgresCredentialStoreFailure.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { makePrincipal, type Principal } from '@omadia/channel-sdk';
import type { Pool, PoolClient } from 'pg';

import { CredentialAskRejectedError } from '../src/credentials/asks.js';
import { PostgresCredentialAskStore } from '../src/credentials/postgresCredentialAskStore.js';

const ALICE = makePrincipal('user', 'alice@example.com') as Principal;
const OWNER = makePrincipal('user', 'owner@example.com') as Principal;

/** What `SELECT ... FROM credentials ... FOR SHARE` returns for a live,
 *  user-owned personal credential. */
const LIVE_PERSONAL_ROW = {
  id: 'c1',
  kind: 'personal',
  owner_kind: 'user',
  owner_ref: 'owner@example.com',
  revoked_at: null,
};

function failingPool(message = 'connection terminated unexpectedly'): Pool {
  return {
    query: async (): Promise<never> => {
      throw new Error(message);
    },
    connect: async (): Promise<never> => {
      throw new Error(message);
    },
  } as unknown as Pool;
}

describe('#578 PostgresCredentialAskStore fails closed on an unreachable database', () => {
  it('createAsk rejects rather than resolving a half-built ask', async () => {
    const store = new PostgresCredentialAskStore(failingPool());
    await assert.rejects(() =>
      store.createAsk({
        credentialId: 'c1',
        requester: ALICE,
        owner: OWNER,
        purpose: 'test',
        mode: 'standing',
        askExpiresAt: new Date(),
      }),
    );
  });

  it('getAsk rejects rather than resolving undefined', async () => {
    const store = new PostgresCredentialAskStore(failingPool());
    await assert.rejects(() => store.getAsk('a1'));
  });

  it('listPendingForOwner rejects rather than resolving []', async () => {
    const store = new PostgresCredentialAskStore(failingPool());
    await assert.rejects(() => store.listPendingForOwner(OWNER, new Date()));
  });

  it('approve rejects when the pool cannot even hand out a connection', async () => {
    const store = new PostgresCredentialAskStore(failingPool());
    await assert.rejects(() => store.approve('a1', 'owner@example.com', new Date()));
  });

  it('approve rolls back and rejects when the SECOND write (the grant insert) fails, never leaving the ask claimed', async () => {
    let queryCount = 0;
    let rolledBack = false;
    let credentialChecked = false;
    const fakeClient = {
      query: async (sql: string) => {
        queryCount += 1;
        if (sql === 'BEGIN') return { rows: [] };
        if (sql === 'ROLLBACK') {
          rolledBack = true;
          return { rows: [] };
        }
        if (sql.includes('UPDATE credential_asks') && sql.includes("status = 'approved'")) {
          // The atomic claim succeeds...
          return {
            rows: [
              {
                id: 'a1',
                credential_id: 'c1',
                requester_kind: 'user',
                requester_ref: 'alice@example.com',
                owner_kind: 'user',
                owner_ref: 'owner@example.com',
                purpose: 'test',
                mode: 'standing',
                requested_grant_expires_at: null,
                ask_expires_at: new Date(Date.now() + 60_000),
                status: 'approved',
                created_at: new Date(),
                resolved_at: new Date(),
                resolved_by: 'owner@example.com',
                grant_id: null,
              },
            ],
          };
        }
        if (sql.includes('FROM credentials') && sql.includes('FOR SHARE')) {
          // #778 S1 — the approve-time re-check sees a live personal
          // credential, so the flow proceeds to the grant insert. Without
          // this, the test would pass for the wrong reason (the stub's own
          // "unexpected query" throw at the re-check).
          credentialChecked = true;
          return { rows: [LIVE_PERSONAL_ROW] };
        }
        if (sql.includes('INSERT INTO credential_grants')) {
          // ...but the grant insert fails.
          throw new Error('disk full');
        }
        throw new Error(`unexpected query in this stub: ${sql}`);
      },
      release: () => undefined,
    } as unknown as PoolClient;

    const pool = { connect: async () => fakeClient } as unknown as Pool;
    const store = new PostgresCredentialAskStore(pool);

    await assert.rejects(() => store.approve('a1', 'owner@example.com', new Date()), /disk full/);
    assert.ok(credentialChecked, 'the credential re-check ran before the grant insert');
    assert.ok(rolledBack, 'a failed grant insert must roll back the ask claim, not leave it approved with no grant');
    assert.ok(queryCount >= 4, 'sanity: BEGIN, the claim, the re-check, the failing insert were all attempted');
  });

  it('#778 S1: createAsk rolls back and rejects when the INSERT fails after a successful credential check', async () => {
    const seen: string[] = [];
    let released = false;
    const fakeClient = {
      query: async (sql: string) => {
        seen.push(sql.trim().split(/\s+/)[0] ?? '');
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('FROM credentials') && sql.includes('FOR SHARE')) return { rows: [LIVE_PERSONAL_ROW] };
        if (sql.includes('INSERT INTO credential_asks')) throw new Error('disk full');
        throw new Error(`unexpected query in this stub: ${sql}`);
      },
      release: () => {
        released = true;
      },
    } as unknown as PoolClient;
    const store = new PostgresCredentialAskStore({ connect: async () => fakeClient } as unknown as Pool);

    await assert.rejects(
      () =>
        store.createAsk({
          credentialId: 'c1',
          requester: ALICE,
          purpose: 'test',
          mode: 'standing',
          askExpiresAt: new Date(Date.now() + 60_000),
        }),
      (err: unknown) => err instanceof Error && !(err instanceof CredentialAskRejectedError) && /disk full/.test(err.message),
    );
    assert.deepEqual(seen, ['BEGIN', 'SELECT', 'INSERT', 'ROLLBACK']);
    assert.ok(released, 'the checked-out client must be released');
  });

  it('#778 S1: a "standing" ask with an Invalid Date is invalid_input before any query — not a 22007 from Postgres', async () => {
    let touched = false;
    const pool = {
      connect: async () => {
        touched = true;
        throw new Error('must not reach the database');
      },
      query: async () => {
        touched = true;
        throw new Error('must not reach the database');
      },
    } as unknown as Pool;
    const store = new PostgresCredentialAskStore(pool);
    await assert.rejects(
      () =>
        store.createAsk({
          credentialId: 'c1',
          requester: ALICE,
          purpose: 'test',
          mode: 'standing',
          requestedGrantExpiresAt: new Date('garbage'),
          askExpiresAt: new Date(Date.now() + 60_000),
        }),
      (err: unknown) => err instanceof CredentialAskRejectedError && err.reason === 'invalid_input',
    );
    assert.equal(touched, false, 'validation runs before the store checks out a client');
  });
});
