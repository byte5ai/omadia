/**
 * #2090 — `agentTurn@2`: a model turn as an authorized action.
 *
 * The turn itself (its guards, the agent bundle) is in
 * `agentTurnService.test.ts`. What is tested here is the envelope: the kernel draws the authorization from the
 * named scope BEFORE any model is called, refuses the turn when it gets none,
 * counts the model calls the turn made (helper and guard calls included) and
 * settles them, whatever the turn's outcome.
 */

import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { ChatAgent } from '@omadia/channel-sdk';
import type {
  AuthorizeActionRequest,
  ExecutionAuthorizationService,
  ExecutionRefusalCode,
  ExecutionScope,
  ScopedAgentTurnRequest,
} from '@omadia/plugin-api';
import { admitModelCall as builtAdmit } from '@omadia/llm-provider-api';
import { meterModelCalls as builtMeter } from '@omadia/usage-telemetry';

import { admitModelCall, isModelCallNotCovered } from '../packages/llm-provider-api/src/index.js';
import { meterModelCalls } from '../packages/harness-usage-telemetry/src/index.js';
import { wrapFacilitatorAgent } from '../packages/harness-orchestrator/src/facilitatorAgent.js';
import {
  AgentTurnBudget,
  AgentTurnHistory,
  createScopedAgentTurnService,
} from '../src/agents/agentTurnService.js';

const ENGINE = '@omadia/agent-facilitator';
const SCOPE_ID = 'scope-active';

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
  /** Only helper calls, which swallow a refusal; no main model call. */
  helpersOnly?: boolean;
  isEngine?: boolean;
  noDatabase?: boolean;
} = {}) {
  const order: string[] = [];
  const authorized: AuthorizeActionRequest[] = [];
  const settled: { id: string; modelCalls: number }[] = [];
  let swallowed = 0;
  const history = new AgentTurnHistory();
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
      // Helper and guard calls first, as a turn makes them: each passes the
      // provider gate, and each swallows a failure and carries on.
      for (let i = 1; i < (options.modelCalls ?? 1); i += 1) {
        await Promise.resolve();
        try {
          admitModelCall();
        } catch {
          swallowed += 1;
        }
      }
      if (!options.helpersOnly) admitModelCall(); // the main model call: not swallowed
      if (options.turnThrows) throw new Error('provider down');
      return { text: 'Three options are on the table.' };
    },
    chatStream: (() => undefined) as never,
  };
  const entry = {
    agent: { id: 'id-mara', slug: 'mara', name: 'mara', status: 'enabled', archetype: 'facilitator' },
    plugins: [{ pluginId: ENGINE, enabled: true }],
    built: { bundle: { agent: wrapFacilitatorAgent(inner, { agentSlug: 'mara' }) } },
  };
  const service = createScopedAgentTurnService({
    getRegistry: () => ({ get: (slug: string) => (slug === 'mara' ? entry : undefined), channelTypesWithIdentity: () => ['teams'] }) as never,
    callerPluginId: ENGINE,
    isEngine: () => options.isEngine !== false,
    history,
    budget: new AgentTurnBudget(60),
    execution: () => (options.noDatabase ? undefined : execution),
    meter: meterModelCalls,
  });
  return { service, order, authorized, settled, history, swallowed: () => swallowed };
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

  it('the reservation is a hard cap: the call it does not cover is not made and the turn ends refused', async () => {
    const h = harness({ modelCalls: 9 });
    const outcome = await h.service.runTurn({ ...REQUEST, budget: { modelCalls: 2 } });
    assert.deepEqual(outcome, {
      outcome: 'refused',
      code: 'reservation_exceeded',
      message: 'the turn needed more than the 2 model calls it reserved; it was ended and returned no text',
      authorizationId: 'auth-1',
      modelCalls: { reserved: 2, used: 2, refused: 7 },
    });
    // Exactly the reserved calls were made and are charged.
    assert.deepEqual(h.settled, [{ id: 'auth-1', modelCalls: 2 }]);
  });

  it('an answer produced although a helper\'s call was refused does not stand, and leaves no history', async () => {
    // Three helper calls that swallow their failure, no main call: the turn
    // "succeeds" with text. One call was reserved.
    const h = harness({ modelCalls: 4, helpersOnly: true });
    const outcome = await h.service.runTurn({ ...REQUEST, budget: { modelCalls: 1 } });
    assert.equal(outcome.outcome === 'refused' && outcome.code, 'reservation_exceeded');
    assert.deepEqual(outcome.outcome === 'refused' && outcome.modelCalls, { reserved: 1, used: 1, refused: 2 });
    assert.equal(h.swallowed(), 2, 'the helpers did carry on');
    assert.deepEqual(h.history.get('facilitation:mara:fac-7'), [], 'the next turn must not build on a refused answer');
  });

  it('a turn inside its reservation keeps its history', async () => {
    const h = harness({ modelCalls: 2 });
    await h.service.runTurn(REQUEST);
    assert.equal(h.history.get('facilitation:mara:fac-7').length, 1);
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

describe('#2090 model-call gate and meter', () => {
  const call = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i += 1) {
      await Promise.resolve();
      admitModelCall();
    }
  };

  it('outside a metered scope the gate lets every call through', () => {
    assert.doesNotThrow(() => admitModelCall());
  });

  it('counts the calls made inside the scope', async () => {
    assert.deepEqual(await meterModelCalls(() => call(4)), { value: undefined, modelCalls: 4, refused: 0 });
    assert.equal((await meterModelCalls(() => Promise.resolve('x'))).modelCalls, 0);
  });

  // The error is recognised by name (`isModelCallNotCovered`): the check that
  // throws belongs to whichever copy of the package installed the gate.
  it('refuses the call beyond the limit, before it is made', async () => {
    let made = 0;
    await assert.rejects(
      () =>
        meterModelCalls(
          async () => {
            for (let i = 0; i < 5; i += 1) {
              admitModelCall();
              made += 1;
            }
          },
          { limit: 3 },
        ),
      (err: unknown) => isModelCallNotCovered(err) && (err as { limit?: number }).limit === 3,
    );
    assert.equal(made, 3);
  });

  it('reports a refused call also when the work swallowed it', async () => {
    const result = await meterModelCalls(
      async (probe) => {
        await call(1);
        try {
          admitModelCall();
        } catch {
          // a helper that carries on
        }
        return probe();
      },
      { limit: 1 },
    );
    assert.deepEqual(result, { value: { modelCalls: 1, refused: 1 }, modelCalls: 1, refused: 1 });
  });

  it('keeps two turns that run at the same time apart', async () => {
    const [a, b] = await Promise.all([
      meterModelCalls(() => call(3), { limit: 3 }),
      meterModelCalls(() => call(7), { limit: 7 }),
    ]);
    assert.deepEqual([a.modelCalls, a.refused, b.modelCalls, b.refused], [3, 0, 7, 0]);
  });

  it('nested scopes: a call counts for both, and the tighter limit refuses', async () => {
    const outer = await meterModelCalls(
      async () => {
        await call(1);
        const inner = await meterModelCalls(() => call(2));
        // The outer limit of 3 is reached: the next call is refused although
        // the inner scope has no limit of its own.
        await assert.rejects(() => meterModelCalls(() => call(1)), isModelCallNotCovered);
        return inner.modelCalls;
      },
      { limit: 3 },
    );
    assert.deepEqual([outer.value, outer.modelCalls, outer.refused], [2, 3, 1]);
  });

  it('a provider loaded from another copy of the package reaches the same meter', async () => {
    // The kernel resolves packages from their build; plugins and tests may
    // load the source: two module instances, one process-wide gate.
    assert.notEqual(builtAdmit, admitModelCall);
    assert.notEqual(builtMeter, meterModelCalls);
    const viaBuilt = await builtMeter(async () => {
      admitModelCall();
      builtAdmit();
    });
    assert.equal(viaBuilt.modelCalls, 2);
    await assert.rejects(
      () => meterModelCalls(async () => { builtAdmit(); builtAdmit(); }, { limit: 1 }),
      (err: unknown) => (err as Error).name === 'ModelCallNotCoveredError',
    );
  });
});

describe('#2090 every provider passes the gate', () => {
  // A file that defines a provider-shaped `complete` either reaches a backend
  // itself, and then it must call the gate, or it hands the request to
  // another provider, which does. A new implementation that is on neither
  // list fails here.
  const GATED = [
    'packages/llm-adapter-anthropic/src/anthropicProvider.ts',
    'packages/llm-adapter-openai/src/openaiProvider.ts',
    'packages/llm-adapter-openai-responses/src/responsesProvider.ts',
    'src/platform/claudeCliAdapter.ts',
    'packages/harness-orchestrator/src/cliChatAgent.ts',
  ];
  const DELEGATES: Record<string, string> = {
    'packages/llm-provider-api/src/types.ts': 'the interface itself',
    'packages/harness-usage-telemetry/src/withProviderUsageTracking.ts': 'wraps a provider and calls its complete/stream',
    'src/platform/anthropicLlmProvider.ts': 'the plugin `llm` service over the neutral Anthropic provider',
    'src/platform/pluginContext.ts': 'ctx.llm: hands the request to the resolved provider',
    'src/plugins/builder/previewRuntime.ts': 'ctx.llm of a builder preview: hands the request to the provider',
  };
  const ROOT = new URL('../', import.meta.url);
  const read = (file: string): string => readFileSync(new URL(file, ROOT), 'utf8');

  function definers(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const path = `${dir}${entry.name}`;
      if (entry.isDirectory()) definers(`${path}/`, out);
      else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
        if (/complete\(req: LlmRequest\)|complete\(request: LlmRequest\)|async complete\(/.test(read(path))) out.push(path);
      }
    }
    return out;
  }

  it('each implementation that reaches a backend calls admitModelCall()', () => {
    for (const file of GATED) {
      assert.match(read(file), /admitModelCall\(\);/, `${file} must pass the gate before it calls its backend`);
    }
  });

  it('every file that defines a provider-shaped complete() is gated or a known delegate', () => {
    const found = [...definers('src/'), ...definers('packages/')].sort();
    const unknown = found.filter((file) => !GATED.includes(file) && !(file in DELEGATES));
    assert.deepEqual(unknown, [], 'a new provider implementation: call admitModelCall() in it, or list it as a delegate with the reason');
  });
});
