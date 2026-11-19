/**
 * #2090 (spec 2043 §0) — execution scopes, reservations and the kill switch
 * against a real Postgres (migration 0073).
 *
 * The guarantees are the server's: one statement takes the last budget unit
 * for exactly one of two workers, a partial unique index is the reservation,
 * and the counters are rows, so a "restart" (a new store on the same
 * database) finds them.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ExecutionAuthorizationService, ExecutionRefusal } from '@omadia/plugin-api';
import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { runMultiOrchestratorMigrations } from '../packages/harness-orchestrator/src/registry/migrator.js';
import {
  createExecutionAuthorizationService,
  type ExecutionAgent,
} from '../src/execution/executionAuthorizationService.js';
import { ExecutionScopeStore } from '../src/execution/scopeStore.js';
import { wrapFacilitatorAgent } from '../packages/harness-orchestrator/src/facilitatorAgent.js';
import { admitModelCall } from '../packages/llm-provider-api/src/index.js';
import { meterModelCalls } from '../packages/harness-usage-telemetry/src/index.js';
import { AgentTurnBudget, AgentTurnHistory, createScopedAgentTurnService } from '../src/agents/agentTurnService.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'executionScopes',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `execution_scopes_${String(process.pid)}`;
const ENGINE = '@omadia/agent-facilitator';
const OTHER = '@acme/other-archetype';
const HOUR = 3_600_000;

describe('#2090 execution scopes (pg, migration 0073)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: ExecutionScopeStore;
  const agents = new Map<string, ExecutionAgent>();
  let clock = (): Date => new Date();
  let seq = 0;
  const process = (): string => `fac-${String(++seq)}`;
  const chat = (): { channelType: string; conversationId: string } => ({
    channelType: 'teams',
    conversationId: `19:chat-${String(++seq)}@thread.v2`,
  });
  const inHours = (h: number): string => new Date(clock().getTime() + h * HOUR).toISOString();

  const serviceFor = (pluginId: string, s: ExecutionScopeStore = store): ExecutionAuthorizationService =>
    createExecutionAuthorizationService({
      store: s,
      callerPluginId: pluginId,
      resolveAgent: (slug) => agents.get(slug),
      archetypePluginIdFor: (archetype) => (archetype === 'facilitator' ? ENGINE : archetype === 'other' ? OTHER : undefined),
      configuringMaxMs: 72 * HOUR,
      now: () => clock(),
    });
  let engine: ExecutionAuthorizationService;

  const code = (value: unknown): string | undefined =>
    (value as ExecutionRefusal).outcome === 'refused' ? (value as ExecutionRefusal).code : undefined;

  /** A process in `active` with its home conversation. */
  async function activeProcess(budget = { actions: 10, modelCalls: 10 }, agentSlug = 'mara') {
    const processId = process();
    const home = chat();
    const configuring = await engine.openScope({ agentSlug, processId, kind: 'configuring', budget, home });
    assert.equal(configuring.outcome, 'opened', JSON.stringify(configuring));
    const active = await engine.openScope({
      agentSlug,
      processId,
      kind: 'active',
      deadline: inHours(24),
      budget,
      targets: [{ kind: 'conversation', ...home }],
    });
    assert.equal(active.outcome, 'opened', JSON.stringify(active));
    if (active.outcome !== 'opened' || configuring.outcome !== 'opened') throw new Error('unreachable');
    return { processId, home, scope: active.scope, configuring: configuring.scope };
  }

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 6, options: `-c search_path=${SCHEMA},public` });
    await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);
    // The CI schema job applies everything twice.
    await pool.query(await readFile(resolve(MIGRATIONS_DIR, '0073_execution_scopes.sql'), 'utf8'));
    await pool.query(await readFile(resolve(MIGRATIONS_DIR, '0074_execution_authorization_emission.sql'), 'utf8'));
    const config = new ConfigStore(pool);
    for (const [slug, archetype] of [['mara', 'facilitator'], ['finn', 'facilitator'], ['otto', 'other'], ['stan', 'standard']] as const) {
      const agent = await config.createAgent({ slug, name: slug });
      agents.set(slug, { id: agent.id, slug, archetype, enabled: true });
    }
    store = new ExecutionScopeStore(pool);
    engine = serviceFor(ENGINE);
  });

  after(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await pool?.end();
  });

  describe('who may open a scope', () => {
    it('only the plugin that delivers the agent\'s archetype, for an enabled agent', async () => {
      const base = { processId: process(), kind: 'configuring' as const, budget: { actions: 1, modelCalls: 0 }, home: chat() };
      assert.equal(code(await engine.openScope({ ...base, agentSlug: 'otto' })), 'not_permitted');
      assert.equal(code(await engine.openScope({ ...base, agentSlug: 'stan' })), 'not_permitted');
      assert.equal(code(await engine.openScope({ ...base, agentSlug: 'nobody' })), 'unknown_agent');
      assert.equal(code(await serviceFor(OTHER).openScope({ ...base, agentSlug: 'mara' })), 'not_permitted');
      agents.set('finn', { ...agents.get('finn')!, enabled: false });
      assert.equal(code(await engine.openScope({ ...base, agentSlug: 'finn' })), 'not_permitted');
      agents.set('finn', { ...agents.get('finn')!, enabled: true });
      assert.equal((await engine.openScope({ ...base, agentSlug: 'mara' })).outcome, 'opened');
    });

    it('another plugin sees none of a process\'s scopes and cannot use one', async () => {
      const { processId, scope } = await activeProcess();
      const other = serviceFor(OTHER);
      assert.deepEqual(await other.listScopes(processId), []);
      assert.equal(
        code(await other.authorize({ scopeId: scope.id, phase: 'active', purpose: 'status', action: 'check' })),
        'unknown_scope',
      );
      await other.endScope(scope.id, 'hostile');
      assert.equal((await engine.listScopes(processId)).find((s) => s.id === scope.id)?.state, 'open');
    });
  });

  describe('scope state machine', () => {
    it('configuring is first and takes the home reservation; active ends it in the same step', async () => {
      const processId = process();
      const home = chat();
      const budget = { actions: 5, modelCalls: 5 };
      assert.equal(
        code(await engine.openScope({ agentSlug: 'mara', processId, kind: 'active', deadline: inHours(1), budget })),
        'scope_order',
      );
      const configuring = await engine.openScope({ agentSlug: 'mara', processId, kind: 'configuring', budget, home });
      assert.equal(configuring.outcome, 'opened');
      if (configuring.outcome !== 'opened') return;
      // Provisional deadline: the configured maximum.
      assert.equal(new Date(configuring.scope.deadline).getTime(), new Date(configuring.scope.absoluteLimit).getTime());
      assert.deepEqual(configuring.scope.targets, [{ kind: 'conversation', ...home }]);
      assert.deepEqual(
        (await engine.listReservations(processId)).map((r) => [r.conversationId, r.role, r.releasedAt]),
        [[home.conversationId, 'home', undefined]],
      );

      const active = await engine.openScope({ agentSlug: 'mara', processId, kind: 'active', deadline: inHours(48), budget });
      assert.equal(active.outcome, 'opened');
      const scopes = await engine.listScopes(processId);
      assert.deepEqual(
        scopes.map((s) => [s.kind, s.state, s.endReason]),
        [['configuring', 'ended', 'active_opened'], ['active', 'open', undefined]],
      );
      // The ended configuring scope authorizes nothing any more.
      assert.equal(
        code(await engine.authorize({ scopeId: configuring.scope.id, phase: 'configuring', purpose: 'moderation', action: 'check' })),
        'scope_ended',
      );
    });

    it('an ended scope never re-opens, also not for the same closing event', async () => {
      const { processId, scope } = await activeProcess();
      const budget = { actions: 3, modelCalls: 0 };
      await engine.endScope(scope.id, 'deadline reached');
      assert.equal(
        code(await engine.openScope({ agentSlug: 'mara', processId, kind: 'active', deadline: inHours(1), budget })),
        'scope_exists',
      );
      assert.equal(
        code(await engine.openScope({ agentSlug: 'mara', processId, kind: 'configuring', budget, home: chat() })),
        'scope_exists',
      );
      const closing = { agentSlug: 'mara', processId, kind: 'closing' as const, deadline: inHours(24 * 7), budget };
      assert.equal(code(await engine.openScope(closing)), 'invalid_request', 'a closing scope names its event');
      const first = await engine.openScope({ ...closing, eventId: 'session-1' });
      const second = await engine.openScope({ ...closing, eventId: 'session-2' });
      assert.equal(first.outcome, 'opened');
      assert.equal(second.outcome, 'opened', 'two closing events run independently');
      if (first.outcome !== 'opened') return;
      await engine.endScope(first.scope.id, 'delivered');
      assert.equal(code(await engine.openScope({ ...closing, eventId: 'session-1' })), 'scope_exists');
    });

    it('an abort out of configuring still gets its closing scope; follow_up and scheduling need an active process', async () => {
      const processId = process();
      const budget = { actions: 2, modelCalls: 0 };
      await engine.openScope({ agentSlug: 'mara', processId, kind: 'configuring', budget, home: chat() });
      assert.equal(
        code(await engine.openScope({ agentSlug: 'mara', processId, kind: 'follow_up', deadline: inHours(1), budget })),
        'scope_order',
      );
      assert.equal(
        code(await engine.openScope({ agentSlug: 'mara', processId, kind: 'scheduling', eventId: 'm1', deadline: inHours(1), budget })),
        'scope_order',
      );
      assert.equal(
        (await engine.openScope({ agentSlug: 'mara', processId, kind: 'closing', eventId: 'abort', deadline: inHours(1), budget })).outcome,
        'opened',
      );
      assert.equal(
        code(await engine.openScope({ agentSlug: 'mara', processId: process(), kind: 'closing', eventId: 'abort', deadline: inHours(1), budget })),
        'scope_order',
        'a process that never started has nothing to close',
      );
    });

    it('holds the limits per kind', async () => {
      const processId = process();
      const budget = { actions: 1, modelCalls: 0 };
      const home = chat();
      assert.equal(
        code(await engine.openScope({ agentSlug: 'mara', processId, kind: 'configuring', deadline: inHours(73), budget, home })),
        'limit_exceeded',
      );
      await engine.openScope({ agentSlug: 'mara', processId, kind: 'configuring', deadline: inHours(2), budget, home });
      assert.equal(
        code(await engine.openScope({ agentSlug: 'mara', processId, kind: 'active', budget })),
        'invalid_request',
        'only configuring has a default deadline',
      );
      assert.equal(
        code(await engine.openScope({ agentSlug: 'mara', processId, kind: 'active', deadline: inHours(-1), budget })),
        'deadline_passed',
      );
      await engine.openScope({ agentSlug: 'mara', processId, kind: 'active', deadline: inHours(24), budget });
      assert.equal(
        code(await engine.openScope({ agentSlug: 'mara', processId, kind: 'closing', eventId: 'e', deadline: inHours(24 * 31), budget })),
        'limit_exceeded',
        'closing: at most 30 days after its event',
      );
    });
  });

  describe('authorization', () => {
    it('counts every action, model-free ones included, and refuses beyond the budget', async () => {
      const { scope, home } = await activeProcess({ actions: 3, modelCalls: 2 });
      const post = { scopeId: scope.id, phase: 'active' as const, purpose: 'moderation' as const, action: 'post' as const, target: { kind: 'conversation' as const, ...home } };
      const first = await engine.authorize(post);
      assert.equal(first.outcome, 'authorized');
      if (first.outcome !== 'authorized') return;
      assert.deepEqual(first.remaining, { actions: 2, modelCalls: 2 });
      const turn = await engine.authorize({ ...post, action: 'model_turn', modelCalls: 2 });
      assert.equal(turn.outcome, 'authorized');
      assert.equal(code(await engine.authorize({ ...post, action: 'model_turn', modelCalls: 1 })), 'budget_exhausted', 'no model call left');
      assert.equal((await engine.authorize({ ...post, action: 'check', target: undefined })).outcome, 'authorized');
      assert.equal(code(await engine.authorize(post)), 'budget_exhausted', 'a model-free post needs budget too');
      const rows = await pool.query<{ action: string; purpose: string; phase: string }>(
        'SELECT action, purpose, phase FROM execution_authorizations WHERE scope_id = $1 ORDER BY created_at, id',
        [scope.id],
      );
      assert.deepEqual(rows.rows.map((r) => r.action).sort(), ['check', 'model_turn', 'post']);
    });

    it('two workers racing for the last unit: exactly one action runs', async () => {
      const { scope } = await activeProcess({ actions: 1, modelCalls: 0 });
      const second = serviceFor(ENGINE, new ExecutionScopeStore(pool));
      const attempt = { scopeId: scope.id, phase: 'active' as const, purpose: 'status' as const, action: 'check' as const };
      const results = await Promise.all([
        ...Array.from({ length: 6 }, () => engine.authorize(attempt)),
        ...Array.from({ length: 6 }, () => second.authorize(attempt)),
      ]);
      assert.equal(results.filter((r) => r.outcome === 'authorized').length, 1);
      assert.ok(results.filter((r) => r.outcome === 'refused').every((r) => code(r) === 'budget_exhausted'));
      const used = await pool.query<{ used_actions: number }>('SELECT used_actions FROM execution_scopes WHERE id = $1', [scope.id]);
      assert.equal(used.rows[0]?.used_actions, 1);
    });

    it('a restart keeps counters and reservations', async () => {
      const { scope, processId, home } = await activeProcess({ actions: 5, modelCalls: 0 });
      const check = { scopeId: scope.id, phase: 'active' as const, purpose: 'status' as const, action: 'check' as const };
      await engine.authorize(check);
      await engine.authorize(check);
      // A new process: new pool, new store, new service.
      const restartedPool = new Pool({ connectionString: PG_URL, max: 2, options: `-c search_path=${SCHEMA},public` });
      try {
        const restarted = serviceFor(ENGINE, new ExecutionScopeStore(restartedPool));
        const found = (await restarted.listScopes(processId)).find((s) => s.id === scope.id);
        assert.deepEqual(found?.used, { actions: 2, modelCalls: 0 });
        const next = await restarted.authorize(check);
        assert.equal(next.outcome === 'authorized' ? next.remaining.actions : -1, 2);
        assert.deepEqual((await restarted.listReservations(processId)).map((r) => r.conversationId), [home.conversationId]);
      } finally {
        await restartedPool.end();
      }
    });

    it('refuses after the deadline, also a model-free post, and the scope is swept', async () => {
      const { scope, home, processId } = await activeProcess();
      await pool.query("UPDATE execution_scopes SET deadline = now() - interval '1 second' WHERE id = $1", [scope.id]);
      assert.equal(
        code(await engine.authorize({ scopeId: scope.id, phase: 'active', purpose: 'moderation', action: 'post', target: { kind: 'conversation', ...home } })),
        'deadline_passed',
      );
      const swept = await store.sweepExpired();
      assert.ok(swept.scopesEnded >= 1 && swept.reservationsReleased >= 1);
      assert.equal((await engine.listScopes(processId)).find((s) => s.id === scope.id)?.endReason, 'deadline');
      assert.ok((await engine.listReservations(processId))[0]?.releasedAt, 'a process without an open scope holds no conversation');
    });

    it('refuses a phase that does not fit the scope and a target the scope does not list', async () => {
      const { scope, home } = await activeProcess();
      const post = { scopeId: scope.id, phase: 'active' as const, purpose: 'moderation' as const, action: 'post' as const };
      assert.equal(code(await engine.authorize({ ...post, phase: 'following_up', target: { kind: 'conversation', ...home } })), 'phase_mismatch');
      assert.equal(code(await engine.authorize({ ...post, target: { kind: 'conversation', ...chat() } })), 'target_not_allowed');
      assert.equal(code(await engine.authorize(post)), 'invalid_request', 'a post names its target');
      assert.equal(
        code(await engine.authorize({ ...post, action: 'direct_message', target: { kind: 'person', channelType: 'teams', principalId: 'aad:anna' } })),
        'target_not_allowed',
      );
      const people = await engine.setPeople(scope.id, [
        { kind: 'person', channelType: 'teams', principalId: 'aad:anna' },
        { kind: 'person', channelType: 'teams', principalId: 'aad:guest', restriction: 'status_only' },
      ]);
      assert.equal(people.outcome, 'updated');
      if (people.outcome !== 'updated') return;
      assert.equal(people.scope.targets.length, 3, 'conversation targets are kept');
      const dm = { ...post, action: 'direct_message' as const };
      assert.equal((await engine.authorize({ ...dm, purpose: 'reminder', target: { kind: 'person', channelType: 'teams', principalId: 'AAD:Anna' } })).outcome, 'authorized');
      assert.equal(
        code(await engine.authorize({ ...dm, purpose: 'reminder', target: { kind: 'person', channelType: 'teams', principalId: 'aad:guest' } })),
        'target_not_allowed',
        'a status-only person gets the status and nothing else',
      );
      assert.equal((await engine.authorize({ ...dm, purpose: 'status', target: { kind: 'person', channelType: 'teams', principalId: 'aad:guest' } })).outcome, 'authorized');
    });

    it('a conversation target must be one this process reserved', async () => {
      const { processId, home } = await activeProcess();
      const foreign = chat();
      const closing = { agentSlug: 'mara', processId, kind: 'closing' as const, eventId: 'c1', deadline: inHours(24), budget: { actions: 2, modelCalls: 0 } };
      assert.equal(
        code(await engine.openScope({ ...closing, targets: [{ kind: 'conversation', ...foreign }] })),
        'target_not_allowed',
      );
      // After the release the process still held it once: closing may post there.
      await engine.releaseConversation({ processId, ...home, reason: 'closed' });
      const opened = await engine.openScope({ ...closing, targets: [{ kind: 'conversation', ...home }] });
      assert.equal(opened.outcome, 'opened');
    });

    it('settle returns the unused part of a turn\'s reservation, once', async () => {
      const { scope } = await activeProcess({ actions: 5, modelCalls: 6 });
      const turn = await engine.authorize({ scopeId: scope.id, phase: 'active', purpose: 'moderation', action: 'model_turn', modelCalls: 4 });
      assert.equal(turn.outcome, 'authorized');
      if (turn.outcome !== 'authorized') return;
      assert.equal(turn.remaining.modelCalls, 2);
      await engine.settle(turn.authorizationId, { modelCalls: 1 });
      await engine.settle(turn.authorizationId, { modelCalls: 0 });
      const used = async (): Promise<number> =>
        (await pool.query<{ n: number }>('SELECT used_model_calls AS n FROM execution_scopes WHERE id = $1', [scope.id])).rows[0]!.n;
      assert.equal(await used(), 1, 'three of four went back, and only once');
      // A turn that used more than it reserved is charged, up to the budget.
      const greedy = await engine.authorize({ scopeId: scope.id, phase: 'active', purpose: 'moderation', action: 'model_turn', modelCalls: 1 });
      if (greedy.outcome !== 'authorized') throw new Error('unreachable');
      await engine.settle(greedy.authorizationId, { modelCalls: 50 });
      assert.equal(await used(), 6);
    });
  });

  describe('agentTurn@2 on a real scope', () => {
    /** A turn service whose model makes `calls` model calls per turn. */
    function turns(calls: () => number) {
      let ran = 0;
      const entry = {
        agent: { id: agents.get('mara')!.id, slug: 'mara', name: 'mara', status: 'enabled', kind: 'facilitator', archetype: 'facilitator' },
        plugins: [{ pluginId: ENGINE, enabled: true }],
        built: {
          bundle: {
            agent: wrapFacilitatorAgent(
              {
                chat: async () => {
                  ran += 1;
                  for (let i = 0; i < calls(); i += 1) {
                    await Promise.resolve();
                    admitModelCall(); // what every provider does before its backend call
                  }
                  return { text: 'ok' };
                },
                chatStream: (() => undefined) as never,
              },
              { agentSlug: 'mara' },
            ),
          },
        },
      };
      const service = createScopedAgentTurnService({
        getRegistry: () => ({ get: (slug: string) => (slug === 'mara' ? entry : undefined), channelTypesWithIdentity: () => [] }) as never,
        callerPluginId: ENGINE,
        isEngine: () => true,
        history: new AgentTurnHistory(),
        budget: new AgentTurnBudget(0),
        execution: () => engine,
        meter: meterModelCalls,
      });
      return { service, ran: () => ran };
    }
    const turn = (scopeId: string, processId: string, modelCalls: number) => ({
      agentSlug: 'mara',
      sessionKey: processId,
      channelType: 'teams',
      conversationId: '19:x@thread.v2',
      input: 'go on',
      scopeId,
      processId,
      phase: 'active' as const,
      purpose: 'moderation' as const,
      emission: 'prose' as const,
      budget: { modelCalls },
    });
    const usedOf = async (scopeId: string): Promise<{ used_actions: number; used_model_calls: number }> =>
      (await pool.query<{ used_actions: number; used_model_calls: number }>(
        'SELECT used_actions, used_model_calls FROM execution_scopes WHERE id = $1',
        [scopeId],
      )).rows[0]!;

    it('charges the scope with the model calls the turn really made and records the emission type', async () => {
      const { scope, processId } = await activeProcess({ actions: 5, modelCalls: 10 });
      const t = turns(() => 3);
      const outcome = await t.service.runTurn(turn(scope.id, processId, 6));
      assert.deepEqual(outcome.outcome === 'completed' && outcome.modelCalls, { reserved: 6, used: 3 });
      assert.deepEqual(await usedOf(scope.id), { used_actions: 1, used_model_calls: 3 });
      const row = await pool.query<{ action: string; emission: string; reserved_model_calls: number; used_model_calls: number }>(
        'SELECT action, emission, reserved_model_calls, used_model_calls FROM execution_authorizations WHERE scope_id = $1',
        [scope.id],
      );
      assert.deepEqual(row.rows, [{ action: 'model_turn', emission: 'prose', reserved_model_calls: 6, used_model_calls: 3 }]);
    });

    it('two turns racing for the last reservation: exactly one model runs', async () => {
      const { scope, processId } = await activeProcess({ actions: 10, modelCalls: 4 });
      const t = turns(() => 1);
      const outcomes = await Promise.all(Array.from({ length: 5 }, () => t.service.runTurn(turn(scope.id, processId, 4))));
      assert.equal(outcomes.filter((o) => o.outcome === 'completed').length, 1);
      assert.equal(t.ran(), 1);
      assert.ok(
        outcomes
          .filter((o) => o.outcome === 'refused')
          .every((o) => o.outcome === 'refused' && o.code === 'not_authorized' && o.executionCode === 'budget_exhausted'),
      );
    });

    it('a turn cannot overrun its reservation: the scope is charged with the reserved calls and the rest stays', async () => {
      const { scope, processId } = await activeProcess({ actions: 10, modelCalls: 5 });
      const t = turns(() => 12);
      const first = await t.service.runTurn(turn(scope.id, processId, 2));
      assert.equal(first.outcome === 'refused' && first.code, 'reservation_exceeded');
      assert.deepEqual(first.outcome === 'refused' && first.modelCalls, { reserved: 2, used: 2, refused: 1 });
      assert.deepEqual(await usedOf(scope.id), { used_actions: 1, used_model_calls: 2 });
      // The scope still has 3 calls: a turn that fits runs.
      const fits = turns(() => 3);
      const second = await fits.service.runTurn(turn(scope.id, processId, 3));
      assert.deepEqual(second.outcome === 'completed' && second.modelCalls, { reserved: 3, used: 3 });
      assert.equal((await usedOf(scope.id)).used_model_calls, 5);
      const third = await fits.service.runTurn(turn(scope.id, processId, 1));
      assert.equal(third.outcome === 'refused' && third.executionCode, 'budget_exhausted');
    });

    it('the kill switch and a passed deadline refuse the turn before the model', async () => {
      const { scope, processId } = await activeProcess();
      const t = turns(() => 1);
      const stop = await store.setKillSwitch({ level: 'process', agentId: agents.get('mara')!.id, processId, reason: '', setBy: 'op' });
      const stopped = await t.service.runTurn(turn(scope.id, processId, 1));
      assert.equal(stopped.outcome === 'refused' && stopped.executionCode, 'kill_switch');
      await store.clearKillSwitch(stop.id, 'op');
      await pool.query("UPDATE execution_scopes SET deadline = now() - interval '1 second' WHERE id = $1", [scope.id]);
      const late = await t.service.runTurn(turn(scope.id, processId, 1));
      assert.equal(late.outcome === 'refused' && late.executionCode, 'deadline_passed');
      assert.equal(t.ran(), 0);
    });
  });

  describe('deadline changes', () => {
    it('the deadline moves while it has not passed; past it only the bounded deadline wait extends', async () => {
      const { scope, home } = await activeProcess();
      const moved = await engine.extendScope(scope.id, { deadline: inHours(72) });
      assert.equal(moved.outcome, 'extended');
      assert.equal(code(await engine.extendScope(scope.id, { deadline: inHours(24 * 400) })), 'limit_exceeded');

      await pool.query("UPDATE execution_scopes SET deadline = now() - interval '1 second' WHERE id = $1", [scope.id]);
      assert.equal(code(await engine.extendScope(scope.id, { deadline: inHours(1) })), 'deadline_passed', 'an expired scope never re-opens moderation');
      assert.equal(code(await engine.extendScope(scope.id, { deadline: inHours(24 * 31), deadlineWait: true })), 'limit_exceeded');
      const wait = await engine.extendScope(scope.id, { deadline: inHours(24), deadlineWait: true });
      assert.equal(wait.outcome, 'extended');
      const target = { kind: 'conversation' as const, ...home };
      const base = { scopeId: scope.id, phase: 'active' as const, action: 'post' as const, target };
      assert.equal(code(await engine.authorize({ ...base, purpose: 'moderation' })), 'purpose_not_allowed');
      assert.equal(code(await engine.authorize({ ...base, purpose: 'reminder' })), 'purpose_not_allowed');
      for (const purpose of ['consent', 'status', 'stop'] as const) {
        assert.equal((await engine.authorize({ ...base, purpose })).outcome, 'authorized', purpose);
      }
      // The wait cannot be left again by a plain extension.
      assert.equal(code(await engine.extendScope(scope.id, { deadline: inHours(2) })), 'deadline_passed');
    });

    it('only an active scope has a deadline wait', async () => {
      const { processId } = await activeProcess();
      const closing = await engine.openScope({ agentSlug: 'mara', processId, kind: 'closing', eventId: 'x', deadline: inHours(1), budget: { actions: 1, modelCalls: 0 } });
      if (closing.outcome !== 'opened') throw new Error('unreachable');
      assert.equal(code(await engine.extendScope(closing.scope.id, { deadline: inHours(2), deadlineWait: true })), 'invalid_request');
      assert.equal((await engine.extendScope(closing.scope.id, { deadline: inHours(24 * 7) })).outcome, 'extended');
    });
  });

  describe('kill switch', () => {
    const check = (scopeId: string) => ({ scopeId, phase: 'active' as const, purpose: 'status' as const, action: 'check' as const });

    it('instance, agent and process switches refuse every authorization in their reach and end nothing', async () => {
      const mara1 = await activeProcess();
      const mara2 = await activeProcess();
      const finn = await activeProcess(undefined, 'finn');
      const maraId = agents.get('mara')!.id;

      const processSwitch = await store.setKillSwitch({ level: 'process', agentId: maraId, processId: mara1.processId, reason: 'runaway', setBy: 'op@example.test' });
      assert.equal(code(await engine.authorize(check(mara1.scope.id))), 'kill_switch');
      assert.equal((await engine.authorize(check(mara2.scope.id))).outcome, 'authorized');
      assert.equal((await engine.listScopes(mara1.processId)).find((s) => s.id === mara1.scope.id)?.state, 'open');

      const agentSwitch = await store.setKillSwitch({ level: 'agent', agentId: maraId, reason: '', setBy: 'op@example.test' });
      assert.equal(code(await engine.authorize(check(mara2.scope.id))), 'kill_switch');
      assert.equal((await engine.authorize(check(finn.scope.id))).outcome, 'authorized');

      const instanceSwitch = await store.setKillSwitch({ level: 'instance', reason: 'incident', setBy: 'op@example.test' });
      assert.equal(code(await engine.authorize(check(finn.scope.id))), 'kill_switch');
      // Setting the same switch twice is the same switch.
      assert.equal((await store.setKillSwitch({ level: 'instance', reason: 'again', setBy: 'x' })).id, instanceSwitch.id);
      assert.equal((await store.listKillSwitches()).length, 3);

      for (const s of [processSwitch, agentSwitch, instanceSwitch]) {
        assert.equal((await store.clearKillSwitch(s.id, 'op@example.test'))?.id, s.id);
      }
      assert.equal(await store.clearKillSwitch(instanceSwitch.id, 'op'), undefined, 'cleared once');
      assert.equal((await engine.authorize(check(mara1.scope.id))).outcome, 'authorized', 'authorizations resume, nothing was ended');
    });
  });

  describe('reservations', () => {
    it('a conversation hosts one process: a second facilitation and an agent discussion are refused', async () => {
      const first = await activeProcess();
      const budget = { actions: 1, modelCalls: 0 };
      assert.equal(
        code(await engine.openScope({ agentSlug: 'finn', processId: process(), kind: 'configuring', budget, home: first.home })),
        'conversation_busy',
      );
      const discussion = await store.reserve({ ...first.home, holderKind: 'agent_discussion', processId: 'discussion:1', role: 'home' });
      assert.equal(discussion.ok, false);
      assert.equal(!discussion.ok && discussion.heldBy?.holderKind, 'archetype_process');

      // And the other way round: a running discussion blocks a facilitation.
      const talk = chat();
      assert.equal((await store.reserve({ ...talk, holderKind: 'agent_discussion', processId: 'discussion:2', role: 'home' })).ok, true);
      const blocked = await engine.openScope({ agentSlug: 'mara', processId: process(), kind: 'configuring', budget, home: talk });
      assert.equal(code(blocked), 'conversation_busy');
      assert.equal(await store.release({ ...talk, holderKind: 'agent_discussion', reason: 'discussion ended' }), 1);
      assert.equal((await engine.openScope({ agentSlug: 'mara', processId: process(), kind: 'configuring', budget, home: talk })).outcome, 'opened');
    });

    it('a failed start leaves no scope behind', async () => {
      const first = await activeProcess();
      const processId = process();
      await engine.openScope({ agentSlug: 'finn', processId, kind: 'configuring', budget: { actions: 1, modelCalls: 0 }, home: first.home });
      assert.deepEqual(await engine.listScopes(processId), []);
    });

    it('a session conversation is linked with its own reservation and released on its own', async () => {
      const { processId, home } = await activeProcess();
      const session = chat();
      const other = await activeProcess(undefined, 'finn');
      assert.equal(code(await engine.reserveConversation({ agentSlug: 'mara', processId, ...other.home })), 'conversation_busy');
      assert.equal(code(await engine.reserveConversation({ agentSlug: 'mara', processId: 'never-started', ...session })), 'scope_order');
      const linked = await engine.reserveConversation({ agentSlug: 'mara', processId, ...session });
      assert.equal(linked.outcome === 'reserved' && linked.reservation.role, 'session');
      assert.equal((await engine.reserveConversation({ agentSlug: 'mara', processId, ...session })).outcome, 'reserved', 'idempotent');
      await engine.releaseConversation({ processId, ...session, reason: 'session closed' });
      const held = (await engine.listReservations(processId)).filter((r) => !r.releasedAt).map((r) => r.conversationId);
      assert.deepEqual(held, [home.conversationId]);
      // One process cannot release another's.
      await engine.releaseConversation({ processId, ...other.home, reason: 'hostile' });
      assert.equal((await store.holder(other.home.channelType, other.home.conversationId))?.processId, other.processId);
    });
  });

  describe('revocation', () => {
    it('ends every open scope and releases every reservation of an agent, and nothing of another', async () => {
      const a = await activeProcess();
      const b = await activeProcess();
      const finn = await activeProcess(undefined, 'finn');
      const revoked = await store.revokeAll({ agentId: agents.get('mara')!.id }, 'agent disabled');
      assert.ok(revoked.scopes.some((s) => s.id === a.scope.id) && revoked.scopes.some((s) => s.id === b.scope.id));
      assert.ok(revoked.reservations.some((r) => r.conversationId === a.home.conversationId));
      assert.equal(
        code(await engine.authorize({ scopeId: a.scope.id, phase: 'active', purpose: 'status', action: 'check' })),
        'scope_ended',
      );
      assert.equal(await store.holder(a.home.channelType, a.home.conversationId), undefined);
      assert.equal((await engine.authorize({ scopeId: finn.scope.id, phase: 'active', purpose: 'status', action: 'check' })).outcome, 'authorized');
      // Re-enabling resumes nothing: the ended scope stays ended.
      assert.equal(
        code(await engine.openScope({ agentSlug: 'mara', processId: a.processId, kind: 'active', deadline: inHours(1), budget: { actions: 1, modelCalls: 0 } })),
        'scope_exists',
      );
    });

    it('ends everything of a plugin at its uninstall', async () => {
      const finn = await activeProcess(undefined, 'finn');
      const revoked = await store.revokeAll({ pluginId: ENGINE }, 'archetype plugin removed');
      assert.ok(revoked.scopes.some((s) => s.id === finn.scope.id));
      assert.equal((await store.listOpenScopes(100)).filter((s) => s.pluginId === ENGINE).length, 0);
    });
  });
});
