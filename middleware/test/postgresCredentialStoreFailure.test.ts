/**
 * #578 Phase 1 — `PostgresCredentialStore` must THROW when it cannot answer,
 * never swallow the failure into an empty/absent result.
 *
 * Same reasoning as `audienceGrantStore.test.ts` for `PostgresGrantStore`: a
 * caller that turned a database outage into "no active grant" would make an
 * outage indistinguishable from an honest revocation. That distinction
 * matters more here than for capabilities, because the caller on the other
 * end (phase 2's broker) is deciding whether to stamp a secret onto an
 * outbound request — "I could not check" and "access was revoked" must never
 * collapse into the same code path.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { makePrincipal, type Principal } from '@omadia/channel-sdk';
import type { Pool } from 'pg';

import { PostgresCredentialStore } from '../src/credentials/postgresCredentialStore.js';

const ALICE = makePrincipal('user', 'alice@example.com') as Principal;

/** A pool whose every query rejects — stands in for "Postgres is unreachable". */
function failingPool(message = 'connection terminated unexpectedly'): Pool {
  return {
    query: async (): Promise<never> => {
      throw new Error(message);
    },
  } as unknown as Pool;
}

function store(pool: Pool): PostgresCredentialStore {
  return new PostgresCredentialStore(
    pool,
    (plaintext) => ({ iv: 'iv', tag: 'tag', ciphertext: plaintext }),
    (plaintext) => `fp:${plaintext}`,
  );
}

describe('#578 PostgresCredentialStore fails closed on an unreachable database', () => {
  it('getCredential rejects rather than resolving undefined', async () => {
    await assert.rejects(() => store(failingPool()).getCredential('c1'));
  });

  it('getCredentialByName rejects', async () => {
    await assert.rejects(() => store(failingPool()).getCredentialByName('x'));
  });

  it('listCredentials rejects rather than resolving []', async () => {
    await assert.rejects(() => store(failingPool()).listCredentials());
  });

  it('getSecretMaterial rejects rather than resolving undefined', async () => {
    await assert.rejects(() => store(failingPool()).getSecretMaterial('c1'));
  });

  it('activeGrant rejects rather than resolving undefined — the case that matters most', async () => {
    await assert.rejects(() => store(failingPool()).activeGrant('c1', ALICE, new Date()));
  });

  it('createCredential rejects and does not return a half-built row', async () => {
    await assert.rejects(() =>
      store(failingPool()).createCredential({ name: 'x', kind: 'service', secret: 's', createdBy: 'op' }),
    );
  });

  it('createGrant rejects on a generic failure (not just the foreign-key-mapped one)', async () => {
    await assert.rejects(() =>
      store(failingPool()).createGrant({
        credentialId: 'c1',
        principal: ALICE,
        mode: 'standing',
        purpose: 'test',
        grantedBy: 'op',
      }),
    );
  });

  it('revokeCredential rejects rather than reporting false', async () => {
    await assert.rejects(() => store(failingPool()).revokeCredential('c1', 'op'));
  });

  it('revokeGrant rejects rather than reporting false', async () => {
    await assert.rejects(() => store(failingPool()).revokeGrant('g1', 'op'));
  });

  it('markGrantConsumed rejects rather than reporting false', async () => {
    await assert.rejects(() => store(failingPool()).markGrantConsumed('g1', new Date()));
  });
});
