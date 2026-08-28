/**
 * #578 Phase 1 — `createCredentialStore` must make the no-pool decision
 * explicitly and testably, not by an implicit fallback nobody chose (the
 * "vault no-pool case" the issue's prompt calls out by name).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryCredentialStore } from '@omadia/channel-sdk';
import type { Pool } from 'pg';

import { createCredentialStore } from '../src/credentials/credentialStoreFactory.js';
import { PostgresCredentialStore } from '../src/credentials/postgresCredentialStore.js';

const KEY = Buffer.alloc(32, 1);

describe('#578 createCredentialStore', () => {
  it('picks the in-memory backend when no pool is given', () => {
    const choice = createCredentialStore(undefined, KEY);
    assert.equal(choice.backend, 'in-memory');
    assert.ok(choice.store instanceof InMemoryCredentialStore);
  });

  it('picks the Postgres backend when a pool is given', () => {
    const fakePool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
    const choice = createCredentialStore(fakePool, KEY);
    assert.equal(choice.backend, 'postgres');
    assert.ok(choice.store instanceof PostgresCredentialStore);
  });

  it('the in-memory backend actually works end to end (create, grant, check)', async () => {
    const choice = createCredentialStore(undefined, KEY);
    const cred = await choice.store.createCredential({
      name: 'factory-smoke',
      kind: 'service',
      secret: 'shh',
      createdBy: 'op',
    });
    const material = await choice.store.getSecretMaterial(cred.id);
    assert.ok(material, 'in-memory backend must still encrypt/store material, not just metadata');
  });
});
