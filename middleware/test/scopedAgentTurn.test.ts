/**
 * #2090 — `agentTurn@2`: a model turn as an authorized action.
 *
 * The turn itself is the first major's (same guards, same agent bundle). What
 * is tested here is the envelope: the kernel draws the authorization from the
 * named scope BEFORE any model is called, refuses the turn when it gets none,
 * counts the model calls the turn made (helper and guard calls included) and
 * settles them, whatever the turn's outcome.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatAgent } from '@omadia/channel-sdk';
import type {
  AuthorizeActionRequest,
  ExecutionAuthorizationService,
  ExecutionRefusalCode,
  ExecutionScope,
  ScopedAgentTurnRequest,
} from '@omadia/plugin-api';
import { meterModelCalls as builtMeter } from '@omadia/usage-telemetry';

import { meterModelCalls, recordUsage } from '../packages/harness-usage-telemetry/src/index.js';
import { wrapFacilitatorAgent } from '../packages/harness-orchestrator/src/facilitatorAgent.js';
import {
  AgentTurnBudget,
  AgentTurnHistory,
  createScopedAgentTurnService,
} from '../src/agents/agentTurnService.js';

const ENGINE = '@omadia/agent-facilitator';
const SCOPE_ID = 'scope-active';
const USAGE = { source: 'test', model: 'm', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };

const scope = (over: Partial<ExecutionScope> = {}): ExecutionScope => ({
  id: SCOPE_ID,
  agentSlug: 'mara',
  processId: 'fac-7',
  kind: 'active',
  eventId: '',
  state: 'open',
  deadline: '2026-12-01T10:00:00.000Z',
  absoluteLimit: '2027-11-19T10:00:00.000Z',
  deadlineWait: false,
  budget: { actions: 10, modelCalls: 10 },
  used: { actions: 0, modelCalls: 0 },
  targets: [],
  openedAt: '2026-11-19T10:00:00.000Z',
  ...over,
});

function harness(options: {
  /** Model calls the turn makes: the main call plus helpers and guards. */
  modelCalls?: number;
  refuse?: ExecutionRefusalCode;
  scopes?: ExecutionScope[];
  turnThrows?: boolean;
  isEngine?: boolean;
  noDatabase?: boolean;
} = {}) {
  const order: string[] = [];
  const authorized: AuthorizeActionRequest[] = [];
  const settled: { id: string; modelCalls: number }[] = [];
  const execution = {
    listScopes: (processId: string) => {
      order.push(`listScopes(${processId})`);
      return Promise.resolve(options.scopes ?? [scope()]);
    },
    authorize: (request: AuthorizeActionRequest) => {
      order.push('authorize');
      authorized.push(request);
      return Promise.resolve(
        options.refuse
          ? { outcome: 'refused' as const, code: options.refuse, message: `refused: ${options.refuse}` }
          : { outcome: 'authorized' as const, authorizationId: 'auth-1', scopeId: request.scopeId, remaining: { actions: 9, modelCalls: 5 } },
      );
    },
    settle: (id: string, used: { modelCalls: number }) => {
      order.push('settle');
      settled.push({ id, modelCalls: used.modelCalls });
      return Promise.resolve();
    },
  } as unknown as ExecutionAuthorizationService;
  const inner: ChatAgent = {
    chat: async () => {
      order.push('model');
      for (let i = 0; i < (options.modelCalls ?? 1); i += 1) {
        await Promise.resolve();
        recordUsage(USAGE);
      }
      if (options.turnThrows) throw new Error('provider down');
      return { text: 'Three options are on the table.' };
    },
    chatStream: (() => undefined) as never,
  };
  const entry = {
    agent: { id: 'id-mara', slug: 'mara', name: 'mara', status: 'enabled', kind: 'facilitator', archetype: 'facilitator' },
    plugins: [{ pluginId: ENGINE, enabled: true }],
    built: { bundle: { agent: wrapFacilitatorAgent(inner, { agentSlug: 'mara' }) } },
  };
  const service = createScopedAgentTurnService({
    getRegistry: () => ({ get: (slug: string) => (slug === 'mara' ? entry : undefined), channelTypesWithIdentity: () => ['teams'] }) as never,
    callerPluginId: ENGINE,
    isEngine: () => options.isEngine !== false,
    history: new AgentTurnHistory(),
    budget: new AgentTurnBudget(60),
    execution: () => (options.noDatabase ? undefined : execution),
    meter: meterModelCalls,
  });
  return { service, order, authorized, settled };
}

const REQUEST: ScopedAgentTurnRequest = {
  agentSlug: 'mara',
  sessionKey: 'fac-7',
  channelType: 'teams',
  conversationId: '19:offsite@thread.v2',
  input: 'Summarise where we are.',
  scopeId: SCOPE_ID,
  processId: 'fac-7',
  phase: 'active',
  purpose: 'moderation',
  emission: 'prose',
  budget: { modelCalls: 5 },
};

describe('#2090 agentTurn@2', () => {
  it('authorizes before any model call, counts helper and guard calls, and returns what was not used', async () => {
    const h = harness({ modelCalls: 3 });
    const outcome = await h.service.runTurn(REQUEST);
    assert.deepEqual(outcome, {
      outcome: 'completed',
      text: 'Three options are on the table.',
      authorizationId: 'auth-1',
      modelCalls: { reserved: 5, used: 3 },
    });
    assert.deepEqual(h.order, ['listScopes(fac-7)', 'authorize', 'model', 'settle']);
    assert.deepEqual(h.authorized, [
      { scopeId: SCOPE_ID, phase: 'active', purpose: 'moderation', action: 'model_turn', emission: 'prose', modelCalls: 5 },
    ]);
    assert.deepEqual(h.settled, [{ id: 'auth-1', modelCalls: 3 }]);
  });

  for (const code of ['deadline_passed', 'budget_exhausted', 'kill_switch', 'scope_ended', 'phase_mismatch', 'purpose_not_allowed'] as const) {
    it(`a refused authorization (${code}) runs no model and settles nothing`, async () => {
      const h = harness({ refuse: code });
      const outcome = await h.service.runTurn(REQUEST);
      assert.deepEqual(outcome, {
        outcome: 'refused',
        code: 'not_authorized',
        message: `refused: ${code}`,
        executionCode: code,
      });
      assert.ok(!h.order.includes('model') && !h.order.includes('settle'));
    });
  }

  it('the scope must be this process\'s and this agent\'s', async () => {
    for (const scopes of [[], [scope({ id: 'another' })], [scope({ agentSlug: 'finn' })]]) {
      const h = harness({ scopes });
      const outcome = await h.service.runTurn(REQUEST);
      assert.equal(outcome.outcome === 'refused' && outcome.executionCode, 'unknown_scope');
      assert.deepEqual(h.order, ['listScopes(fac-7)']);
    }
  });

  it('a turn that fails still settles what it used, and names its authorization', async () => {
    const h = harness({ modelCalls: 2, turnThrows: true });
    const outcome = await h.service.runTurn(REQUEST);
    assert.deepEqual(outcome, { outcome: 'failed', message: 'provider down', authorizationId: 'auth-1' });
    assert.deepEqual(h.settled, [{ id: 'auth-1', modelCalls: 2 }]);
  });

  it('a turn that made more calls than it reserved reports the real number', async () => {
    const h = harness({ modelCalls: 9 });
    const outcome = await h.service.runTurn({ ...REQUEST, budget: { modelCalls: 2 } });
    assert.deepEqual(outcome.outcome === 'completed' && outcome.modelCalls, { reserved: 2, used: 9 });
    assert.deepEqual(h.settled, [{ id: 'auth-1', modelCalls: 9 }]);
  });

  it('spends nothing of the scope on a caller that may not run the agent, or on a malformed request', async () => {
    const notEngine = harness({ isEngine: false });
    assert.equal((await notEngine.service.runTurn(REQUEST)).outcome, 'refused');
    assert.deepEqual(notEngine.order, []);

    const h = harness();
    for (const bad of [
      { ...REQUEST, scopeId: '' },
      { ...REQUEST, processId: '' },
      { ...REQUEST, emission: 'template' as never },
      { ...REQUEST, budget: { modelCalls: 0 } },
      { ...REQUEST, budget: { modelCalls: 1.5 } },
      { ...REQUEST, budget: undefined as never },
      { ...REQUEST, agentSlug: 'nobody' },
    ]) {
      const outcome = await h.service.runTurn(bad);
      assert.equal(outcome.outcome, 'refused', JSON.stringify(bad));
    }
    assert.deepEqual(h.order, []);
  });

  it('is unavailable without a database, and never falls back to an unauthorized turn', async () => {
    const h = harness({ noDatabase: true });
    const outcome = await h.service.runTurn(REQUEST);
    assert.equal(outcome.outcome === 'refused' && outcome.code, 'unavailable');
    assert.deepEqual(h.order, []);
  });

  it('passes the stated target on to the authorization', async () => {
    const h = harness();
    const target = { kind: 'conversation' as const, channelType: 'teams', conversationId: '19:offsite@thread.v2' };
    await h.service.runTurn({ ...REQUEST, target });
    assert.deepEqual(h.authorized[0]?.target, target);
  });
});

describe('#2090 model-call meter', () => {
  const call = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i += 1) {
      await Promise.resolve();
      recordUsage(USAGE);
    }
  };

  it('counts the calls recorded inside the scope, with or without a database', async () => {
    assert.equal((await meterModelCalls(() => call(4))).modelCalls, 4);
    assert.equal((await meterModelCalls(() => Promise.resolve('x'))).modelCalls, 0);
  });

  it('keeps two turns that run at the same time apart', async () => {
    const [a, b] = await Promise.all([meterModelCalls(() => call(3)), meterModelCalls(() => call(7))]);
    assert.deepEqual([a.modelCalls, b.modelCalls], [3, 7]);
  });

  it('an inner meter counts for the outer one as well', async () => {
    const outer = await meterModelCalls(async () => {
      await call(1);
      const inner = await meterModelCalls(() => call(2));
      return inner.modelCalls;
    });
    assert.deepEqual([outer.value, outer.modelCalls], [2, 3]);
  });

  it('reports the count of a scope that threw to the outer meter, and rethrows', async () => {
    const outer = await meterModelCalls(async () => {
      await assert.rejects(() =>
        meterModelCalls(async () => {
          await call(2);
          throw new Error('boom');
        }),
      );
    });
    assert.equal(outer.modelCalls, 2);
  });

  it('a call recorded through another copy of the package still reaches the meter', async () => {
    // The kernel resolves the package from its build, plugins and tests may
    // load the source: two module instances, one process-wide meter.
    assert.notEqual(builtMeter, meterModelCalls);
    assert.equal((await builtMeter(() => call(2))).modelCalls, 2);
  });
});
