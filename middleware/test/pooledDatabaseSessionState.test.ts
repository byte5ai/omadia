/**
 * Session state behind a transaction-mode connection pooler.
 *
 * The hosted instance reaches Postgres through Neon's pooled address
 * (`…-pooler…`). There a client has no server session of its own outside a
 * transaction, so everything that needs one — LISTEN, a session-level
 * advisory lock held across transactions — must connect directly. These tests
 * pin the address rule; `migratorConcurrentBoot.test.ts` pins that the
 * migrators need no session state at all.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { directAddressFor } from '../packages/harness-knowledge-graph-neon/src/sessionConnection.js';
import { directDatabaseUrl, isPooledDatabaseUrl } from '../packages/harness-orchestrator/src/registry/reloadBus.js';

const POOLED = 'postgres://app:pw@ep-cool-moon-123456-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require';
const DIRECT = 'postgres://app:pw@ep-cool-moon-123456.eu-central-1.aws.neon.tech/neondb?sslmode=require';
const LOCAL = 'postgres://omadia:pw@127.0.0.1:5432/omadia';

describe('direct database address for session state', () => {
  it('recognises a Neon pooled address and nothing else', () => {
    assert.equal(isPooledDatabaseUrl(POOLED), true);
    assert.equal(isPooledDatabaseUrl(DIRECT), false);
    assert.equal(isPooledDatabaseUrl(LOCAL), false);
    assert.equal(isPooledDatabaseUrl('postgres://u:p@db-pooler-eu/x'), false, 'only the Neon host form');
    assert.equal(isPooledDatabaseUrl(undefined), false);
    assert.equal(isPooledDatabaseUrl('not a url'), false);
  });

  it('LISTEN: the pooled Neon host without -pooler, the explicit direct URL first, anything else unchanged', () => {
    assert.equal(directDatabaseUrl(POOLED), DIRECT);
    assert.equal(directDatabaseUrl(POOLED, 'postgres://direct.example/db'), 'postgres://direct.example/db');
    assert.equal(directDatabaseUrl(POOLED, '  '), DIRECT, 'an empty setting is no setting');
    assert.equal(directDatabaseUrl(LOCAL), LOCAL);
    assert.equal(directDatabaseUrl(DIRECT), DIRECT);
    assert.equal(directDatabaseUrl(undefined), undefined);
    // Credentials, database and parameters survive.
    assert.equal(new URL(directDatabaseUrl(POOLED)!).password, 'pw');
    assert.equal(new URL(directDatabaseUrl(POOLED)!).searchParams.get('sslmode'), 'require');
  });

  it('knowledge-graph session locks: a connection of their own only when the pool is pooled', () => {
    assert.equal(directAddressFor(POOLED, undefined), DIRECT);
    assert.equal(directAddressFor(POOLED, 'postgres://direct.example/db'), 'postgres://direct.example/db');
    assert.equal(directAddressFor(LOCAL, undefined), undefined, 'an ordinary pool checkout');
    assert.equal(directAddressFor(DIRECT, undefined), undefined);
    assert.equal(directAddressFor(LOCAL, LOCAL), undefined, 'the direct URL is the pool URL: nothing to gain');
    assert.equal(directAddressFor(undefined, DIRECT), undefined, 'a pool without a known address (a test double)');
    // Behind a pooler that cannot be recognised, the operator's setting decides.
    assert.equal(directAddressFor('postgres://u:p@pgbouncer.internal:6432/db', 'postgres://u:p@pg.internal:5432/db'), 'postgres://u:p@pg.internal:5432/db');
  });
});
