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

import { PostgresCredentialAskStore } from '../src/credentials/postgresCredentialAskStore.js';

const ALICE = makePrincipal('user', 'alice@example.com') as Principal;
const OWNER = makePrincipal('user', 'owner@example.com') as Principal;

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

    await assert.rejects(() => store.approve('a1', 'owner@example.com', new Date()));
    assert.ok(rolledBack, 'a failed grant insert must roll back the ask claim, not leave it approved with no grant');
    assert.ok(queryCount >= 3, 'sanity: BEGIN, the claim, the failing insert were all attempted');
  });
});
