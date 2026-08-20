/**
 * #578 Phase 1 — `PostgresCredentialStore` against a real Postgres.
 *
 * `postgresCredentialStoreFailure.test.ts` pins the failure semantics (throw,
 * never swallow) with a fake pool. This file is for what a fake pool cannot
 * prove: that the SQL round-trips, that the unique-name and once-needs-expiry
 * constraints are enforced (both by the DB CHECK and, redundantly, by
 * `validateNewGrantInput`), and that `activeGrant` finds a grant written
 * through a differently-cased principal spelling.
 *
 * Skips cleanly (issue #572: no hardcoded default port) when no test
 * database is configured.
 */

import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { makePrincipal, type Principal } from '@omadia/channel-sdk';
import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { PostgresCredentialStore } from '../src/credentials/postgresCredentialStore.js';
import { sealSecret, unsealSecret } from '../src/credentials/crypto.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'postgresCredentialStore',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

/** Migration 0040's two tables, created directly so this suite does not
 *  depend on the multi-orchestrator migrator having run against the test DB. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS credentials (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     TEXT NOT NULL,
  kind                     TEXT NOT NULL CHECK (kind IN ('personal', 'service')),
  owner_kind               TEXT,
  owner_ref                TEXT,
  fingerprint              TEXT NOT NULL,
  enc_iv                   TEXT NOT NULL,
  enc_tag                  TEXT NOT NULL,
  enc_ciphertext           TEXT NOT NULL,
  broker_host              TEXT,
  broker_injection_scheme  TEXT,
  broker_header_name       TEXT,
  broker_allowed_methods   TEXT[],
  broker_path_prefixes     TEXT[],
  created_by               TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at               TIMESTAMPTZ,
  revoked_by               TEXT,
  CONSTRAINT credentials_owner_matches_kind_test CHECK (
    (kind = 'personal' AND owner_kind IS NOT NULL AND owner_ref IS NOT NULL)
    OR (kind = 'service' AND owner_kind IS NULL AND owner_ref IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS credentials_name_live
  ON credentials (name) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS credential_grants (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id  UUID NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  principal_kind TEXT NOT NULL,
  principal_ref  TEXT NOT NULL,
  mode           TEXT NOT NULL CHECK (mode IN ('once', 'standing')),
  purpose        TEXT NOT NULL CHECK (length(trim(purpose)) > 0),
  granted_by     TEXT NOT NULL,
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ,
  consumed_at    TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  revoked_by     TEXT,
  CONSTRAINT credential_grants_once_has_expiry_test CHECK (mode = 'standing' OR expires_at IS NOT NULL)
);`;

const KEY = Buffer.alloc(32, 5);

describe('#578 PostgresCredentialStore against a real Postgres', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: PostgresCredentialStore;
  // Unique per run so concurrent test files cannot collide on shared tables.
  const mark = randomUUID().slice(0, 8);
  const alice = makePrincipal('user', `Alice-${mark}@Example.com`) as Principal;

  before(async () => {
    pool = new Pool({ connectionString: PG_URL, max: 4 });
    await pool.query(SCHEMA);
    store = new PostgresCredentialStore(
      pool,
      (plaintext) => sealSecret(plaintext, KEY),
      (plaintext) => `fp:${plaintext.length}`,
    );
  });

  after(async () => {
    await pool.query(`DELETE FROM credentials WHERE name LIKE $1`, [`%${mark}%`]);
    await pool.end();
  });

  it('creates a credential and round-trips its secret through the store material', async () => {
    const cred = await store.createCredential({
      name: `svc-${mark}`,
      kind: 'service',
      secret: 'top-secret-token',
      createdBy: 'operator@example.com',
      broker: {
        host: 'api.example.com',
        injectionScheme: 'bearer',
        allowedMethods: ['GET', 'POST'],
        pathPrefixes: ['/v1/'],
      },
    });
    assert.equal(cred.kind, 'service');
    assert.equal(cred.broker?.host, 'api.example.com');
    assert.deepEqual(cred.broker?.allowedMethods, ['GET', 'POST']);

    const material = await store.getSecretMaterial(cred.id);
    assert.ok(material);
    assert.equal(unsealSecret(material, KEY), 'top-secret-token');
  });

  it('refuses a duplicate live name (the partial unique index enforces this at the DB layer)', async () => {
    await store.createCredential({ name: `dup-${mark}`, kind: 'service', secret: 's1', createdBy: 'op' });
    await assert.rejects(() =>
      store.createCredential({ name: `dup-${mark}`, kind: 'service', secret: 's2', createdBy: 'op' }),
    );
  });

  it('a personal credential requires an owner (CHECK constraint, not just app validation)', async () => {
    await assert.rejects(() =>
      pool.query(
        `INSERT INTO credentials (name, kind, fingerprint, enc_iv, enc_tag, enc_ciphertext, created_by)
         VALUES ($1, 'personal', 'fp', 'iv', 'tag', 'ct', 'op')`,
        [`bad-personal-${mark}`],
      ),
    );
  });

  it('finds an active grant through a differently-cased principal spelling', async () => {
    const cred = await store.createCredential({ name: `grantable-${mark}`, kind: 'service', secret: 's', createdBy: 'op' });
    await store.createGrant({
      credentialId: cred.id,
      principal: alice,
      mode: 'standing',
      purpose: 'sync job',
      grantedBy: 'operator@example.com',
    });
    const shouty = makePrincipal('user', `ALICE-${mark}@EXAMPLE.COM`) as Principal;
    const found = await store.activeGrant(cred.id, shouty, new Date());
    assert.ok(found, 'canonicalisation must make this match');
    assert.equal(found?.purpose, 'sync job');
  });

  it('activeGrant ignores an expired grant even though the row itself is not revoked', async () => {
    // Expiry is a JS-side filter over non-revoked rows (`isGrantActive`), not
    // something the SQL WHERE clause enforces — this pins that the read path
    // actually applies it rather than handing back every non-revoked row.
    const cred = await store.createCredential({ name: `expired-${mark}`, kind: 'service', secret: 's', createdBy: 'op' });
    await store.createGrant({
      credentialId: cred.id,
      principal: alice,
      mode: 'standing',
      purpose: 'temporary access',
      grantedBy: 'operator@example.com',
      expiresAt: new Date(Date.now() - 60_000),
    });
    assert.equal(await store.activeGrant(cred.id, alice, new Date()), undefined);
  });

  it('activeGrant ignores a consumed "once" grant even though it has not expired', async () => {
    const cred = await store.createCredential({ name: `consumed-${mark}`, kind: 'service', secret: 's', createdBy: 'op' });
    const grant = await store.createGrant({
      credentialId: cred.id,
      principal: alice,
      mode: 'once',
      purpose: 'single lookup',
      grantedBy: 'operator@example.com',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await store.markGrantConsumed(grant.id, new Date());
    assert.equal(await store.activeGrant(cred.id, alice, new Date()), undefined);
  });

  it('a "once" grant needs an expiry — the DB CHECK backs up validateNewGrantInput', async () => {
    const cred = await store.createCredential({ name: `once-${mark}`, kind: 'service', secret: 's', createdBy: 'op' });
    await assert.rejects(() =>
      pool.query(
        `INSERT INTO credential_grants (credential_id, principal_kind, principal_ref, mode, purpose, granted_by)
         VALUES ($1, 'user', $2, 'once', 'test', 'op')`,
        [cred.id, `alice-${mark}@example.com`],
      ),
    );
  });

  it('revoking a grant is idempotent and honestly reports whether it did anything', async () => {
    const cred = await store.createCredential({ name: `revoke-${mark}`, kind: 'service', secret: 's', createdBy: 'op' });
    const grant = await store.createGrant({
      credentialId: cred.id,
      principal: alice,
      mode: 'standing',
      purpose: 'test',
      grantedBy: 'op',
    });
    assert.equal(await store.revokeGrant(grant.id, 'op'), true);
    assert.equal(await store.revokeGrant(grant.id, 'op'), false);
    assert.equal(await store.activeGrant(cred.id, alice, new Date()), undefined);
  });

  it('marking a grant consumed is idempotent and honestly reports whether it did anything', async () => {
    const cred = await store.createCredential({ name: `consume-idem-${mark}`, kind: 'service', secret: 's', createdBy: 'op' });
    const grant = await store.createGrant({
      credentialId: cred.id,
      principal: alice,
      mode: 'once',
      purpose: 'test',
      grantedBy: 'op',
      expiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(await store.markGrantConsumed(grant.id, new Date()), true);
    assert.equal(await store.markGrantConsumed(grant.id, new Date()), false);
  });

  it('revoking a credential removes it from listCredentials-by-name but keeps its grant history', async () => {
    const cred = await store.createCredential({ name: `lifecycle-${mark}`, kind: 'service', secret: 's', createdBy: 'op' });
    await store.createGrant({ credentialId: cred.id, principal: alice, mode: 'standing', purpose: 'p', grantedBy: 'op' });
    assert.equal(await store.revokeCredential(cred.id, 'op'), true);
    assert.equal(await store.getCredentialByName(`lifecycle-${mark}`), undefined);
    const grants = await store.listGrantsForCredential(cred.id);
    assert.equal(grants.length, 1, 'revoking the credential must not delete its grant trail');
  });
});
