import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { AgentGraphStore, runMultiOrchestratorMigrations } from '@omadia/orchestrator';

/**
 * PG-gated coverage for the plugin_verdicts store surface (issue #453,
 * second-review fix): the SQL upsert must clear an operator ack whenever a
 * re-scan under the same verifier_version WORSENS the severity relative to
 * the severity that was acked, and keep it when the result is equal or
 * better — including across the scheduler's interim `pending` write.
 * Skips when no test Postgres is reachable, mirroring the other pg tests.
 */
const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['WS5_PG_TEST_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

const HASH_PREFIX = 'plugin-verdict-test-';
const VERIFIER = 'skillspector-test';
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const probePool = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
let pgAvailable = true;
try {
  await probePool.query('SELECT 1');
} catch {
  pgAvailable = false;
  await probePool.end().catch(() => undefined);
}

type Severity =
  | 'no_signals'
  | 'flagged'
  | 'high_risk'
  | 'scan_failed'
  | 'pending'
  | 'too_large_to_scan';

describe('AgentGraphStore plugin verdicts (pg)', { skip: !pgAvailable }, () => {
  const pool = probePool;
  let store: AgentGraphStore;

  function row(contentHash: string, severity: Severity) {
    return {
      contentHash,
      verifierVersion: VERIFIER,
      pluginId: '@test/plugin',
      severity,
      findings: [],
      scannerVersion: VERIFIER,
      rationale: null,
      computedAt: new Date(),
      ackBy: null,
      ackAt: null,
    };
  }

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM plugin_verdicts WHERE content_hash LIKE $1', [
      `${HASH_PREFIX}%`,
    ]);
  }

  before(async () => {
    await runMultiOrchestratorMigrations(pool, undefined, migrationsDir);
    await cleanup();
    store = new AgentGraphStore(pool);
  });

  after(async () => {
    await cleanup();
    await pool.end();
  });

  it('clears the ack when a re-scan worsens the severity', async () => {
    const hash = `${HASH_PREFIX}worse`;
    await store.upsertPluginVerdict(row(hash, 'scan_failed'));
    const ack = await store.upsertPluginVerdictAck(hash, VERIFIER, 'op@example.com');
    assert.ok(ack);

    // Scheduler retry: interim pending, then a WORSE final verdict.
    await store.upsertPluginVerdict(row(hash, 'pending'));
    await store.upsertPluginVerdict(row(hash, 'high_risk'));

    const verdict = await store.getPluginVerdict(hash, VERIFIER);
    assert.equal(verdict?.severity, 'high_risk');
    assert.equal(verdict?.ackBy, null);
    assert.equal(verdict?.ackAt, null);
  });

  it('keeps the ack when a re-scan is equal or better', async () => {
    const hash = `${HASH_PREFIX}better`;
    await store.upsertPluginVerdict(row(hash, 'scan_failed'));
    assert.ok(await store.upsertPluginVerdictAck(hash, VERIFIER, 'op@example.com'));

    // Interim pending must not destroy the comparison baseline: the acked
    // severity (scan_failed) is the reference, not the live `pending`.
    await store.upsertPluginVerdict(row(hash, 'pending'));
    await store.upsertPluginVerdict(row(hash, 'no_signals'));

    const verdict = await store.getPluginVerdict(hash, VERIFIER);
    assert.equal(verdict?.severity, 'no_signals');
    assert.equal(verdict?.ackBy, 'op@example.com');
    assert.ok(verdict?.ackAt);
  });

  it('keeps the ack on an equal re-scan result', async () => {
    const hash = `${HASH_PREFIX}equal`;
    await store.upsertPluginVerdict(row(hash, 'scan_failed'));
    assert.ok(await store.upsertPluginVerdictAck(hash, VERIFIER, 'op@example.com'));

    await store.upsertPluginVerdict(row(hash, 'scan_failed'));

    const verdict = await store.getPluginVerdict(hash, VERIFIER);
    assert.equal(verdict?.severity, 'scan_failed');
    assert.equal(verdict?.ackBy, 'op@example.com');
  });
});
