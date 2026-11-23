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
import { createExecutionGrantsService, createGrantVerificationService } from '../src/execution/grantService.js';
import { ExecutionScopeStore } from '../src/execution/scopeStore.js';
import { SessionConversationStore } from '../src/execution/sessionConversationStore.js';
import { createScopedSendService } from '../src/channels/scopedSendService.js';
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
  let sessions: SessionConversationStore;
  /** Conversations whose channel cannot deliver every message, with why. */
  const notReady = new Map<string, string>();
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
      sessions,
      notReadyForAll: (_agent, _channel, conversationId) => Promise.resolve(notReady.get(conversationId)),
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
    await pool.query(await readFile(resolve(MIGRATIONS_DIR, '0076_execution_grants.sql'), 'utf8'));
    const config = new ConfigStore(pool);
    for (const [slug, archetype] of [['mara', 'facilitator'], ['finn', 'facilitator'], ['otto', 'other'], ['stan', 'standard']] as const) {
      const agent = await config.createAgent({ slug, name: slug });
      agents.set(slug, { id: agent.id, slug, archetype, enabled: true });
    }
    store = new ExecutionScopeStore(pool);
    sessions = new SessionConversationStore(pool);
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
        agent: { id: agents.get('mara')!.id, slug: 'mara', name: 'mara', status: 'enabled', archetype: 'facilitator' },
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
      // The session closing the wait is for is opened first (spec 2043 §5.6).
      await engine.openScope({ agentSlug: 'mara', processId: scope.processId, kind: 'closing', eventId: 'session:s1', deadline: inHours(24 * 7), budget: { actions: 5, modelCalls: 0 } });
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

  describe('#2090 closing limits, closing purposes and the bounded deadline wait (plugin-api 1.85.0)', () => {
    const budget = { actions: 20, modelCalls: 0 };
    type Home = { channelType: string; conversationId: string };
    const closingOf = (processId: string, eventId: string, extra: { eventAt?: string; deadline?: string; home?: Home } = {}) =>
      engine.openScope({
        agentSlug: 'mara',
        processId,
        kind: 'closing',
        eventId,
        deadline: extra.deadline ?? inHours(24),
        budget,
        ...(extra.eventAt ? { eventAt: extra.eventAt } : {}),
        ...(extra.home ? { targets: [{ kind: 'conversation' as const, ...extra.home }] } : {}),
      });

    it('the 30 days of a closing count from its event, also when the scope is opened later', async () => {
      const { processId } = await activeProcess();
      const started = clock().getTime();
      // The plugin comes round to the closing 3 days after the event (a restart).
      clock = () => new Date(started + 3 * 24 * HOUR);
      try {
        const eventAt = new Date(started + HOUR).toISOString();
        assert.equal(code(await closingOf(processId, 'late', { eventAt, deadline: inHours(24 * 28) })), 'limit_exceeded', 'not 30 days from the opening');
        const opened = await closingOf(processId, 'late', { eventAt, deadline: inHours(24 * 26) });
        assert.equal(opened.outcome, 'opened', JSON.stringify(opened));
        if (opened.outcome !== 'opened') return;
        assert.equal(opened.scope.absoluteLimit, new Date(started + HOUR + 30 * 24 * HOUR).toISOString());
        assert.equal(code(await engine.extendScope(opened.scope.id, { deadline: inHours(24 * 28) })), 'limit_exceeded');
        assert.equal(code(await closingOf(processId, 'future', { eventAt: inHours(1) })), 'invalid_request', 'an event cannot lie ahead');
        const early = await closingOf(processId, 'early', { eventAt: new Date(started - 2 * 24 * HOUR).toISOString(), deadline: inHours(24) });
        assert.equal(early.outcome === 'opened' ? early.scope.absoluteLimit : '', new Date(started + 28 * 24 * HOUR).toISOString(), 'an earlier event only shortens the limit');
        assert.equal(
          code(await engine.openScope({ agentSlug: 'mara', processId, kind: 'follow_up', eventAt: new Date(started).toISOString(), deadline: inHours(2), budget })),
          'invalid_request',
          'only a closing names its event time',
        );
      } finally {
        clock = () => new Date();
      }
    });

    it('a closing event older than 30 days opens nothing: nothing is sent after the absolute limit', async () => {
      const { processId } = await activeProcess();
      const started = clock().getTime();
      clock = () => new Date(started + 31 * 24 * HOUR);
      try {
        assert.equal(code(await closingOf(processId, 'stale', { eventAt: new Date(started + HOUR).toISOString() })), 'limit_exceeded');
        assert.equal((await engine.listScopes(processId)).some((s) => s.eventId === 'stale'), false);
      } finally {
        clock = () => new Date();
      }
    });

    it('a closing never re-opens moderation: only its messages, consent answers, status, stop and checks', async () => {
      const { processId, home } = await activeProcess();
      const opened = await closingOf(processId, 'result', { home });
      if (opened.outcome !== 'opened') throw new Error(JSON.stringify(opened));
      const post = { scopeId: opened.scope.id, phase: 'concluding' as const, action: 'post' as const, target: { kind: 'conversation' as const, ...home } };
      for (const purpose of ['moderation', 'handshake', 'link', 'reminder'] as const) {
        assert.equal(code(await engine.authorize({ ...post, purpose })), 'purpose_not_allowed', purpose);
      }
      assert.equal(code(await engine.authorize({ ...post, purpose: 'other' })), 'purpose_not_allowed', "'other' is a check only");
      assert.equal(code(await engine.authorize({ ...post, action: 'model_turn', target: undefined, purpose: 'moderation', modelCalls: 1 })), 'purpose_not_allowed');
      for (const purpose of ['essential_message', 'protocol_dispatch', 'consent', 'status', 'stop'] as const) {
        assert.equal((await engine.authorize({ ...post, purpose })).outcome, 'authorized', purpose);
      }
      assert.equal((await engine.authorize({ ...post, action: 'check', target: undefined, purpose: 'other' })).outcome, 'authorized');
      const used = await pool.query<{ used_actions: number }>('SELECT used_actions FROM execution_scopes WHERE id = $1', [opened.scope.id]);
      assert.equal(used.rows[0]?.used_actions, 6, 'a refusal spends nothing');
    });

    it('a deadline wait needs an open closing scope and ends with its limit', async () => {
      const { processId, scope } = await activeProcess();
      const started = clock().getTime();
      await pool.query("UPDATE execution_scopes SET deadline = now() - interval '1 second' WHERE id = $1", [scope.id]);
      // Five days later: the session closed at the start of the process.
      clock = () => new Date(started + 5 * 24 * HOUR);
      try {
        assert.equal(code(await engine.extendScope(scope.id, { deadline: inHours(24), deadlineWait: true })), 'scope_order', 'nothing to wait for');
        const session = await closingOf(processId, 'session:last', { eventAt: new Date(started).toISOString(), deadline: inHours(24 * 7) });
        if (session.outcome !== 'opened') throw new Error(JSON.stringify(session));
        assert.equal(
          code(await engine.extendScope(scope.id, { deadline: inHours(24 * 26), deadlineWait: true })),
          'limit_exceeded',
          'never past the closing it waits for (30 days after its event, 25 days from now)',
        );
        assert.equal((await engine.extendScope(scope.id, { deadline: inHours(48), deadlineWait: true })).outcome, 'extended');
        const status = { scopeId: scope.id, phase: 'active' as const, purpose: 'status' as const, action: 'check' as const };
        assert.equal((await engine.authorize(status)).outcome, 'authorized', 'consent, status and stop run in the wait');
        await engine.endScope(session.scope.id, 'confirmed');
        assert.equal(code(await engine.authorize(status)), 'deadline_passed', 'the wait ends with its closings, not at its own deadline');
        assert.equal(code(await engine.extendScope(scope.id, { deadline: inHours(72), deadlineWait: true })), 'scope_order', 'the wait is over with its closings');
      } finally {
        clock = () => new Date();
      }
    });

    describe('criterion 59 across the kernel boundary: the last session ends exactly at the deadline', () => {
      /**
       * The two jobs due at the same moment run in either order: the
       * session's end (its closing is opened) and the facilitation's
       * deadline (the active scope goes into its wait). In both, the wait
       * only stands once the closing is open, only consent, status and stop
       * run during it, the summary goes out under its own closing, and the
       * result closing that follows counts from the deadline.
       */
      for (const order of ['session end first', 'deadline first'] as const) {
        it(order, async () => {
          const { processId, scope, home } = await activeProcess({ actions: 20, modelCalls: 4 });
          const started = clock().getTime();
          const deadline = new Date(started + 2 * HOUR);
          await engine.extendScope(scope.id, { deadline: deadline.toISOString() });
          clock = () => new Date(deadline.getTime());
          try {
            await pool.query('UPDATE execution_scopes SET deadline = $2 WHERE id = $1', [scope.id, new Date(Date.now() - 1000)]);
            const waitUntil = new Date(deadline.getTime() + 25 * HOUR).toISOString();
            const openSessionClosing = () => closingOf(processId, 'session:last', { home, eventAt: deadline.toISOString(), deadline: new Date(deadline.getTime() + 7 * 24 * HOUR).toISOString() });
            if (order === 'deadline first') {
              assert.equal(code(await engine.extendScope(scope.id, { deadline: waitUntil, deadlineWait: true })), 'scope_order');
              assert.equal((await engine.listScopes(processId)).find((s) => s.id === scope.id)?.deadlineWait, false, 'nothing changed');
            }
            const closing = await openSessionClosing();
            if (closing.outcome !== 'opened') throw new Error(JSON.stringify(closing));
            const waiting = await engine.extendScope(scope.id, { deadline: waitUntil, deadlineWait: true });
            assert.equal(waiting.outcome, 'extended', JSON.stringify(waiting));

            const home$ = { kind: 'conversation' as const, ...home };
            const active = { scopeId: scope.id, phase: 'active' as const, action: 'post' as const, target: home$ };
            assert.equal(code(await engine.authorize({ ...active, purpose: 'moderation' })), 'purpose_not_allowed');
            assert.equal(code(await engine.authorize({ ...active, action: 'model_turn', target: undefined, purpose: 'moderation', modelCalls: 1 })), 'purpose_not_allowed');
            for (const purpose of ['consent', 'status', 'stop'] as const) {
              assert.equal((await engine.authorize({ ...active, purpose })).outcome, 'authorized', purpose);
            }
            const summary = { scopeId: closing.scope.id, phase: 'active' as const, action: 'post' as const, target: home$ };
            assert.equal((await engine.authorize({ ...summary, purpose: 'essential_message' })).outcome, 'authorized');

            // The summary's window ends; the closing ends, and so does the wait.
            await engine.endScope(closing.scope.id, 'confirmed');
            assert.equal(code(await engine.extendScope(scope.id, { deadline: new Date(deadline.getTime() + 30 * HOUR).toISOString(), deadlineWait: true })), 'scope_order');
            await engine.endScope(scope.id, 'concluding');
            const result = await closingOf(processId, 'result', { home, eventAt: deadline.toISOString(), deadline: new Date(deadline.getTime() + 7 * 24 * HOUR).toISOString() });
            assert.equal(result.outcome, 'opened', JSON.stringify(result));
            if (result.outcome !== 'opened') return;
            assert.equal(result.scope.absoluteLimit, new Date(deadline.getTime() + 30 * 24 * HOUR).toISOString());
            assert.equal(code(await engine.authorize({ scopeId: result.scope.id, phase: 'concluding', action: 'post', target: home$, purpose: 'moderation' })), 'purpose_not_allowed', 'moderation never re-opens');
            assert.equal((await engine.authorize({ scopeId: result.scope.id, phase: 'concluding', action: 'post', target: home$, purpose: 'essential_message' })).outcome, 'authorized');
          } finally {
            clock = () => new Date();
          }
        });
      }
    });
  });

  describe('kill switch', () => {
    const check = (scopeId: string) => ({ scopeId, phase: 'active' as const, purpose: 'status' as const, action: 'check' as const });

    it('instance, agent and process switches refuse every authorization in their reach and end nothing', async () => {
      const mara1 = await activeProcess();
      const mara2 = await activeProcess();
      const finn = await activeProcess(undefined, 'finn');
      const maraId = agents.get('mara')!.id;

      // A process id names its agent (what the operator route asks without agent_slug).
      assert.deepEqual(await store.agentsOfProcess(mara1.processId), [maraId]);
      assert.deepEqual(await store.agentsOfProcess(finn.processId), [agents.get('finn')!.id]);
      assert.deepEqual(await store.agentsOfProcess('no-such-process'), []);

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
  });

  describe('#2076 / #2089 linked session conversations (migration 0107)', () => {
    /** A link request made inside `conversation` for these processes. */
    const linkRequest = async (
      conversation: { channelType: string; conversationId: string },
      processIds: readonly string[],
      agentSlug = 'mara',
      ttlMs = HOUR,
    ): Promise<string> =>
      (
        await sessions.createLinkRequest({
          pluginId: ENGINE,
          agentId: agents.get(agentSlug)!.id,
          ...conversation,
          principalId: 'aad-anna',
          processIds,
          ttlMs,
        })
      ).id;

    it('a session conversation is linked only on a link request made inside it (criterion 48)', async () => {
      const { processId, home } = await activeProcess();
      const session = chat();
      const elsewhere = chat();
      // No request, or one made in another conversation (the home one): nothing.
      assert.equal(code(await engine.reserveConversation({ agentSlug: 'mara', processId, ...session })), 'link_not_authorized');
      // Its own home conversation, lost, it takes back without a link...
      await engine.releaseConversation({ processId, ...home, reason: 'lost' });
      const back = await engine.reserveConversation({ agentSlug: 'mara', processId, ...home });
      assert.equal(back.outcome === 'reserved' && back.reservation.role, 'home');
      // ...but not after an operator released it.
      const heldNow = await store.holder(home.channelType, home.conversationId);
      await store.releaseReservation(heldNow!.id, 'released by ops@example.com');
      assert.equal(code(await engine.reserveConversation({ agentSlug: 'mara', processId, ...home })), 'link_not_authorized');
      assert.equal(code(await engine.reserveConversation({ agentSlug: 'mara', processId, ...session, linkRequestId: 'not-a-uuid' })), 'link_not_authorized');
      const fromElsewhere = await linkRequest(elsewhere, [processId]);
      assert.equal(
        code(await engine.reserveConversation({ agentSlug: 'mara', processId, ...session, linkRequestId: fromElsewhere })),
        'link_not_authorized',
      );
      // A request offered to another process does not authorize this one.
      const forOther = await linkRequest(session, ['someone-else']);
      assert.equal(code(await engine.reserveConversation({ agentSlug: 'mara', processId, ...session, linkRequestId: forOther })), 'link_not_authorized');
      assert.equal(await store.holder(session.channelType, session.conversationId), undefined, 'nothing was taken');

      const request = await linkRequest(session, [processId]);
      const linked = await engine.reserveConversation({ agentSlug: 'mara', processId, ...session, linkRequestId: request, sessionId: 's-1' });
      assert.equal(linked.outcome, 'reserved', JSON.stringify(linked));
      if (linked.outcome !== 'reserved') return;
      assert.equal(linked.reservation.role, 'session');
      assert.equal(linked.reservation.sessionState, 'scheduled');
      assert.equal(linked.reservation.sessionId, 's-1');
      // A restart asks again: the same reservation, without a new request.
      assert.equal((await serviceFor(ENGINE, new ExecutionScopeStore(pool)).reserveConversation({ agentSlug: 'mara', processId, ...session })).outcome, 'reserved');
      // The request is used up.
      const { rows } = await pool.query<{ consumed: boolean }>('SELECT consumed_at IS NOT NULL AS consumed FROM conversation_link_requests WHERE id = $1', [request]);
      assert.equal(rows[0]?.consumed, true);
      // The open scopes may now address it.
      const active = (await engine.listScopes(processId)).find((sc) => sc.kind === 'active' && sc.state === 'open');
      assert.ok(active?.targets.some((t) => t.kind === 'conversation' && t.conversationId === session.conversationId));
    });

    it('an expired request, or a conversation held by another process or a discussion, takes nothing (criterion 45)', async () => {
      const first = await activeProcess();
      const second = await activeProcess(undefined, 'finn');
      const session = chat();
      // Two processes link the same chat at the same moment: exactly one wins.
      const [a, b] = await Promise.all([linkRequest(session, [first.processId]), linkRequest(session, [second.processId], 'finn')]);
      const results = await Promise.all([
        engine.reserveConversation({ agentSlug: 'mara', processId: first.processId, ...session, linkRequestId: a }),
        engine.reserveConversation({ agentSlug: 'finn', processId: second.processId, ...session, linkRequestId: b }),
      ]);
      assert.deepEqual(results.map((r) => r.outcome === 'reserved' ? 'reserved' : code(r)).sort(), ['conversation_busy', 'reserved']);
      // A chat held by an agent discussion.
      const talk = chat();
      assert.equal((await store.reserve({ ...talk, holderKind: 'agent_discussion', processId: 'discussion:9', role: 'home' })).ok, true);
      const onTalk = await linkRequest(talk, [first.processId]);
      assert.equal(code(await engine.reserveConversation({ agentSlug: 'mara', processId: first.processId, ...talk, linkRequestId: onTalk })), 'conversation_busy');
      // An expired request.
      const late = chat();
      const expired = await linkRequest(late, [first.processId], 'mara', 1);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(code(await engine.reserveConversation({ agentSlug: 'mara', processId: first.processId, ...late, linkRequestId: expired })), 'link_not_authorized');
    });

    async function linkedSession() {
      const process = await activeProcess({ actions: 20, modelCalls: 0 });
      const session = chat();
      const request = await linkRequest(session, [process.processId]);
      const linked = await engine.reserveConversation({ agentSlug: 'mara', processId: process.processId, ...session, linkRequestId: request });
      assert.equal(linked.outcome, 'reserved');
      return { ...process, session };
    }
    const setState = (processId: string, session: { channelType: string; conversationId: string }, state: 'live' | 'confirming' | 'closed' | 'cancelled' | 'scheduled') =>
      engine.setSessionState!({ processId, ...session, state });

    it('the session state follows the table; live needs readiness (criterion 60); closed releases', async () => {
      const { processId, session, scope } = await linkedSession();
      const access = () => store.processAccess({ pluginId: ENGINE, processId, ...session });
      assert.deepEqual((await access()).session, { state: 'scheduled', released: false });
      // Not ready: the session does not go live and nothing changes.
      notReady.set(session.conversationId, 'rsc_missing: ChatMessage.Read.Chat is not consented');
      const refused = await setState(processId, session, 'live');
      assert.equal(code(refused), 'not_ready');
      assert.match((refused as ExecutionRefusal).message, /ChatMessage\.Read\.Chat/);
      assert.equal((await access()).session?.state, 'scheduled');
      notReady.delete(session.conversationId);
      assert.equal((await setState(processId, session, 'live')).outcome, 'updated');
      assert.equal((await setState(processId, session, 'live')).outcome, 'updated', 'the same state again');
      assert.equal(code(await setState(processId, session, 'scheduled')), 'session_state', 'no way back');
      assert.equal((await setState(processId, session, 'confirming')).outcome, 'updated');
      // In confirming: consent and status go out, moderation does not.
      const authorize = (purpose: 'moderation' | 'consent') =>
        engine.authorize({ scopeId: scope.id, phase: 'active', purpose, action: 'post', target: { kind: 'conversation', ...session }, emission: 'template' });
      assert.equal(code(await authorize('moderation')), 'purpose_not_allowed');
      assert.equal((await authorize('consent')).outcome, 'authorized');
      const closed = await setState(processId, session, 'closed');
      assert.equal(closed.outcome === 'updated' && closed.reservation.releasedAt !== undefined, true);
      assert.deepEqual((await access()).session, { state: 'closed', released: true });
      assert.equal(await store.holder(session.channelType, session.conversationId), undefined, 'the conversation is free');
      // Released: only a closing scope sends there.
      assert.equal(code(await authorize('consent')), 'target_not_allowed');
      const closing = await engine.openScope({
        agentSlug: 'mara', processId, kind: 'closing', eventId: 'session-close-1', deadline: inHours(24),
        budget: { actions: 5, modelCalls: 0 }, targets: [{ kind: 'conversation', ...session }],
      });
      assert.equal(closing.outcome, 'opened', JSON.stringify(closing));
      if (closing.outcome !== 'opened') return;
      const protocol = await engine.authorize({
        scopeId: closing.scope.id, phase: 'active', purpose: 'protocol_dispatch', action: 'post', target: { kind: 'conversation', ...session }, emission: 'template',
      });
      assert.equal(protocol.outcome, 'authorized');
      assert.equal(code(await setState(processId, session, 'live')), 'session_state', 'a released session never re-opens');
    });

    it('a scheduled session is cancelled and released; another process asks nothing of it', async () => {
      const { processId, session } = await linkedSession();
      const other = await activeProcess(undefined, 'finn');
      assert.equal(code(await serviceFor(ENGINE).setSessionState!({ processId: other.processId, ...session, state: 'cancelled' })), 'unknown_scope');
      assert.equal(code(await serviceFor(OTHER).setSessionState!({ processId, ...session, state: 'cancelled' })), 'unknown_scope');
      assert.equal((await setState(processId, session, 'cancelled')).outcome, 'updated');
      assert.equal(await store.holder(session.channelType, session.conversationId), undefined);
    });
  });

  describe('#2091 sends drawn from a real scope', () => {
    function sends() {
      const posted: string[] = [];
      const service = createScopedSendService({
        callerPluginId: ENGINE,
        execution: () => engine,
        conversation: {
          capabilities: () => undefined,
          sendToConversation: (input: { conversationId: string }) => {
            posted.push(input.conversationId);
            return Promise.resolve({ outcome: 'delivered', messageId: `m-${String(posted.length)}` });
          },
          updateCard: () => Promise.resolve({ outcome: 'updated' }),
        } as never,
        direct: (input) => {
          posted.push(input.principal);
          return Promise.resolve({ outcome: 'delivered' } as never);
        },
      });
      return { service, posted };
    }
    const auth = (scopeId: string, processId: string, over: Record<string, unknown> = {}) => ({
      scopeId,
      processId,
      phase: 'active' as const,
      purpose: 'moderation' as const,
      emission: 'template' as const,
      ...over,
    });

    it('posts to a conversation of the scope and to nobody else, and counts each post', async () => {
      const { scope, processId, home } = await activeProcess({ actions: 2, modelCalls: 0 });
      const s = sends();
      const ok = await s.service.sendToConversation({ agentSlug: 'mara', ...home, message: { text: 'hi' }, authorization: auth(scope.id, processId) });
      assert.equal(ok.outcome, 'delivered');
      const foreign = await s.service.sendToConversation({
        agentSlug: 'mara', channelType: 'teams', conversationId: '19:someone-elses@thread.v2', message: { text: 'hi' }, authorization: auth(scope.id, processId),
      });
      assert.equal(foreign.outcome === 'unreachable' && foreign.executionCode, 'target_not_allowed');
      await s.service.sendToConversation({ agentSlug: 'mara', ...home, message: { text: 'again' }, authorization: auth(scope.id, processId) });
      const third = await s.service.sendToConversation({ agentSlug: 'mara', ...home, message: { text: 'once more' }, authorization: auth(scope.id, processId) });
      assert.equal(third.outcome === 'unreachable' && third.executionCode, 'budget_exhausted');
      assert.deepEqual(s.posted, [home.conversationId, home.conversationId]);
    });

    it('a closing scope still posts to the home conversation after its reservation was released', async () => {
      const { processId, home, scope } = await activeProcess();
      await engine.releaseConversation({ processId, ...home, reason: 'closed' });
      await engine.endScope(scope.id, 'closed');
      const closing = await engine.openScope({
        agentSlug: 'mara', processId, kind: 'closing', eventId: 'final', deadline: inHours(24 * 7),
        budget: { actions: 3, modelCalls: 0 }, targets: [{ kind: 'conversation', ...home }],
      });
      if (closing.outcome !== 'opened') throw new Error(JSON.stringify(closing));
      const s = sends();
      const moderation = await s.service.sendToConversation({ agentSlug: 'mara', ...home, message: { text: 'more votes?' }, authorization: auth(scope.id, processId) });
      assert.equal(moderation.outcome === 'unreachable' && moderation.executionCode, 'scope_ended', 'the active scope is over');
      const protocol = await s.service.sendToConversation({
        agentSlug: 'mara', ...home, message: { text: 'The protocol.' },
        authorization: auth(closing.scope.id, processId, { phase: 'closed', purpose: 'essential_message' }),
      });
      assert.equal(protocol.outcome, 'delivered');
    });

    it('writes only to people the scope lists, and a status-only person gets the status only', async () => {
      const { scope, processId } = await activeProcess();
      await engine.setPeople(scope.id, [
        { kind: 'person', channelType: 'teams', principalId: 'aad-anna' },
        { kind: 'person', channelType: 'teams', principalId: 'aad-guest', restriction: 'status_only' },
      ]);
      const s = sends();
      const dm = (principal: string, purpose: string) =>
        s.service.sendToPerson({ agentSlug: 'mara', channelType: 'teams', principal, message: { text: 'x' }, authorization: auth(scope.id, processId, { purpose }) });
      assert.equal((await dm('user:aad-anna', 'reminder')).outcome, 'delivered');
      const stranger = await dm('user:aad-bert', 'reminder');
      assert.equal(stranger.outcome === 'unreachable' && stranger.executionCode, 'target_not_allowed');
      const guest = await dm('user:aad-guest', 'reminder');
      assert.equal(guest.outcome === 'unreachable' && guest.executionCode, 'target_not_allowed');
      assert.equal((await dm('user:aad-guest', 'status')).outcome, 'delivered');
      assert.deepEqual(s.posted, ['user:aad-anna', 'user:aad-guest']);
    });
  });

  describe('#2078 kernel-issued grants', () => {
    const CONNECTOR = '@omadia/m365-connector';
    const grants = (pluginId = ENGINE) => createExecutionGrantsService({ pool, callerPluginId: pluginId });
    const verifier = () => createGrantVerificationService({ pool, callerPluginId: CONNECTOR });
    const PEOPLE = ['Anna@example.test', 'bert@example.test'];

    /** A process that was closed, with the closing scope of its final protocol. */
    async function closing() {
      const process = await activeProcess();
      const opened = await engine.openScope({
        agentSlug: 'mara', processId: process.processId, kind: 'closing', eventId: `final-${String(++seq)}`,
        deadline: inHours(24 * 20), budget: { actions: 10, modelCalls: 0 },
      });
      if (opened.outcome !== 'opened') throw new Error(JSON.stringify(opened));
      return { ...process, closing: opened.scope };
    }
    const dispatch = async () => {
      const c = await closing();
      const issued = await grants().issueGrant({ scopeId: c.closing.id, kind: 'protocol_dispatch', subject: 'protocol', recipients: PEOPLE });
      if (issued.outcome !== 'issued') throw new Error(JSON.stringify(issued));
      return { ...c, grant: issued.grant };
    };
    const ask = (grantId: string, recipients: string[], operation: 'send_mail' | 'free_busy' | 'create_invitation' = 'send_mail') =>
      verifier().verify({ grantId, operation, recipients });
    const codeOf = (outcome: Awaited<ReturnType<typeof ask>>): string => (outcome.allowed ? 'allowed' : outcome.code);

    it('a grant is issued under the scope kind it belongs to, by the plugin that owns the scope', async () => {
      const c = await closing();
      const g = grants();
      const issue = (over: Record<string, unknown>) =>
        g.issueGrant({ scopeId: c.closing.id, kind: 'protocol_dispatch', recipients: PEOPLE, ...over } as never);
      assert.equal(code(await issue({ scopeId: c.scope.id })), 'scope_order', 'not under the active scope');
      assert.equal(code(await issue({ kind: 'followup_scheduling' })), 'scope_order');
      assert.equal(code(await issue({ kind: 'everything' })), 'invalid_request');
      assert.equal(code(await issue({ recipients: [] })), 'invalid_request');
      assert.equal(code(await issue({ recipients: ['not an address'] })), 'invalid_request');
      assert.equal(code(await grants(OTHER).issueGrant({ scopeId: c.closing.id, kind: 'protocol_dispatch', recipients: PEOPLE })), 'unknown_scope');
      const issued = await issue({});
      assert.equal(issued.outcome, 'issued');
      if (issued.outcome !== 'issued') return;
      assert.deepEqual(issued.grant.recipients, ['anna@example.test', 'bert@example.test']);
      assert.equal(issued.grant.live, true);
      // Protocol dispatch: at most 7 days, although the scope runs 20.
      const days = (new Date(issued.grant.expiresAt).getTime() - Date.now()) / (24 * HOUR);
      assert.ok(days > 6.9 && days <= 7, String(days));
      assert.equal(code(await issue({ subject: 'other', expiresAt: inHours(24 * 8) })), 'limit_exceeded');
    });

    it('the connector is answered per operation and recipient, and every answer is recorded', async () => {
      const { grant, processId } = await dispatch();
      assert.deepEqual(await ask(grant.id, ['ANNA@example.test']), { allowed: true, kind: 'protocol_dispatch', processId });
      const stranger = await ask(grant.id, ['anna@example.test', 'eve@evil.test']);
      assert.deepEqual(stranger, {
        allowed: false,
        code: 'recipient_not_covered',
        message: 'the grant does not cover every recipient',
        notCovered: ['eve@evil.test'],
      });
      assert.equal(codeOf(await ask(grant.id, ['anna@example.test'], 'create_invitation')), 'operation_not_covered');
      assert.equal(codeOf(await ask('00000000-0000-4000-8000-000000000000', ['anna@example.test'])), 'unknown_grant');
      assert.equal(codeOf(await ask('not-a-grant', ['anna@example.test'])), 'unknown_grant');
      assert.equal(codeOf(await ask(grant.id, [])), 'invalid_request');

      const listed = await grants().listGrants(processId);
      assert.deepEqual(
        listed[0]?.uses.map((u) => [u.operation, u.allowed, u.refusal, u.askedBy, u.recipients.length]),
        [
          ['send_mail', true, undefined, CONNECTOR, 1],
          ['send_mail', false, 'recipient_not_covered', CONNECTOR, 2],
          ['create_invitation', false, 'operation_not_covered', CONNECTOR, 1],
        ],
      );
      assert.deepEqual(await grants(OTHER).listGrants(processId), [], 'another plugin sees no grant of the process');
    });

    it('each kind covers its own operations', async () => {
      const process = await activeProcess();
      const budget = { actions: 5, modelCalls: 0 };
      const scheduling = await engine.openScope({ agentSlug: 'mara', processId: process.processId, kind: 'scheduling', eventId: 'meeting-1', deadline: inHours(48), budget });
      const followUp = await engine.openScope({ agentSlug: 'mara', processId: process.processId, kind: 'follow_up', deadline: inHours(72), budget });
      if (scheduling.outcome !== 'opened' || followUp.outcome !== 'opened') throw new Error('unreachable');
      const meeting = await grants().issueGrant({ scopeId: scheduling.scope.id, kind: 'followup_scheduling', subject: 'meeting-1', recipients: PEOPLE });
      const reminders = await grants().issueGrant({ scopeId: followUp.scope.id, kind: 'followup_reminders', recipients: PEOPLE });
      if (meeting.outcome !== 'issued' || reminders.outcome !== 'issued') throw new Error('unreachable');
      assert.equal(codeOf(await ask(meeting.grant.id, ['bert@example.test'], 'free_busy')), 'allowed');
      assert.equal(codeOf(await ask(meeting.grant.id, PEOPLE, 'create_invitation')), 'allowed');
      assert.equal(codeOf(await ask(meeting.grant.id, PEOPLE, 'send_mail')), 'operation_not_covered');
      assert.equal(codeOf(await ask(reminders.grant.id, PEOPLE, 'send_mail')), 'allowed');
      assert.equal(codeOf(await ask(reminders.grant.id, PEOPLE, 'free_busy')), 'operation_not_covered');
      // Without a deadline of its own a grant ends with its scope.
      assert.equal(meeting.grant.expiresAt, scheduling.scope.deadline);
    });

    it('revoked once, never live again; the recipients of a live grant can be replaced', async () => {
      const { grant, closing: scope, processId } = await dispatch();
      const replaced = await grants().issueGrant({ scopeId: scope.id, kind: 'protocol_dispatch', subject: 'protocol', recipients: ['cara@example.test'] });
      assert.equal(replaced.outcome === 'issued' && replaced.grant.id, grant.id, 'the same grant');
      assert.equal(codeOf(await ask(grant.id, ['anna@example.test'])), 'recipient_not_covered', 'a participant who left is no longer covered');
      assert.equal(codeOf(await ask(grant.id, ['cara@example.test'])), 'allowed');

      await grants(OTHER).revokeGrant(grant.id, 'hostile');
      assert.equal(codeOf(await ask(grant.id, ['cara@example.test'])), 'allowed', 'only the owner revokes');
      await grants().revokeGrant(grant.id, 'all sends confirmed');
      assert.equal(codeOf(await ask(grant.id, ['cara@example.test'])), 'revoked');
      const again = await grants().issueGrant({ scopeId: scope.id, kind: 'protocol_dispatch', subject: 'protocol', recipients: PEOPLE });
      assert.equal(code(again), 'scope_exists');
      const listed = (await grants().listGrants(processId))[0];
      assert.deepEqual([listed?.live, listed?.revokeReason], [false, 'all sends confirmed']);
    });

    it('ends with its scope: stop, end of service and the deadline, without a further step', async () => {
      const stopped = await dispatch();
      await engine.endScope(stopped.closing.id, 'stopped');
      assert.equal(codeOf(await ask(stopped.grant.id, ['anna@example.test'])), 'scope_ended');
      assert.equal(code(await grants().issueGrant({ scopeId: stopped.closing.id, kind: 'protocol_dispatch', subject: 'late', recipients: PEOPLE })), 'scope_ended');

      const disabled = await dispatch();
      await store.revokeAll({ agentId: agents.get('mara')!.id }, 'agent disabled');
      assert.equal(codeOf(await ask(disabled.grant.id, ['anna@example.test'])), 'scope_ended');

      const late = await dispatch();
      await pool.query("UPDATE execution_grants SET expires_at = now() - interval '1 second' WHERE id = $1", [late.grant.id]);
      assert.equal(codeOf(await ask(late.grant.id, ['anna@example.test'])), 'expired');
    });

    it('an operator stop refuses the use and ends nothing', async () => {
      const { grant, processId } = await dispatch();
      const stop = await store.setKillSwitch({ level: 'process', agentId: agents.get('mara')!.id, processId, reason: '', setBy: 'op' });
      assert.equal(codeOf(await ask(grant.id, ['anna@example.test'])), 'kill_switch');
      await store.clearKillSwitch(stop.id, 'op');
      assert.equal(codeOf(await ask(grant.id, ['anna@example.test'])), 'allowed');
    });
  });

  describe('#2089 who may be answered in a private chat', () => {
    it('lists the processes whose open scopes name the person, and none after they ended', async () => {
      const a = await activeProcess();
      const b = await activeProcess();
      const finn = await activeProcess(undefined, 'finn');
      const anna = { kind: 'person' as const, channelType: 'teams', principalId: 'AAD-Anna' };
      await engine.setPeople(a.scope.id, [anna]);
      await engine.setPeople(b.scope.id, [{ ...anna, restriction: 'status_only' }]);
      await engine.setPeople(finn.scope.id, [anna]);
      const of = (agentSlug: string, principalId: string, channelType = 'teams') =>
        store.processesListingPerson({ agentId: agents.get(agentSlug)!.id, channelType, principalId });
      // Other tests of this suite left scopes of 'mara' open: look at ours.
      const ours = [a.processId, b.processId, finn.processId];
      const listed = async (agentSlug: string): Promise<string[]> =>
        (await of(agentSlug, 'aad-anna')).map((p) => p.processId).filter((id) => ours.includes(id)).sort();
      assert.deepEqual(await listed('mara'), [a.processId, b.processId].sort(), 'compared lower-cased, per agent');
      assert.deepEqual(await of('mara', 'aad-bert'), []);
      assert.deepEqual(await of('mara', 'aad-anna', 'slack'), []);
      await engine.endScope(a.scope.id, 'closed');
      await pool.query("UPDATE execution_scopes SET deadline = now() - interval '1 second' WHERE id = $1", [b.scope.id]);
      assert.deepEqual(await listed('mara'), [], 'an ended scope and one past its deadline list nobody');
      assert.deepEqual(await listed('finn'), [finn.processId]);
    });
  });

  describe('#2089 what a process may read', () => {
    it('follows its reservation and its open scopes', async () => {
      const { processId, home, scope } = await activeProcess();
      const of = (conversationId = home.conversationId) =>
        store.processAccess({ pluginId: ENGINE, processId, channelType: home.channelType, conversationId });
      assert.deepEqual(await of(), { reserved: true, everReserved: true, openScope: true });
      assert.deepEqual(await of('19:never-held@thread.v2'), { reserved: false, everReserved: false, openScope: true });
      assert.deepEqual(
        await store.processAccess({ pluginId: OTHER, processId, ...home }),
        { reserved: false, everReserved: false, openScope: false },
        'another plugin with the same process id has nothing',
      );
      const notified: string[] = [];
      const withHook = createExecutionAuthorizationService({
        store,
        callerPluginId: ENGINE,
        resolveAgent: (slug) => agents.get(slug),
        archetypePluginIdFor: () => ENGINE,
        configuringMaxMs: 72 * HOUR,
        onAccessChanged: () => void notified.push('changed'),
      });
      await withHook.releaseConversation({ processId, ...home, reason: 'closed' });
      assert.deepEqual(notified, ['changed'], 'the message subscriptions are told at once');
      assert.deepEqual(await of(), { reserved: false, everReserved: true, openScope: true });
      await pool.query("UPDATE execution_scopes SET deadline = now() - interval '1 second' WHERE id = $1", [scope.id]);
      assert.equal((await of()).openScope, false, 'a scope past its deadline is not open, also before the sweep');
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

  describe('rollout defect D34: a discussion holds its conversation only while it runs', () => {
    const MIGRATION = '0078_release_stale_discussion_reservations.sql';
    const held = async (conversationId: string): Promise<boolean> =>
      ((await pool.query('SELECT 1 FROM conversation_reservations WHERE conversation_id = $1 AND released_at IS NULL', [conversationId])).rowCount ?? 0) > 0;
    /** A discussion reservation taken `ageMinutes` ago, with or without an attachment. */
    const discussion = async (
      attachment: 'attached' | 'pending_expired' | 'pending_fresh' | 'none',
      ageMinutes = 10,
    ): Promise<string> => {
      const { channelType, conversationId } = chat();
      await pool.query(
        `INSERT INTO conversation_reservations (channel_type, conversation_id, holder_kind, process_id, reserved_at)
         VALUES ($1, $2, 'agent_discussion', $3, now() - make_interval(mins => $4))`,
        [channelType, conversationId, `discussion:${conversationId}`, ageMinutes],
      );
      if (attachment !== 'none') {
        await pool.query(
          `INSERT INTO conductor_ephemeral_attachments (agent_slug, channel_type, channel_key, state, expires_at)
           VALUES ('hr', $1, $2, $3, now() + make_interval(mins => $4))`,
          [channelType, conversationId, attachment === 'attached' ? 'attached' : 'pending', attachment === 'pending_expired' ? -5 : 60],
        );
      }
      return conversationId;
    };

    before(async () => {
      // The Conductor's table, as its own migrator creates it (0010).
      await pool.query(`CREATE TABLE IF NOT EXISTS conductor_ephemeral_attachments (
        id BIGSERIAL PRIMARY KEY, workflow_id TEXT, agent_slug TEXT NOT NULL, channel_type TEXT NOT NULL,
        channel_key TEXT NOT NULL, role_key TEXT, state TEXT NOT NULL DEFAULT 'pending',
        expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (channel_type, channel_key))`);
    });

    it('migration 0078 releases the reservations no running discussion stands behind, and no others', async () => {
      const running = await discussion('attached');
      const starting = await discussion('pending_fresh');
      const stale = await discussion('pending_expired');
      const orphan = await discussion('none');
      const facilitation = await activeProcess();
      const sql = await readFile(resolve(MIGRATIONS_DIR, MIGRATION), 'utf8');
      await pool.query(sql);
      await pool.query(sql); // idempotent
      assert.deepEqual(
        [await held(running), await held(starting), await held(stale), await held(orphan), await held(facilitation.home.conversationId)],
        [true, true, false, false, true],
      );
      const reason = await pool.query<{ release_reason: string }>(
        'SELECT release_reason FROM conversation_reservations WHERE conversation_id = $1',
        [stale],
      );
      assert.equal(reason.rows[0]?.release_reason, 'no_running_discussion');
    });

    it('the sweep releases them too, but leaves a discussion that is just starting alone', async () => {
      const running = await discussion('attached');
      const stale = await discussion('pending_expired');
      const orphan = await discussion('none');
      // Reserved a moment ago, attachment not written yet: the start window.
      const justReserved = await discussion('none', 0);
      const swept = await store.sweepExpired();
      assert.ok(swept.reservationsReleased >= 2);
      assert.deepEqual(
        [await held(running), await held(stale), await held(orphan), await held(justReserved)],
        [true, false, false, true],
      );
      // A facilitation can take the freed conversation.
      const taken = await store.reserve({ channelType: 'teams', conversationId: stale, holderKind: 'archetype_process', pluginId: ENGINE, processId: process(), role: 'home' });
      assert.equal(taken.ok, true);
    });

    it('every held reservation is listed for the operator and can be released by its id, once', async () => {
      const orphan = await discussion('none', 0);
      const listed = (await store.listHeldReservations(500)).find((r) => r.conversationId === orphan);
      assert.ok(listed);
      assert.equal(listed.holderKind, 'agent_discussion');
      const released = await store.releaseReservation(listed.id, 'released by an operator');
      assert.equal(released?.conversationId, orphan);
      assert.equal(await store.releaseReservation(listed.id, 'again'), undefined);
      assert.equal(await held(orphan), false);
      assert.ok(!(await store.listHeldReservations(500)).some((r) => r.id === listed.id));
    });
  });
});
