/**
 * #2082 (spec 2042 §5.12, §6 criteria 20–23, 26, 32) — agent-owned triggers
 * against a real Postgres (migration 0093): durable at-most-once firing under
 * leases, budgets, circuit breaker, kill switch, context end, cheap first.
 *
 * The model is scripted (a step executor that counts its calls): the
 * guarantees under test are the harness's, not the model's.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { readersOf, unionLabels } from '../packages/harness-orchestrator/src/discretion/labels.js';

import { ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { runMultiOrchestratorMigrations } from '../packages/harness-orchestrator/src/registry/migrator.js';
import { storeContextChecks } from '../src/triggers/contextChecks.js';
import type { DataActionResult, StepExecutors, TurnOutcome } from '../src/triggers/triggerChain.js';
import { TriggerEngine, type OperatorNotice, type SendWindow } from '../src/triggers/triggerEngine.js';
import { DEFAULT_TRIGGER_LIMITS, type TriggerEnvelope, type TriggerLimits } from '../src/triggers/triggerPolicy.js';
import { TriggerService } from '../src/triggers/triggerService.js';
import { spendMonth, TriggerStore } from '../src/triggers/triggerStore.js';
import { TriggerWorker } from '../src/triggers/triggerWorker.js';
import type { Trigger, TriggerKind } from '../src/triggers/types.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'agentTriggers',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `agent_triggers_${String(process.pid)}`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface Script {
  /** What the scripted model does on a turn. */
  turn: (trigger: Trigger) => TurnOutcome | Promise<TurnOutcome>;
  data: (trigger: Trigger) => DataActionResult;
  newActivity?: boolean;
}

describe('#2082 agent triggers (pg, migration 0093)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  const agents = new Map<string, { id: string; slug: string; enabled: boolean }>();
  let clock = new Date();
  const now = (): Date => clock;
  let calls: { turns: number; posts: string[]; delivers: number; data: number };
  let notices: OperatorNotice[];
  let script: Script;
  let window: (t: Trigger) => SendWindow;

  const limits = (over: Partial<TriggerLimits> = {}): TriggerLimits => ({ ...DEFAULT_TRIGGER_LIMITS, ...over });

  function rig(l: TriggerLimits = limits(), useStoreActivity = false) {
    const store = new TriggerStore(pool);
    const checks = storeContextChecks(store);
    const executors: StepExecutors = {
      newActivity: async (t, o) => (useStoreActivity ? checks.newActivity(t, o) : (script.newActivity ?? true)),
      contextLive: (t) => checks.contextLive(t),
      runDataAction: async (t) => {
        calls.data += 1;
        return script.data(t);
      },
      post: async (_t, text) => {
        calls.posts.push(text);
        return { delivered: true };
      },
      deliver: async () => {
        calls.delivers += 1;
        return { delivered: true };
      },
      turn: async (t) => {
        calls.turns += 1;
        return script.turn(t);
      },
      batch: async () => ({ due: 0, processed: 0, costUsd: 0, modelCalls: 0 }),
    };
    const engine = new TriggerEngine({
      store,
      limits: l,
      executors,
      resolveAgent: (slug) => agents.get(slug),
      sendWindow: async (t) => window(t),
      notifyOperator: (n) => notices.push(n),
      now,
    });
    const service = new TriggerService({
      store,
      limits: l,
      eventSources: () => [{ eventId: 'conversation.message.created', source: 'kernel' }],
      checkDataAction: () => undefined,
      targetAllowed: () => false,
      now,
    });
    const worker = new TriggerWorker({
      store,
      engine,
      intervalMs: 60_000,
      leaseMs: 10 * MIN,
      maxAttempts: 3,
      batch: 50,
      enabled: () => true,
      now,
    });
    return { store, engine, service, worker };
  }

  const envFor = (slug: string, over: Partial<TriggerEnvelope> = {}): TriggerEnvelope => ({
    agentId: (agents.get(slug) as { id: string }).id,
    agentSlug: slug,
    origin: 'agent',
    ownerKey: null,
    contextKind: 'conversation',
    contextId: `teams:19:${slug}`,
    liveContext: false,
    deliveryChannel: 'teams',
    deliveryRef: { conversationId: `19:${slug}` },
    discretion: null,
    createdBy: `agent:${slug}`,
    ...over,
  });

  const at = (ms: number): string => new Date(clock.getTime() + ms).toISOString();

  async function create(
    service: TriggerService,
    kind: TriggerKind,
    raw: Record<string, unknown>,
    env: TriggerEnvelope,
  ): Promise<Trigger> {
    const res = await service.create(kind, raw, env);
    assert.ok(res.ok, JSON.stringify(res));
    return res.trigger;
  }

  async function rowCount(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM (${sql}) q`, params);
    return Number(rows[0]?.n ?? 0);
  }

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 8, options: `-c search_path=${SCHEMA},public` });
    await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);
    // The CI schema job applies everything twice.
    await pool.query(await readFile(resolve(MIGRATIONS_DIR, '0093_agent_triggers.sql'), 'utf8'));
    const config = new ConfigStore(pool);
    for (const slug of ['erika', 'max', 'sim1', 'sim2', 'sim3', 'sim4', 'meet', 'kill']) {
      const agent = await config.createAgent({ slug, name: slug });
      agents.set(slug, { id: agent.id, slug, enabled: true });
    }
  });

  after(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await pool?.end();
  });

  beforeEach(async () => {
    clock = new Date();
    calls = { turns: 0, posts: [], delivers: 0, data: 0 };
    notices = [];
    window = () => ({ ok: true });
    script = {
      turn: () => ({ delivered: true, costUsd: 0.01, modelCalls: 1 }),
      data: () => ({ ok: true, rows: [], columns: [], raw: [] }),
    };
    await pool.query('DELETE FROM agent_triggers');
    await pool.query('DELETE FROM agent_trigger_spend');
    await pool.query('DELETE FROM agent_trigger_reservations');
    await pool.query('DELETE FROM agent_trigger_context_activity');
    await pool.query('DELETE FROM execution_kill_switches');
  });

  describe('INV-9 — the creating conversation\'s discretion', () => {
    it('is stored with the trigger and read back; a row without it has none', async () => {
      const { service, store } = rig();
      const labels = unionLabels([
        { kind: 'context', key: 'teams:19:erika', readers: readersOf(['a', 'b']) },
        { kind: 'source', system: 'odoo', restricted: true },
      ]);
      const raw = { purpose: 'Erinnerung', time: at(HOUR), until: at(2 * HOUR), actions: [{ type: 'post', template: 'Hallo' }] };
      const discretion = { contextKey: 'teams:19:erika', readers: readersOf(['a', 'b', 'c']), labels };
      const t = await create(service, 'wake_at', raw, envFor('erika', { discretion }));
      assert.deepEqual((await store.get(t.id))?.discretion, discretion);
      await pool.query(`UPDATE agent_triggers SET labels = '[]'::jsonb WHERE id = $1`, [t.id]);
      assert.equal((await store.get(t.id))?.discretion, null, 'a row written before it');
      await pool.query(`UPDATE agent_triggers SET labels = '{"contextKey":"teams:19:erika","readers":{"kind":"set","ids":[5]},"labels":"junk"}'::jsonb WHERE id = $1`, [t.id]);
      const damaged = (await store.get(t.id))?.discretion;
      assert.equal(damaged?.readers.kind, 'unknown', 'damaged readers fail closed');
      assert.ok(damaged?.labels.labels.some((l) => l.kind === 'context' && l.readers.kind === 'unknown'), 'damaged labels fail closed');
      await pool.query(`UPDATE agent_triggers SET labels = '{"contextKey":5}'::jsonb WHERE id = $1`, [t.id]);
      assert.equal((await store.get(t.id))?.discretion?.readers.kind, 'unknown', 'a damaged record is not "no discretion"');
    });
  });

  describe('criterion 23 — one-shot wakeup', () => {
    it('fires once, sends the overview and is gone, also across a restart and two workers', async () => {
      const first = rig();
      const t = await create(
        first.service,
        'wake_at',
        {
          purpose: 'Offene Spesenberichte vor Monatsende',
          time: at(3 * DAY),
          until: at(4 * DAY),
          actions: [
            { type: 'check', check: 'data', action: { tool: 'expenses_open', input: {} }, condition: 'rows' },
            { type: 'deliver', action: { tool: 'expenses_open', input: {} }, title: 'Offene Spesenberichte' },
          ],
        },
        envFor('erika'),
      );
      script.data = () => ({ ok: true, rows: [{ id: 1 }, { id: 2 }], columns: ['id'], raw: [{ id: 1 }, { id: 2 }] });

      // Before it is due nothing happens.
      assert.equal(await first.worker.tick(), 0);

      // "Restart": new store, engine and workers on the same database.
      clock = new Date(clock.getTime() + 3 * DAY + MIN);
      const a = rig();
      const b = rig();
      const fired = await Promise.all([a.worker.tick(), b.worker.tick(), a.worker.tick()]);
      assert.equal(fired.reduce((x, y) => x + y, 0), 1);
      assert.equal(calls.delivers, 1, 'the overview went out once');
      assert.equal(calls.data, 1, 'the check and the delivery share one data action');
      assert.equal(calls.turns, 0);
      assert.equal(await a.service.get(t.id), undefined, 'the wakeup is gone');
      assert.equal(await a.worker.tick(), 0);
      const events = (await pool.query<{ event: string }>('SELECT event FROM agent_trigger_audit WHERE trigger_id = $1 ORDER BY id', [t.id])).rows.map((r) => r.event);
      assert.deepEqual(events, ['created', 'fired', 'ended']);
    });

    it('a worker that dies mid-firing: a droppable occurrence is dropped, an essential one retried', async () => {
      const r = rig();
      const droppable = await create(r.service, 'wake_at', { purpose: 'nudge', time: at(MIN), until: at(HOUR), actions: [{ type: 'post', template: 'Hallo' }] }, envFor('erika'));
      const essential = await create(r.service, 'wake_at', { purpose: 'must', time: at(MIN), until: at(HOUR), delivery: 'essential', actions: [{ type: 'post', template: 'Wichtig' }] }, envFor('max'));
      clock = new Date(clock.getTime() + 2 * MIN);
      // A worker claims both and dies before finishing.
      const claimed = await r.store.claimDue('dead-worker', clock, 10 * MIN, 10);
      assert.equal(claimed.length, 2);
      clock = new Date(clock.getTime() + 11 * MIN);
      await r.worker.tick();
      assert.deepEqual(calls.posts, ['Wichtig'], 'only the essential one fired again');
      const state = (await pool.query<{ state: string; outcome: string }>(
        `SELECT o.state, o.outcome FROM agent_trigger_occurrences o WHERE o.trigger_id = $1`,
        [droppable.id],
      )).rows[0];
      assert.equal(state?.state, 'dropped');
      assert.equal(state?.outcome, 'lease_expired');
      assert.equal(await r.service.get(essential.id), undefined);
    });
  });

  describe('criterion 21 — cheap first', () => {
    it('a timer with nothing new since its last firing makes no model call and is not a failure', async () => {
      const r = rig(limits(), true);
      const t = await create(r.service, 'wake_every', {
        purpose: 'Diskussion im Blick',
        interval: '15m',
        until: at(DAY),
        max_runs: 50,
        actions: [{ type: 'turn', instruction: 'Fasse den Stand zusammen, falls etwas Neues kam' }],
      }, envFor('erika'));
      clock = new Date(clock.getTime() + 16 * MIN);
      await r.worker.tick();
      assert.equal(calls.turns, 0);
      const after1 = await r.service.get(t.id);
      assert.equal(after1?.lastOutcome, 'nothing');
      assert.equal(after1?.consecutiveFailures, 0);
      // Something new arrives: the next firing reaches the model.
      await r.service.onEvent('conversation.message.created', { channelType: 'teams', conversationId: '19:erika' }, 'm1');
      clock = new Date(clock.getTime() + 15 * MIN);
      await r.worker.tick();
      assert.equal(calls.turns, 1);
    });
  });

  describe('criterion 32 — waiting is not failing', () => {
    it('five empty checks, then an overdue invoice on the sixth: it still acts', async () => {
      const r = rig();
      let firing = 0;
      script.data = () => {
        firing += 1;
        return firing < 6
          ? { ok: true, rows: [], columns: ['invoice'], raw: [] }
          : { ok: true, rows: [{ invoice: 'R-17' }], columns: ['invoice'], raw: [{ invoice: 'R-17' }] };
      };
      const t = await create(r.service, 'wake_every', {
        purpose: 'Überfällige Rechnungen',
        interval: '1h',
        until: at(2 * DAY),
        max_runs: 24,
        actions: [
          { type: 'check', check: 'data', action: { tool: 'invoices_overdue', input: {} }, condition: 'rows' },
          { type: 'deliver', action: { tool: 'invoices_overdue', input: {} } },
        ],
      }, envFor('erika'));
      for (let i = 0; i < 6; i += 1) {
        clock = new Date(clock.getTime() + HOUR + MIN);
        await r.worker.tick();
      }
      assert.equal(calls.delivers, 1);
      const row = await r.service.get(t.id);
      assert.equal(row?.state, 'active');
      assert.equal(row?.runs, 6);
      assert.equal(row?.lastOutcome, 'acted');
      assert.equal(row?.consecutiveFailures, 0);
    });
  });

  describe('criterion 22 — context end', () => {
    it('ending a meeting ends its message hook and its time-keeping timer in one transaction', async () => {
      const r = rig();
      const env = envFor('meet', { contextKind: 'meeting', contextId: 'teams:19:meeting-1', liveContext: true });
      const hook = await create(r.service, 'on_event', {
        purpose: 'Neue Beiträge',
        event: 'conversation.message.created',
        until: at(2 * HOUR),
        max_fires: 100,
        actions: [{ type: 'post', template: 'Danke für den Beitrag' }],
      }, env);
      const timer = await create(r.service, 'wake_every', {
        purpose: 'Zeitwächter',
        interval: '5m',
        until: at(2 * HOUR),
        max_runs: 24,
        actions: [{ type: 'post', template: 'Noch {{minutes_left}} Minuten' }],
      }, env);
      const ended = await r.service.endContext('meeting', 'teams:19:meeting-1');
      assert.deepEqual(ended.map((t) => t.id).sort(), [hook.id, timer.id].sort());
      assert.equal(await rowCount('SELECT 1 FROM agent_triggers WHERE context_id = $1', ['teams:19:meeting-1']), 0);
      assert.equal(await rowCount('SELECT 1 FROM agent_trigger_occurrences WHERE trigger_id = ANY($1)', [[hook.id, timer.id]]), 0);
      const audit = (await pool.query<{ at: Date; detail: { reason: string } }>(
        `SELECT at, detail FROM agent_trigger_audit WHERE trigger_id = ANY($1) AND event = 'ended'`,
        [[hook.id, timer.id]],
      )).rows;
      assert.equal(audit.length, 2);
      assert.ok(audit.every((a) => a.detail.reason === 'context_ended'));
      assert.equal(audit[0]?.at.getTime(), audit[1]?.at.getTime(), 'one transaction, one timestamp');
      // A late event for the ended meeting enqueues nothing.
      assert.equal(await r.service.onEvent('conversation.message.created', { channelType: 'teams', conversationId: '19:meeting-1' }, 'late'), 0);
    });
  });

  describe('criterion 26 — deterministic firings in a meeting', () => {
    it('60 minutes, a 5-minute timer and a message hook: posts without a model; one summary turn', async () => {
      const r = rig();
      const env = envFor('meet', { contextKind: 'meeting', contextId: 'teams:19:meeting-2', liveContext: true });
      await create(r.service, 'wake_every', {
        purpose: 'Zeitwächter',
        interval: '5m',
        until: at(60 * MIN + 30_000),
        max_runs: 12,
        actions: [{ type: 'post', template: 'Noch {{minutes_left}} Minuten für diesen Schritt' }],
      }, env);
      await create(r.service, 'on_event', {
        purpose: 'Offene Beiträge',
        event: 'conversation.message.created',
        until: at(60 * MIN + 30_000),
        max_fires: 50,
        filter: { op: 'eq', path: 'ctx.kind', value: 'question' },
        actions: [{ type: 'post', template: 'Notiert: {{event.kind}}' }],
      }, env);
      await create(r.service, 'wake_at', {
        purpose: 'Zusammenfassung',
        time: at(59 * MIN),
        until: at(60 * MIN + 30_000),
        actions: [{ type: 'turn', instruction: 'Fasse das Meeting zusammen' }],
      }, env);
      for (let minute = 1; minute <= 60; minute += 1) {
        clock = new Date(clock.getTime() + MIN);
        if (minute % 7 === 0) {
          await r.service.onEvent('conversation.message.created', { channelType: 'teams', conversationId: '19:meeting-2', kind: 'question', author: `p${String(minute)}` }, `q${String(minute)}`);
          await r.service.onEvent('conversation.message.created', { channelType: 'teams', conversationId: '19:meeting-2', kind: 'chat', author: 'x' }, `c${String(minute)}`);
        }
        await r.worker.tick();
      }
      const timekeeping = calls.posts.filter((p) => p.startsWith('Noch'));
      const hooks = calls.posts.filter((p) => p.startsWith('Notiert'));
      assert.equal(timekeeping.length, 12);
      assert.equal(hooks.length, 8, 'only the questions matched the filter');
      assert.equal(calls.turns, 1, 'the only model call is the summary');
    });
  });

  describe('criterion 20 — bounded over 30 simulated days', () => {
    it('no trigger exceeds its budget, a failing trigger pauses at the breaker, the instance cap holds', async () => {
      const l = limits({ monthlyInstanceUsd: 3, monthlyAgentUsd: 2 });
      const r = rig(l);
      script.turn = (t) =>
        t.agentSlug === 'sim1'
          ? { delivered: false, costUsd: 0.02, modelCalls: 1, error: 'scripted model failure' }
          : t.agentSlug === 'sim4'
            ? { delivered: false, costUsd: 0.02, modelCalls: 1 }
            : { delivered: true, costUsd: 0.05, modelCalls: 2 };
      const triggers: Trigger[] = [];
      for (const slug of ['sim1', 'sim2', 'sim3', 'sim4']) {
        for (let i = 0; i < 2; i += 1) {
          triggers.push(
            await create(r.service, 'wake_every', {
              purpose: `${slug}-${String(i)}`,
              interval: '1h',
              until: at(30 * DAY - MIN),
              max_runs: 10_000,
              budget: { per_firing_usd: 0.05, total_usd: 1.5 },
              actions: [{ type: 'turn', instruction: 'Prüfe und berichte' }],
            }, envFor(slug)),
          );
        }
      }
      const months = new Set<string>();
      for (let hour = 1; hour <= 30 * 24; hour += 1) {
        clock = new Date(clock.getTime() + HOUR);
        months.add(spendMonth(clock));
        await r.worker.tick();
      }
      for (const month of months) {
        const instance = await r.store.monthSpend('instance', month);
        assert.ok(instance.spentUsd <= l.monthlyInstanceUsd + 1e-9, `instance ${month}: ${String(instance.spentUsd)}`);
        for (const slug of ['sim1', 'sim2', 'sim3', 'sim4']) {
          const agent = await r.store.monthSpend((agents.get(slug) as { id: string }).id, month);
          assert.ok(agent.spentUsd <= l.monthlyAgentUsd + 1e-9, `${slug} ${month}: ${String(agent.spentUsd)}`);
        }
      }
      const audit = (await pool.query<{ trigger_id: string; cost: string }>(
        `SELECT trigger_id, sum(cost_usd)::text AS cost FROM agent_trigger_audit WHERE trigger_id = ANY($1) GROUP BY trigger_id`,
        [triggers.map((t) => t.id)],
      )).rows;
      for (const row of audit) assert.ok(Number(row.cost) <= 1.5 + 1e-9, `trigger ${row.trigger_id}: ${row.cost}`);

      // Paused triggers still end at their deadline (deleted, not kept paused);
      // the audit tells how each one went.
      const auditOf = async (id: string): Promise<Array<{ event: string; detail: { reason?: string; outcome?: string } }>> =>
        (await pool.query<{ event: string; detail: { reason?: string; outcome?: string } }>(
          'SELECT event, detail FROM agent_trigger_audit WHERE trigger_id = $1 ORDER BY id',
          [id],
        )).rows;
      for (const t of triggers.filter((x) => x.agentSlug === 'sim1')) {
        const events = await auditOf(t.id);
        const pausedAt = events.findIndex((e) => e.event === 'paused');
        assert.equal(events[pausedAt]?.detail.reason, 'breaker_failures');
        assert.equal(events.slice(0, pausedAt).filter((e) => e.event === 'fired').length, l.breakerFailures, 'paused right at the threshold');
        assert.equal(events.slice(pausedAt + 1).filter((e) => e.event === 'fired').length, 0, 'never fired again');
        assert.equal(events.at(-1)?.detail.reason, 'expired');
      }
      for (const t of triggers.filter((x) => x.agentSlug === 'sim4')) {
        const events = await auditOf(t.id);
        assert.equal(events.find((e) => e.event === 'paused')?.detail.reason, 'breaker_ineffective');
      }
      assert.equal(await rowCount('SELECT 1 FROM agent_triggers'), 0, 'every trigger ended at its deadline');
      assert.ok(notices.some((n) => n.reason === 'breaker_failures'));
      assert.ok(notices.some((n) => n.reason === 'budget'), 'reaching a cap pauses with a notice');
    });
  });

  describe('kill switch and quiet hours', () => {
    it('an instance kill switch refuses every firing; the timer keeps its schedule', async () => {
      const r = rig();
      const t = await create(r.service, 'wake_every', { purpose: 'x', interval: '15m', until: at(DAY), max_runs: 10, actions: [{ type: 'post', template: 'tick' }] }, envFor('kill'));
      await pool.query(`INSERT INTO execution_kill_switches (level, reason, set_by) VALUES ('instance', 'test', 'op')`);
      clock = new Date(clock.getTime() + 16 * MIN);
      await r.worker.tick();
      assert.equal(calls.posts.length, 0);
      const row = await r.service.get(t.id);
      assert.equal(row?.runs, 0);
      assert.equal(row?.lastOutcome, 'refused');
      await pool.query('UPDATE execution_kill_switches SET cleared_at = now(), cleared_by = $1', ['op']);
      clock = new Date(clock.getTime() + 15 * MIN);
      await r.worker.tick();
      assert.deepEqual(calls.posts, ['tick']);
    });

    it('a one-shot wakeup refused by the kill switch ends instead of lingering', async () => {
      const r = rig();
      const t = await create(r.service, 'wake_at', { purpose: 'x', time: at(MIN), until: at(DAY), actions: [{ type: 'post', template: 'x' }] }, envFor('kill'));
      await pool.query(`INSERT INTO execution_kill_switches (level, reason, set_by) VALUES ('instance', 'test', 'op')`);
      clock = new Date(clock.getTime() + 2 * MIN);
      await r.worker.tick();
      assert.equal(calls.posts.length, 0);
      assert.equal(await r.service.get(t.id), undefined, 'nothing left to wait for');
    });

    it('a firing in quiet hours is deferred, not run and not spent', async () => {
      const r = rig();
      await create(r.service, 'wake_at', { purpose: 'x', time: at(MIN), until: at(DAY), actions: [{ type: 'turn', instruction: 'go' }] }, envFor('erika'));
      const morning = new Date(clock.getTime() + 8 * HOUR);
      window = () => (clock < morning ? { ok: false, deferUntil: morning, reason: 'quiet_hours' } : { ok: true });
      clock = new Date(clock.getTime() + 2 * MIN);
      await r.worker.tick();
      assert.equal(calls.turns, 0);
      assert.equal((await r.store.monthSpend('instance', spendMonth(clock))).reservedUsd, 0);
      clock = new Date(morning.getTime() + MIN);
      await r.worker.tick();
      assert.equal(calls.turns, 1);
    });
  });

  describe('the per-agent cap', () => {
    it('bounds what the agent sets itself; system and routine triggers do not count', async () => {
      const { service } = rig(limits({ maxActivePerAgent: 2 }));
      const env = envFor('max', { contextId: 'teams:19:cap' });
      const raw = (purpose: string) => ({ purpose, time: at(HOUR), until: at(2 * HOUR), actions: [{ type: 'post', template: 'x' }] });
      for (const purpose of ['s1', 's2', 's3']) {
        await create(service, 'wake_at', raw(purpose), { ...env, origin: 'system', contextKind: 'schedule', contextId: `cap-${purpose}`, deliveryChannel: null });
      }
      await create(service, 'wake_at', raw('a1'), env);
      await create(service, 'wake_at', raw('a2'), env);
      const third = await service.create('wake_at', raw('a3'), env);
      assert.equal(third.ok === false && third.code, 'too_many_active');
    });
  });

  describe('reservations', () => {
    const spendOf = async (scope: string): Promise<{ spent: number; reserved: number }> => {
      const { rows } = await pool.query<{ spent_usd: string; reserved_usd: string }>(
        'SELECT spent_usd, reserved_usd FROM agent_trigger_spend WHERE scope = $1',
        [scope],
      );
      return { spent: Number(rows[0]?.spent_usd ?? 0), reserved: Number(rows[0]?.reserved_usd ?? 0) };
    };
    const turnTrigger = (service: TriggerService, ctx: string) =>
      create(
        service,
        'wake_at',
        { purpose: 'p', time: at(MIN), until: at(HOUR), actions: [{ type: 'turn', instruction: 'x' }] },
        envFor('erika', { contextId: `teams:19:${ctx}` }),
      );

    it('a trigger ended mid-firing still settles its agent\'s month', async () => {
      const r = rig();
      const t = await turnTrigger(r.service, 'res-1');
      script.turn = async () => {
        await r.service.end(t.id, 'cancelled', {});
        return { delivered: true, costUsd: 0.05, modelCalls: 1 };
      };
      clock = new Date(clock.getTime() + 2 * MIN);
      await r.worker.tick();
      assert.equal(calls.turns, 1);
      const agent = await spendOf(t.agentId);
      assert.equal(agent.reserved, 0, 'nothing stays reserved for the agent');
      assert.ok(Math.abs(agent.spent - 0.05) < 1e-9, 'the cost is booked on the agent');
      assert.equal((await spendOf('instance')).reserved, 0);
    });

    it('a firing whose lease ran out books its cost and leaves the run to the recovery', async () => {
      const r = rig();
      const t = await turnTrigger(r.service, 'res-2');
      script.turn = async () => {
        // Another replica sees the lease expired and recovers it meanwhile.
        await r.store.recoverExpiredLeases(new Date(clock.getTime() + 11 * MIN), 3);
        return { delivered: true, costUsd: 0.02, modelCalls: 1 };
      };
      clock = new Date(clock.getTime() + 2 * MIN);
      await r.worker.tick();
      const after = await r.service.get(t.id);
      assert.equal(after?.runs, 0, 'the run is not counted by the worker that lost the lease');
      assert.ok(Math.abs((after?.spentUsd ?? 0) - 0.02) < 1e-9);
      assert.equal(after?.reservedUsd, 0);
      assert.equal((await spendOf(t.agentId)).reserved, 0);
    });
  });
});
