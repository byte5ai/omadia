/**
 * #576 P3 — `PostgresSandboxRegistry` against a real Postgres. Skips cleanly
 * (same convention as `postgresCredentialStore.pg.test.ts`) when no test
 * database is configured. Schema is created inline from migration
 * `0044_sandbox_registry.sql` so this suite does not depend on the
 * multi-orchestrator migrator having run against the test DB.
 */

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';

import { probePgTest } from '../_helpers/pgTestDb.js';

import { PostgresSandboxRegistry } from '../../packages/harness-sandbox/src/postgresSandboxRegistry.js';
import { resolveAgentComputerProfile } from '../../packages/harness-sandbox/src/agentComputerProfile.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'postgresSandboxRegistry',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sandbox_registry (
  scope_key      TEXT PRIMARY KEY,
  backend        TEXT NOT NULL,
  sandbox_ref    TEXT NOT NULL,
  profile        JSONB NOT NULL,
  ro_layer_hash  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const describeIf = pgAvailable ? describe : describe.skip;

describeIf('PostgresSandboxRegistry (#576 P3)', () => {
  let pool: Pool;
  let registry: PostgresSandboxRegistry;

  before(async () => {
    pool = new Pool({ connectionString: PG_URL });
    await pool.query(SCHEMA);
    registry = new PostgresSandboxRegistry(pool);
  });

  after(async () => {
    await pool.query('DROP TABLE IF EXISTS sandbox_registry');
    await pool.end();
  });

  it('upsert then get round-trips every field, including the profile JSONB', async () => {
    const scopeKey = `personal:pg-roundtrip-${String(Date.now())}`;
    const now = new Date();
    const profile = resolveAgentComputerProfile({ egress: true, persistent: true });
    await registry.upsert({ scopeKey, backend: 'docker', sandboxRef: 'ref-1', profile, now, roLayerHash: 'hash-a' });

    const entry = await registry.get(scopeKey);
    assert.ok(entry);
    assert.equal(entry!.scopeKey, scopeKey);
    assert.equal(entry!.backend, 'docker');
    assert.equal(entry!.sandboxRef, 'ref-1');
    assert.deepEqual(entry!.profile, profile);
    assert.equal(entry!.roLayerHash, 'hash-a');
  });

  it('upsert on an existing scope preserves createdAt but updates lastUsedAt', async () => {
    const scopeKey = `personal:pg-upsert-${String(Date.now())}`;
    const first = new Date(Date.now() - 60_000);
    await registry.upsert({
      scopeKey,
      backend: 'docker',
      sandboxRef: 'ref-1',
      profile: resolveAgentComputerProfile(),
      now: first,
    });
    const createdAt = (await registry.get(scopeKey))!.createdAt;

    const second = new Date();
    await registry.upsert({
      scopeKey,
      backend: 'docker',
      sandboxRef: 'ref-2',
      profile: resolveAgentComputerProfile(),
      now: second,
    });
    const entry = await registry.get(scopeKey);
    assert.equal(entry!.sandboxRef, 'ref-2');
    assert.equal(entry!.createdAt.getTime(), createdAt.getTime());
    assert.ok(entry!.lastUsedAt.getTime() >= second.getTime() - 1000);
  });

  it('touch bumps lastUsedAt without changing anything else', async () => {
    const scopeKey = `personal:pg-touch-${String(Date.now())}`;
    const start = new Date(Date.now() - 60_000);
    await registry.upsert({
      scopeKey,
      backend: 'docker',
      sandboxRef: 'ref-touch',
      profile: resolveAgentComputerProfile(),
      now: start,
    });
    const touchTime = new Date();
    await registry.touch(scopeKey, touchTime);
    const entry = await registry.get(scopeKey);
    assert.equal(entry!.sandboxRef, 'ref-touch');
    assert.ok(entry!.lastUsedAt.getTime() >= touchTime.getTime() - 1000);
  });

  it('delete removes the row', async () => {
    const scopeKey = `personal:pg-delete-${String(Date.now())}`;
    await registry.upsert({
      scopeKey,
      backend: 'docker',
      sandboxRef: 'ref-del',
      profile: resolveAgentComputerProfile(),
      now: new Date(),
    });
    await registry.delete(scopeKey);
    assert.equal(await registry.get(scopeKey), undefined);
  });

  it('listAll returns every registered scope', async () => {
    const marker = `pg-listall-${String(Date.now())}`;
    await registry.upsert({
      scopeKey: `personal:${marker}-a`,
      backend: 'docker',
      sandboxRef: 'ref-a',
      profile: resolveAgentComputerProfile(),
      now: new Date(),
    });
    await registry.upsert({
      scopeKey: `personal:${marker}-b`,
      backend: 'docker',
      sandboxRef: 'ref-b',
      profile: resolveAgentComputerProfile(),
      now: new Date(),
    });
    const all = await registry.listAll();
    const keys = all.map((e) => e.scopeKey);
    assert.ok(keys.includes(`personal:${marker}-a`));
    assert.ok(keys.includes(`personal:${marker}-b`));
  });
});
