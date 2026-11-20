/**
 * #2082 (spec 2042 §5.12, ADR-0020) — Agent Builder schedules
 * (`agent_schedules`, P6) fire through bounded triggers instead of a minute
 * poller with unbounded model turns. Real Postgres: migrations 0003 (the
 * schedule table), 0093 (triggers) and 0095 (the schedule deadline).
 */

import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ChatTurnInput, SemanticAnswer } from '@omadia/channel-sdk';
import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { AgentGraphStore } from '../packages/harness-orchestrator/src/registry/agentGraphStore.js';
import { ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { runMultiOrchestratorMigrations } from '../packages/harness-orchestrator/src/registry/migrator.js';
import { recordUsage } from '../packages/harness-usage-telemetry/src/index.js';
import { createScheduleTriggerScheduler, type ScheduleTriggerScheduler } from '../src/triggers/scheduleTriggers.js';
import { DEFAULT_TRIGGER_LIMITS } from '../src/triggers/triggerPolicy.js';
import type { Trigger } from '../src/triggers/types.js';
import { wireTriggers, type TriggerWiring } from '../src/triggers/wiring.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'scheduleTriggers',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `schedule_triggers_${String(process.pid)}`;
const DAY = 86_400_000;

describe('#2082 Agent Builder schedules as triggers (pg)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let graph: AgentGraphStore;
  let clock = new Date('2026-11-23T07:00:00Z');
  let scheduler: ScheduleTriggerScheduler;
  let wiring: TriggerWiring;
  const notices: string[] = [];
  const inputs: ChatTurnInput[] = [];
  let agentId = '';

  const triggerOf = (scheduleId: string): Promise<Trigger | undefined> =>
    wiring.service.listForContext('schedule', scheduleId).then((t) => t[0]);

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 6, options: `-c search_path=${SCHEMA},public` });
    await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);
    agentId = (await new ConfigStore(pool).createAgent({ slug: 'erika', name: 'Erika' })).id;
    graph = new AgentGraphStore(pool);

    scheduler = createScheduleTriggerScheduler({
      service: () => wiring?.service,
      schedules: () => graph,
      agentById: (id) => (id === agentId ? { id, slug: 'erika' } : undefined),
      limits: () => DEFAULT_TRIGGER_LIMITS,
      notice: (_id, message) => notices.push(message),
      now: () => clock,
      log: () => undefined,
    });
    wiring = wireTriggers({
      pool,
      limits: DEFAULT_TRIGGER_LIMITS,
      recipientDefaults: { timezone: 'Europe/Berlin', quiet: { from: '00:00', to: '23:59' }, maxPerHour: 0 },
      enabled: true,
      tickMs: 60_000,
      leaseMs: 600_000,
      agentBySlug: (slug) => (slug === 'erika' ? { id: agentId, slug, enabled: true } : undefined),
      agentChat: () => ({
        chat: async (input: ChatTurnInput): Promise<SemanticAnswer> => {
          inputs.push(input);
          recordUsage({ source: 'test', model: 'scripted', inputTokens: 1, outputTokens: 1, costUsd: 0.02 });
          return { text: 'Erledigt.' };
        },
      }),
      readToolsOf: () => new Map(),
      grantedPluginIds: () => [],
      eventCatalog: () => ({}),
      channelPluginIds: () => [],
      senders: () => undefined,
      schedules: () => scheduler,
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
    notices.length = 0;
    inputs.length = 0;
    clock = new Date('2026-11-23T07:00:00Z');
    await pool.query('DELETE FROM agent_schedules');
    await pool.query('DELETE FROM agent_triggers');
  });

  const create = (cron = '0 8 * * *', status: 'enabled' | 'disabled' = 'enabled') =>
    graph.createSchedule({ agentId, cron, timezone: 'Europe/Berlin', payload: { prompt: 'Prüfe die Eingangsrechnungen' }, status });

  it('an enabled schedule gets one bounded, headless trigger', async () => {
    const row = await create();
    const first = await scheduler.sync();
    await scheduler.sync();
    assert.deepEqual(first, { armed: 1, ended: 0, expired: 0 });
    const triggers = await wiring.service.listForContextKind('schedule');
    assert.equal(triggers.length, 1, 'one trigger per schedule, however often synced');
    const t = triggers[0] as Trigger;
    assert.equal(t.contextId, row.id);
    assert.equal(t.origin, 'system');
    assert.equal(t.deliveryChannel, null);
    assert.equal(t.cron, '0 8 * * *');
    assert.equal(t.timezone, 'Europe/Berlin');
    assert.equal(t.until.getTime() - clock.getTime(), 30 * DAY, 'a 30-day deadline');
    assert.ok(t.budgetTotalUsd > 0 && t.maxRuns !== null, 'budget and run cap');
    assert.equal((await graph.getSchedule(row.id))?.until?.getTime(), t.until.getTime(), 'the row keeps the deadline');
  });

  it('fires its turn once per occurrence, without a recipient, and stamps the row', async () => {
    const row = await create();
    await scheduler.sync();
    clock = new Date('2026-11-24T08:30:00Z');
    await Promise.all([wiring.worker.tick(), wiring.worker.tick()]);
    assert.equal(inputs.length, 1, 'once, even with two workers');
    assert.equal(inputs[0]?.userMessage, 'Prüfe die Eingangsrechnungen');
    assert.match(inputs[0]?.extraSystemHint ?? '', /recorded, not sent/);
    const t = await triggerOf(row.id);
    assert.equal(t?.runs, 1);
    assert.ok(Math.abs((t?.spentUsd ?? 0) - 0.02) < 1e-9, 'settled with the actual cost');
    assert.ok((await graph.getSchedule(row.id))?.lastRunAt, 'last run stamped');
  });

  it('refuses a cron more often than every 15 minutes', async () => {
    await create('*/5 * * * *');
    assert.deepEqual(await scheduler.sync(), { armed: 0, ended: 0, expired: 0 });
  });

  it('a disabled or deleted schedule ends its trigger and never runs a turn', async () => {
    const row = await create();
    await scheduler.sync();
    await graph.deleteSchedule(row.id);
    clock = new Date('2026-11-24T08:30:00Z');
    await wiring.worker.tick();
    assert.equal(inputs.length, 0, 'no turn for a deleted schedule');
    assert.equal(await triggerOf(row.id), undefined, 'the trigger ended at its firing');

    const other = await create();
    await scheduler.sync();
    await pool.query("UPDATE agent_schedules SET status = 'disabled' WHERE id = $1", [other.id]);
    assert.deepEqual(await scheduler.sync(), { armed: 0, ended: 1, expired: 0 });
  });

  it('past its deadline the schedule is disabled with a notice; a renewal re-arms it', async () => {
    const row = await create();
    await scheduler.sync();
    clock = new Date(clock.getTime() + 31 * DAY);
    assert.deepEqual(await scheduler.sync(), { armed: 0, ended: 0, expired: 1 });
    assert.equal((await graph.getSchedule(row.id))?.status, 'disabled');
    assert.equal(await triggerOf(row.id), undefined);
    assert.equal(notices.length, 1);

    const renewed = await scheduler.renew(row.id, 'operator@test');
    assert.equal(renewed?.status, 'enabled');
    const t = await triggerOf(row.id);
    assert.equal(t?.until.getTime(), clock.getTime() + 30 * DAY);
  });
});
