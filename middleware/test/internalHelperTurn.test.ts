/**
 * #2050 — spec 2042 §6 criterion 28 (helper part): "a sub-agent helper runs on
 * a cheaper model within the agent's budget and is never named to the user".
 *
 * One scripted model drives a real `Orchestrator` turn. The agent runs on a
 * balanced model; its DB sub-agent "Strategist" (built by the production
 * factory `buildSubAgentDomainTools`) runs on a fast one. Checked:
 *
 *   - the helper's request goes to the cheaper model, with an output budget
 *     capped by the agent's own;
 *   - the helper's prompt makes it an internal helper and never gives it a name,
 *     the agent's tool description tells the agent to present the result as
 *     its own work;
 *   - the answer reaches the user without the helper's name, `agentsConsulted`
 *     is absent, and the trace still records the run, flagged as internal;
 *   - every usage row of the turn (agent AND helper) is booked on the agent's
 *     turn.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import type { Pool } from 'pg';

import {
  clearExternalModels,
  registerExternalModels,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamEvent,
  type ModelInfo,
} from '@omadia/llm-provider';
import {
  INTERNAL_HELPER_CONTRACT,
  NativeToolRegistry,
  Orchestrator,
  buildSubAgentDomainTools,
  turnContext,
  type ChatStreamEvent,
  type SkillRow,
  type SubAgentRow,
} from '@omadia/orchestrator';
import {
  flushUsageRecorder,
  initUsageRecorder,
  setUsageContextProvider,
} from '@omadia/usage-telemetry';
import { deriveAgentsConsulted } from '@omadia/channel-sdk';

const SONNET: ModelInfo = {
  id: 'anthropic:claude-sonnet-test',
  provider: 'anthropic',
  modelId: 'claude-sonnet-test',
  label: 'Sonnet (test)',
  class: 'balanced',
  maxTokens: 8192,
  contextWindow: 200000,
  vision: true,
  classDefault: true,
};
const HAIKU: ModelInfo = {
  id: 'anthropic:claude-haiku-test',
  provider: 'anthropic',
  modelId: 'claude-haiku-test',
  label: 'Haiku (test)',
  class: 'fast',
  maxTokens: 8192,
  contextWindow: 200000,
  vision: false,
  classDefault: true,
};

const CAPS = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

const USAGE = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };

function final(content: unknown[], model: string, finishReason: 'stop' | 'tool_calls'): LlmStreamEvent {
  return {
    type: 'final',
    response: {
      content,
      finishReason,
      providerFinishReason: finishReason === 'stop' ? 'end_turn' : 'tool_use',
      model,
      usage: USAGE,
    } as unknown as LlmResponse,
  } as LlmStreamEvent;
}

function systemText(req: LlmRequest): string {
  const sys = req.system;
  if (typeof sys === 'string') return sys;
  return (sys ?? []).map((b) => (b as { text?: string }).text ?? '').join('\n');
}

// The usage recorder is a process singleton and first-wins: one fake pool for
// the file, rows captured from the INSERT's parameters (14 per row).
const insertParams: unknown[][] = [];
initUsageRecorder({
  query: (_sql: string, params: readonly unknown[]) => {
    insertParams.push([...params]);
    return Promise.resolve({ rows: [] });
  },
} as unknown as Pool);
const COLS = 14;
const COL_MODEL = 1;
const COL_SESSION = 8;
const COL_TURN = 10;

before(() => {
  clearExternalModels();
  registerExternalModels([SONNET, HAIKU]);
  // What `@omadia/orchestrator`'s plugin registers in production.
  setUsageContextProvider(() => {
    const ctx = turnContext.current();
    return ctx && ctx.turnId !== '' && ctx.sessionScope !== undefined
      ? { turnId: ctx.turnId, sessionId: ctx.sessionScope }
      : undefined;
  });
});

after(() => {
  setUsageContextProvider(undefined);
  clearExternalModels();
});

test('a helper runs on a cheaper model within the agent budget and is never named to the user', async () => {
  const requests: LlmRequest[] = [];
  let agentCalls = 0;
  const provider = {
    id: 'anthropic',
    capabilities: CAPS,
    complete: async (): Promise<LlmResponse> => {
      throw new Error('complete() is not scripted');
    },
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      requests.push(req);
      let events: LlmStreamEvent[];
      if (req.model === HAIKU.modelId) {
        // The helper: answers its question plainly.
        events = [
          { type: 'text_delta', text: 'Risk 1: churn. Risk 2: cash.' } as LlmStreamEvent,
          final([{ type: 'text', text: 'Risk 1: churn. Risk 2: cash.' }], req.model, 'stop'),
        ];
      } else if (agentCalls++ === 0) {
        events = [
          final(
            [{ type: 'tool_call', id: 'u1', name: 'ask_strategist', input: { question: 'Top risks of plan A?' } }],
            req.model,
            'tool_calls',
          ),
        ];
      } else {
        events = [
          { type: 'text_delta', text: 'The two main risks of plan A are churn and cash.' } as LlmStreamEvent,
          final([{ type: 'text', text: 'The two main risks of plan A are churn and cash.' }], req.model, 'stop'),
        ];
      }
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of events) yield ev;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;

  const orch = new Orchestrator({
    provider,
    model: SONNET.modelId,
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
  });

  const strategist: SubAgentRow = {
    id: 'helper-1',
    parentAgentId: 'agent-1',
    name: 'Strategist',
    skillId: 'skill-1',
    model: HAIKU.id,
    maxTokens: 4096,
    maxIterations: 4,
    systemPromptOverride: null,
    status: 'enabled',
    position: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const skill: SkillRow = {
    id: 'skill-1',
    slug: 'strategy',
    name: 'Strategy',
    description: 'Strategy questions: risks, options, trade-offs.',
    body: 'You assess business plans.',
    frontmatter: {},
    source: 'db',
    sourcePath: null,
    contentHash: null,
    forkedFrom: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const [helper] = buildSubAgentDomainTools(
    { subAgents: [strategist], toolGrants: [], skills: [skill] },
    {
      provider,
      defaultModel: 'class:balanced',
      defaultMaxTokens: 16_000,
      defaultMaxIterations: 8,
      parentModelPolicy: {
        primary: { provider: 'anthropic', model: SONNET.modelId },
        fallback: 'none',
      },
      parentBudget: orch.turnBudget(),
    },
  );
  assert.ok(helper, 'the helper must be built');
  orch.registerDomainTool(helper);

  let done: Extract<ChatStreamEvent, { type: 'done' }> | undefined;
  for await (const ev of orch.chatStream({
    userMessage: 'What are the risks of plan A?',
    sessionScope: 'helper-session',
  })) {
    if (ev.type === 'done') done = ev;
  }
  assert.ok(done, 'the turn must finish');

  // ── the helper ran on the cheaper model, within the agent's budget ──────
  const helperReqs = requests.filter((r) => r.model === HAIKU.modelId);
  const agentReqs = requests.filter((r) => r.model === SONNET.modelId);
  assert.equal(helperReqs.length, 1, 'one helper call');
  assert.equal(agentReqs.length, 2, 'two agent calls');
  assert.equal(helperReqs[0]!.maxTokens, 1024, 'the helper output budget is capped by the agent');

  // ── never named: the helper is an internal helper, not a persona ─────────
  const helperSystem = systemText(helperReqs[0]!);
  assert.ok(helperSystem.includes(INTERNAL_HELPER_CONTRACT));
  assert.doesNotMatch(helperSystem, /Strategist/);
  const askTool = agentReqs[0]!.tools?.find((t) => t.name === 'ask_strategist');
  assert.ok(askTool, 'the agent is offered the helper tool');
  assert.doesNotMatch(askTool.description ?? '', /Strategist/);
  assert.match(askTool.description ?? '', /without naming, quoting or crediting the helper/);

  // ── what reaches the user ────────────────────────────────────────────────
  assert.match(done.answer, /churn and cash/);
  assert.doesNotMatch(done.answer, /Strategist/i);
  assert.equal(done.agentsConsulted, undefined, 'a helper is never a consulted agent');
  const invocations = done.runTrace?.agentInvocations ?? [];
  assert.equal(invocations.length, 1, 'the trace records the helper run');
  assert.equal(invocations[0]!.internalHelper, true);

  // ── usage: every row of the turn, helper included, on the agent's turn ──
  await flushUsageRecorder();
  const rows = insertParams.flatMap((params) =>
    Array.from({ length: params.length / COLS }, (_v, i) => params.slice(i * COLS, (i + 1) * COLS)),
  );
  const helperRows = rows.filter((r) => r[COL_MODEL] === HAIKU.modelId);
  const agentRows = rows.filter((r) => r[COL_MODEL] === SONNET.modelId);
  assert.equal(helperRows.length, 1, 'the helper call is in the ledger');
  assert.ok(agentRows.length >= 2, 'the agent calls are in the ledger');
  const turnIds = new Set([...helperRows, ...agentRows].map((r) => r[COL_TURN]));
  assert.equal(turnIds.size, 1, 'helper and agent usage share one turn');
  assert.ok(typeof [...turnIds][0] === 'string' && [...turnIds][0] !== '', 'booked on a real turn id');
  assert.ok(helperRows.every((r) => r[COL_SESSION] === 'helper-session'));
});

test('agentsConsulted never lists an internal helper, only other agents', () => {
  const inv = (agentName: string, internalHelper?: true) => ({
    index: 0,
    agentName,
    durationMs: 1,
    subIterations: 1,
    status: 'success' as const,
    toolCalls: [],
    ...(internalHelper ? { internalHelper } : {}),
  });
  assert.equal(deriveAgentsConsulted({ agentInvocations: [inv('ask_strategist', true)] }), undefined);
  const mixed = deriveAgentsConsulted({
    agentInvocations: [inv('ask_strategist', true), inv('query_accounting')],
  });
  assert.deepEqual(
    mixed?.map((c) => c.label),
    ['Accounting'],
  );
});
