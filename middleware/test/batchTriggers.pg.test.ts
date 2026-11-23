/**
 * #2082 (spec 2042 §5.12 "Changes to today's mechanisms") — periodic
 * learning and consolidation run as bounded batch triggers owned by the
 * agent whose memory it is: due items found without a model, a bounded batch
 * under the trigger's budget and model-call meter, no free-running interval.
 */

import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { BatchJob } from '@omadia/plugin-api';
import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { runMultiOrchestratorMigrations } from '../packages/harness-orchestrator/src/registry/migrator.js';
import { currentExecutionContext, recordUsage, type ModelExecutionContext } from '../packages/harness-usage-telemetry/src/index.js';
import { batchContextId, createBatchTriggerSync, KernelBatchJobRegistry } from '../src/triggers/batchJobs.js';
import { DEFAULT_TRIGGER_LIMITS, parseActions } from '../src/triggers/triggerPolicy.js';
import { wireTriggers, type TriggerWiring } from '../src/triggers/wiring.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'batchTriggers',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `batch_triggers_${String(process.pid)}`;
const JOB = 'test.consolidate';

describe('policy: a batch action is the system\'s alone', () => {
  it('refuses a batch step for an agent or a routine', () => {
    const steps = [{ type: 'batch', job: JOB }];
    assert.equal(parseActions(steps, 'wake_every', 'conversation', 'agent').ok, false);
    assert.equal(parseActions(steps, 'wake_every', 'routine', 'routine').ok, false);
    assert.equal(parseActions(steps, 'wake_every', 'memory', 'system').ok, true);
  });
});

describe('registry: built-in plugins only', () => {
  it('refuses a batch job from any other plugin', () => {
    const reg = new KernelBatchJobRegistry();
    const job: BatchJob = {
      id: 'hub.plugin.job',
      purpose: 'x',
      intervalMinutes: 60,
      batchSize: 1,
      due: async () => 0,
      run: async () => ({ processed: 0, failed: 0 }),
    };
    assert.throws(() => reg.forCaller('@acme/hub-plugin', false).register(job), /built-in plugins only/);
    const dispose = reg.forCaller('@omadia/orchestrator-extras', true).register(job);
    assert.equal(reg.get('hub.plugin.job'), job);
    dispose();
    assert.equal(reg.get('hub.plugin.job'), undefined);
  });
});

describe('#2082 batch jobs as agent batch triggers (pg)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let clock = new Date('2026-11-23T07:00:00Z');
  let wiring: TriggerWiring;
  const registry = new KernelBatchJobRegistry();
  const pending = new Map<string, number>();
  const runs: { agent: string; limit: number; context: ModelExecutionContext | undefined }[] = [];
  const agents: { id: string; slug: string }[] = [];
  let unregister: () => void = () => undefined;

  const job: BatchJob = {
    id: JOB,
    purpose: 'Consolidate notes',
    intervalMinutes: 60,
    batchSize: 50,
    due: async (slug) => pending.get(slug) ?? 0,
    run: async (slug, { limit }) => {
      runs.push({ agent: slug, limit, context: currentExecutionContext() });
      recordUsage({ source: 'test', model: 'scripted', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01 });
      const n = Math.min(limit, pending.get(slug) ?? 0);
      pending.set(slug, (pending.get(slug) ?? 0) - n);
      return { processed: n, failed: 0 };
    },
  };
  const sync = () =>
    createBatchTriggerSync({
      registry,
      service: () => wiring.service,
      agents: () => agents,
      limits: () => DEFAULT_TRIGGER_LIMITS,
      now: () => clock,
      log: () => undefined,
    })();

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 6, options: `-c search_path=${SCHEMA},public` });
    await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);
    const config = new ConfigStore(pool);
    for (const slug of ['erika', 'otto']) agents.push({ id: (await config.createAgent({ slug, name: slug })).id, slug });
    unregister = registry.register(job);
    wiring = wireTriggers({
      pool,
      limits: DEFAULT_TRIGGER_LIMITS,
      recipientDefaults: { timezone: 'Europe/Berlin', quiet: { from: '00:00', to: '23:59' }, maxPerHour: 0 },
      enabled: true,
      tickMs: 60_000,
      leaseMs: 600_000,
      agentBySlug: (slug) => {
        const a = agents.find((x) => x.slug === slug);
        return a ? { ...a, enabled: true } : undefined;
      },
      agentChat: () => undefined,
      readToolsOf: () => new Map(),
      grantedPluginIds: () => [],
      eventCatalog: () => ({}),
      channelPluginIds: () => [],
      senders: () => undefined,
      batchJobs: registry,
      enabledAgents: () => agents,
      registerNativeTool: () => () => undefined,
      now: () => clock,
      log: () => undefined,
    });
  });

  after(async () => {
    wiring?.stop();
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await pool?.end();
  });

  beforeEach(async () => {
    pending.clear();
    runs.length = 0;
    clock = new Date('2026-11-23T07:00:00Z');
    await pool.query('DELETE FROM agent_triggers');
  });

  it('arms one trigger per agent with due items, none for an agent with nothing due', async () => {
    pending.set('erika', 3);
    assert.deepEqual(await sync(), { armed: 1, ended: 0 });
    assert.deepEqual(await sync(), { armed: 0, ended: 0 }, 'idempotent');
    const [t] = await wiring.service.listForContext('memory', batchContextId(JOB, 'erika'));
    assert.ok(t);
    assert.equal(t.origin, 'system');
    assert.equal(t.deliveryChannel, null);
    assert.equal(t.intervalSeconds, 3600);
    assert.deepEqual(t.actions, [{ type: 'batch', job: JOB }]);
    assert.ok(t.budgetTotalUsd > 0 && t.maxRuns !== null);
    assert.equal(t.until.getTime() - clock.getTime(), 30 * 86_400_000);
    assert.equal((await wiring.service.listForContext('memory', batchContextId(JOB, 'otto'))).length, 0);
  });

  it('a firing runs one bounded batch under the meters; nothing due ends quietly', async () => {
    pending.set('erika', 100);
    await sync();
    clock = new Date('2026-11-23T08:30:00Z');
    await Promise.all([wiring.worker.tick(), wiring.worker.tick()]);
    assert.equal(runs.length, 1, 'once per occurrence');
    assert.equal(runs[0]?.limit, DEFAULT_TRIGGER_LIMITS.modelCallsPerFiringMax, 'batch within the model-call cap');
    // Spec 2042 §5.10 — the batch (the scratch reaper's shape) runs in the
    // agent's turn context of the model gateway, not without a context.
    assert.deepEqual(runs[0]?.context, { kind: 'agent_turn', ownerId: 'erika', agentSlug: 'erika' });
    const [t] = await wiring.service.listForContext('memory', batchContextId(JOB, 'erika'));
    assert.equal(t?.runs, 1);
    assert.ok(Math.abs((t?.spentUsd ?? 0) - 0.01) < 1e-9, 'settled with the actual cost');

    pending.set('erika', 0);
    for (const hour of [10, 12, 14, 16]) {
      clock = new Date(`2026-11-23T${String(hour)}:30:00Z`);
      await wiring.worker.tick();
    }
    assert.equal(runs.length, 1, 'no run when nothing is due');
    const [after4] = await wiring.service.listForContext('memory', batchContextId(JOB, 'erika'));
    assert.equal(after4?.state, 'active', 'an empty check is a success, not a breaker trip');
  });

  it('a job that is gone ends its triggers', async () => {
    pending.set('erika', 1);
    await sync();
    unregister();
    try {
      assert.deepEqual(await sync(), { armed: 0, ended: 1 });
    } finally {
      unregister = registry.register(job);
    }
  });
});
