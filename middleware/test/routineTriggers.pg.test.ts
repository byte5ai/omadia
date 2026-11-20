/**
 * #2082 (spec 2042 §5.12, §6 criterion 28 "a routine stays pausable by its
 * human owner") — routines are user-requested triggers. Real Postgres: the
 * routine series (0001–0006) and the core migrations (0093, 0094).
 *
 * The routine keeps its owner, controls, cron and run history; the trigger
 * engine fires it once per occurrence, within a deadline and a budget; the
 * owner is asked before the deadline and can renew.
 */

import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ChatTurnInput, ChatTurnResult, SemanticAnswer } from '@omadia/channel-sdk';
import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { runMultiOrchestratorMigrations } from '../packages/harness-orchestrator/src/registry/migrator.js';
import { recordUsage } from '../packages/harness-usage-telemetry/src/index.js';
import { runRoutineMigrations } from '../src/plugins/routines/migrator.js';
import { InMemoryProactiveSenderRegistry } from '../src/plugins/routines/proactiveSender.js';
import { RoutineRunner } from '../src/plugins/routines/routineRunner.js';
import { RoutineRunsStore } from '../src/plugins/routines/routineRunsStore.js';
import { RoutineStore } from '../src/plugins/routines/routineStore.js';
import { createRoutineTriggerScheduler, type RoutineTriggerScheduler } from '../src/triggers/routineTriggers.js';
import { DEFAULT_TRIGGER_LIMITS } from '../src/triggers/triggerPolicy.js';
import { wireTriggers, type TriggerWiring } from '../src/triggers/wiring.js';
import type { Trigger } from '../src/triggers/types.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'routineTriggers',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `routine_triggers_${String(process.pid)}`;
const DAY = 86_400_000;
const owner = { kind: 'channel-user' as const, tenant: 't1', userId: 'anna' };

async function waitFor<T>(probe: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const v = await probe();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('#2082 routines as triggers (pg)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let clock = new Date('2026-11-23T07:00:00Z');
  let store: RoutineStore;
  let runner: RoutineRunner;
  let scheduler: RoutineTriggerScheduler;
  let wiring: TriggerWiring;
  const sent: string[] = [];
  let turns = 0;
  let agentId = '';

  const triggerOf = (routineId: string): Promise<Trigger | undefined> =>
    wiring.service.listForContext('routine', routineId).then((t) => t[0]);

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 6, options: `-c search_path=${SCHEMA},public` });
    await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);
    await runRoutineMigrations(pool);
    agentId = (await new ConfigStore(pool).createAgent({ slug: 'erika', name: 'Erika' })).id;

    store = new RoutineStore({ pool, log: () => undefined });
    const senders = new InMemoryProactiveSenderRegistry();
    senders.register({
      channel: 'teams',
      send: async ({ message }: { message: SemanticAnswer }) => {
        sent.push(message.text);
      },
    });
    scheduler = createRoutineTriggerScheduler({
      service: () => wiring?.service,
      routines: () => store,
      resolveAgent: (slug) => (slug === null || slug === 'erika' ? { id: agentId, slug: 'erika' } : undefined),
      askOwner: async (_r, text) => {
        sent.push(text);
      },
      limits: () => DEFAULT_TRIGGER_LIMITS,
      now: () => clock,
      log: () => undefined,
    });
    runner = new RoutineRunner({
      store,
      runsStore: new RoutineRunsStore({ pool, log: () => undefined }),
      scheduler,
      getOrchestrator: () => ({
        runTurn: async (_input: ChatTurnInput): Promise<ChatTurnResult> => {
          turns += 1;
          recordUsage({ source: 'test', model: 'scripted', inputTokens: 1, outputTokens: 1, costUsd: 0.04 });
          return { answer: `Bericht ${String(turns)}`, toolCalls: 0, iterations: 1 } as ChatTurnResult;
        },
      }),
      senderRegistry: senders,
      log: () => undefined,
    });
    wiring = wireTriggers({
      pool,
      limits: DEFAULT_TRIGGER_LIMITS,
      recipientDefaults: { timezone: 'Europe/Berlin', quiet: { from: '22:00', to: '07:00' }, maxPerHour: 6 },
      enabled: true,
      tickMs: 60_000,
      leaseMs: 600_000,
      agentBySlug: (slug) => (slug === 'erika' ? { id: agentId, slug, enabled: true } : undefined),
      agentChat: () => undefined,
      readToolsOf: () => new Map(),
      grantedPluginIds: () => [],
      eventCatalog: () => ({}),
      channelPluginIds: () => [],
      senders: () => senders,
      routines: () => scheduler,
      registerNativeTool: () => () => undefined,
      now: () => clock,
      log: () => undefined,
    });
  });

  after(async () => {
    wiring?.stop();
    runner?.stop();
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await pool?.end();
  });

  beforeEach(async () => {
    sent.length = 0;
    turns = 0;
    clock = new Date('2026-11-23T07:00:00Z');
    await pool.query('DELETE FROM routines');
    await pool.query('DELETE FROM agent_triggers');
  });

  const create = (name: string, cron = '0 8 * * *') =>
    runner.createRoutine({
      tenant: 't1',
      userId: 'anna',
      name,
      cron,
      prompt: 'Fasse die offenen Tickets zusammen',
      channel: 'teams',
      conversationRef: { conversationId: 'a:1' },
      agentSlug: 'erika',
    });

  it('a routine gets one bounded trigger and fires through it, once per occurrence', async () => {
    const routine = await create('Morgenbericht');
    const t = await waitFor(() => triggerOf(routine.id), 'the routine trigger');
    assert.equal(t.origin, 'routine');
    assert.equal(t.ownerKey, 't1\nanna');
    assert.equal(t.cron, '0 8 * * *');
    assert.equal(t.until.getTime() - clock.getTime(), 30 * DAY, 'a 30-day deadline');
    assert.deepEqual(t.actions.map((a) => a.type), ['turn'], 'no "nothing new" pre-check for a routine');
    assert.equal((await store.get(routine.id))?.until?.getTime(), t.until.getTime());

    // 08:00 Berlin = 07:00 UTC is the server-zone cron here; fire the next day's slot.
    clock = new Date('2026-11-24T09:00:00Z');
    await Promise.all([wiring.worker.tick(), wiring.worker.tick()]);
    assert.equal(turns, 1);
    assert.deepEqual(sent, ['Bericht 1']);
    const after1 = await triggerOf(routine.id);
    assert.equal(after1?.runs, 1);
    assert.ok(Math.abs((after1?.spentUsd ?? 0) - 0.04) < 1e-9, 'settled with the actual cost');
    const row = await store.get(routine.id);
    assert.equal(row?.lastRunStatus, 'ok', 'the run history stays the routine\'s');
  });

  it('refuses a routine more often than every 15 minutes', async () => {
    await assert.rejects(() => create('Zu oft', '*/5 * * * *'), /at most every 15 minutes/);
    assert.equal(await store.getByName('t1', 'anna', 'Zu oft'), null, 'rolled back');
  });

  it('criterion 28: the owner pauses, resumes and deletes; the trigger follows', async () => {
    const routine = await create('Wochenbericht');
    await waitFor(() => triggerOf(routine.id), 'the routine trigger');
    await runner.pauseRoutine(routine.id, owner);
    await waitFor(async () => ((await triggerOf(routine.id))?.state === 'paused' ? true : undefined), 'paused trigger');
    clock = new Date('2026-11-24T09:00:00Z');
    await wiring.worker.tick();
    assert.equal(turns, 0, 'a paused routine does not fire');

    await runner.resumeRoutine(routine.id, owner);
    await waitFor(async () => ((await triggerOf(routine.id))?.state === 'active' ? true : undefined), 'resumed trigger');
    clock = new Date('2026-11-25T09:00:00Z');
    await wiring.worker.tick();
    assert.equal(turns, 1);

    await runner.deleteRoutine(routine.id, owner);
    await waitFor(async () => ((await triggerOf(routine.id)) === undefined ? true : undefined), 'ended trigger');
  });

  it('asks the owner once before the deadline; renewing moves it; past it the routine is paused', async () => {
    const routine = await create('Monatsabschluss');
    const t = await waitFor(() => triggerOf(routine.id), 'the routine trigger');

    clock = new Date(t.until.getTime() - 2 * DAY);
    await scheduler.sweep();
    await scheduler.sweep();
    assert.equal(sent.filter((m) => m.includes('läuft am')).length, 1, 'asked once');
    assert.match(sent[0] ?? '', /Monatsabschluss/);

    await runner.renewRoutine(routine.id, owner);
    const renewed = await waitFor(async () => {
      const x = await triggerOf(routine.id);
      return x && x.until.getTime() > t.until.getTime() ? x : undefined;
    }, 'the renewed deadline');
    assert.equal(renewed.until.getTime() - clock.getTime(), 30 * DAY);
    assert.equal((await store.get(routine.id))?.renewalAskedAt, null, 'asked again before the new deadline');

    clock = new Date(renewed.until.getTime() + 60_000);
    await scheduler.sweep();
    const expired = await store.get(routine.id);
    assert.equal(expired?.status, 'paused');
    assert.match(expired?.lastRunError ?? '', /abgelaufen/);
    assert.equal(await triggerOf(routine.id), undefined, 'an expired trigger is deleted');
  });

  it('a restart arms routines again without a second trigger or a catch-up storm', async () => {
    const routine = await create('Tagesbericht');
    await waitFor(() => triggerOf(routine.id), 'the routine trigger');
    runner.stop();
    const restarted = new RoutineRunner({
      store,
      runsStore: new RoutineRunsStore({ pool, log: () => undefined }),
      scheduler,
      getOrchestrator: () => ({
        runTurn: async (): Promise<ChatTurnResult> => {
          turns += 1;
          return { answer: 'nach Neustart', toolCalls: 0, iterations: 1 } as ChatTurnResult;
        },
      }),
      senderRegistry: (runner as unknown as { senders: InMemoryProactiveSenderRegistry }).senders,
      log: () => undefined,
    });
    await restarted.start();
    await new Promise((r) => setTimeout(r, 100));
    const all = await wiring.service.listForContext('routine', routine.id);
    assert.equal(all.length, 1);
    // Three days of downtime: one late firing, not three.
    clock = new Date('2026-11-27T09:00:00Z');
    await wiring.worker.tick();
    await wiring.worker.tick();
    assert.equal(turns, 1);
    runner = restarted;
  });
});
