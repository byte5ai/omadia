/**
 * #578 Phase 3 — `PostgresCredentialAskStore` against a real Postgres.
 *
 * `postgresCredentialAskStoreFailure.test.ts` pins the failure semantics
 * with a fake pool. This file is for what a fake pool cannot prove: the SQL
 * round-trips, the DB CHECK constraints back up `validateNewAskInput`, and —
 * the point of the whole file — that TWO CONCURRENT `approve()` CALLS on the
 * SAME ask never both win. That race is exactly what an in-memory store
 * (single-threaded JS) cannot exercise; it needs two real connections racing
 * a real UPDATE.
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

import { PostgresCredentialAskStore } from '../src/credentials/postgresCredentialAskStore.js';
import { PostgresCredentialStore } from '../src/credentials/postgresCredentialStore.js';
import { sealSecret } from '../src/credentials/crypto.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'postgresCredentialAskStore',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

/** Migrations 0040 + 0041's tables, created directly — see the sibling
 *  `postgresCredentialStore.pg.test.ts` for why (suite independence from the
 *  multi-orchestrator migrator). */
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
  broker_injection_key     TEXT,
  broker_allowed_methods   TEXT[],
  broker_path_prefixes     TEXT[],
  created_by               TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at               TIMESTAMPTZ,
  revoked_by               TEXT,
  CONSTRAINT credentials_owner_matches_kind_asktest CHECK (
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
  CONSTRAINT credential_grants_once_has_expiry_asktest CHECK (mode = 'standing' OR expires_at IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS credential_asks (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id               UUID NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  requester_kind              TEXT NOT NULL,
  requester_ref               TEXT NOT NULL,
  owner_kind                  TEXT NOT NULL,
  owner_ref                   TEXT NOT NULL,
  purpose                     TEXT NOT NULL CHECK (length(trim(purpose)) > 0),
  mode                        TEXT NOT NULL CHECK (mode IN ('once', 'standing')),
  requested_grant_expires_at  TIMESTAMPTZ,
  ask_expires_at              TIMESTAMPTZ NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at                 TIMESTAMPTZ,
  resolved_by                 TEXT,
  grant_id                    UUID REFERENCES credential_grants(id),
  CONSTRAINT credential_asks_once_has_expiry_test CHECK (mode = 'standing' OR requested_grant_expires_at IS NOT NULL)
);`;

const KEY = Buffer.alloc(32, 6);

describe('#578 PostgresCredentialAskStore against a real Postgres', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let credStore: PostgresCredentialStore;
  let askStore: PostgresCredentialAskStore;
  const mark = randomUUID().slice(0, 8);
  const alice = makePrincipal('user', `Alice-${mark}@Example.com`) as Principal;
  const owner = makePrincipal('user', `Owner-${mark}@Example.com`) as Principal;

  before(async () => {
    pool = new Pool({ connectionString: PG_URL, max: 6 });
    await pool.query(SCHEMA);
    credStore = new PostgresCredentialStore(
      pool,
      (plaintext) => sealSecret(plaintext, KEY),
      (plaintext) => `fp:${plaintext.length}`,
    );
    askStore = new PostgresCredentialAskStore(pool);
  });

  after(async () => {
    await pool.query(`DELETE FROM credentials WHERE name LIKE $1`, [`%${mark}%`]);
    await pool.end();
  });

  async function makeAskableCredential(name: string) {
    return credStore.createCredential({ name, kind: 'personal', owner, secret: 'shh', createdBy: 'op' });
  }

  it('creates an ask and approve() atomically produces a usable grant', async () => {
    const cred = await makeAskableCredential(`ask-basic-${mark}`);
    const ask = await askStore.createAsk({
      credentialId: cred.id,
      requester: alice,
      owner,
      purpose: 'need it for a sync job',
      mode: 'standing',
      askExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(ask.status, 'pending');

    const approved = await askStore.approve(ask.id, `owner-${mark}@example.com`, new Date());
    assert.ok(approved);
    assert.equal(approved?.status, 'approved');
    assert.ok(approved?.grantId);

    const active = await credStore.activeGrant(cred.id, alice, new Date());
    assert.ok(active, 'the transaction must have committed a real, usable grant');
    assert.equal(active?.purpose, 'need it for a sync job');
  });

  it('deny() resolves without ever touching credential_grants', async () => {
    const cred = await makeAskableCredential(`ask-deny-${mark}`);
    const ask = await askStore.createAsk({
      credentialId: cred.id,
      requester: alice,
      owner,
      purpose: 'need it',
      mode: 'standing',
      askExpiresAt: new Date(Date.now() + 60_000),
    });
    const denied = await askStore.deny(ask.id, `owner-${mark}@example.com`, new Date());
    assert.equal(denied?.status, 'denied');
    assert.equal(await credStore.activeGrant(cred.id, alice, new Date()), undefined);
  });

  it('THE race: two concurrent approve() calls on the same ask — exactly one wins, exactly one grant is created', async () => {
    const cred = await makeAskableCredential(`ask-race-${mark}`);
    const ask = await askStore.createAsk({
      credentialId: cred.id,
      requester: alice,
      owner,
      purpose: 'race test',
      mode: 'standing',
      askExpiresAt: new Date(Date.now() + 60_000),
    });

    const now = new Date();
    const [r1, r2] = await Promise.all([
      askStore.approve(ask.id, 'approver-A', now),
      askStore.approve(ask.id, 'approver-B', now),
    ]);
    const winners = [r1, r2].filter((r) => r !== undefined);
    assert.equal(winners.length, 1, 'exactly one of the two concurrent approvals must win');

    const grants = await pool.query(`SELECT count(*)::int AS n FROM credential_grants WHERE credential_id = $1`, [
      cred.id,
    ]);
    assert.equal(grants.rows[0]?.n, 1, 'exactly one grant row must exist, never two');
  });

  it('approve() on an ask past its TTL (per the caller-supplied `now`) returns undefined, not a grant', async () => {
    const cred = await makeAskableCredential(`ask-expired-${mark}`);
    const ask = await askStore.createAsk({
      credentialId: cred.id,
      requester: alice,
      owner,
      purpose: 'need it',
      mode: 'standing',
      askExpiresAt: new Date(Date.now() + 1000),
    });
    const result = await askStore.approve(ask.id, `owner-${mark}@example.com`, new Date(Date.now() + 5000));
    assert.equal(result, undefined);
    const grants = await pool.query(`SELECT count(*)::int AS n FROM credential_grants WHERE credential_id = $1`, [
      cred.id,
    ]);
    assert.equal(grants.rows[0]?.n, 0, 'an expired ask must never produce a grant');
  });

  it('listPendingForOwner is scoped correctly and TTL-filtered at read time', async () => {
    const cred = await makeAskableCredential(`ask-list-${mark}`);
    await askStore.createAsk({
      credentialId: cred.id,
      requester: alice,
      owner,
      purpose: 'listed',
      mode: 'standing',
      askExpiresAt: new Date(Date.now() + 60_000),
    });
    const shoutyOwner = makePrincipal('user', `OWNER-${mark}@EXAMPLE.COM`) as Principal;
    const pending = await askStore.listPendingForOwner(shoutyOwner, new Date());
    assert.ok(pending.some((a) => a.purpose === 'listed'), 'canonicalisation must make this owner spelling match');
  });

  it('a "once" ask requires requestedGrantExpiresAt — the DB CHECK backs up validateNewAskInput', async () => {
    const cred = await makeAskableCredential(`ask-once-${mark}`);
    await assert.rejects(() =>
      pool.query(
        `INSERT INTO credential_asks (credential_id, requester_kind, requester_ref, owner_kind, owner_ref, purpose, mode, ask_expires_at)
         VALUES ($1, 'user', $2, 'user', $3, 'test', 'once', now() + interval '1 hour')`,
        [cred.id, `alice-${mark}@example.com`, `owner-${mark}@example.com`],
      ),
    );
  });
});
