import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { LlmProvider, LlmResponse } from '@omadia/llm-provider';
import {
  NativeToolRegistry,
  Orchestrator,
  createDomainTool,
  parseDirectLineDirective,
  resolveDirectLineTarget,
  directLineLabel,
  type DirectLineCandidate,
} from '@omadia/orchestrator';
import {
  toSemanticAnswer,
  agentsConsultedFooterText,
  type ChatTurnResult,
} from '@omadia/channel-sdk';

// ── #332 Layer 2 — pure parser / resolver ────────────────────────────────────

describe('#332 parseDirectLineDirective', () => {
  it('parses a leading #token and the verbatim payload', () => {
    const d = parseDirectLineDirective('#strategist  What are 3 risks in plan A?');
    assert.deepEqual(d, {
      token: 'strategist',
      payload: 'What are 3 risks in plan A?',
    });
  });

  it('returns undefined when there is no leading directive', () => {
    assert.equal(parseDirectLineDirective('just a normal question'), undefined);
    // A `#` that is NOT the first token is ordinary text (collision rule).
    assert.equal(parseDirectLineDirective('tell me about #strategist'), undefined);
  });

  it('survives Teams whitespace-collapse (single leading token)', () => {
    // extractUserMessage collapses \s+ → single space; the directive still parses.
    const d = parseDirectLineDirective('#Strategist risks?');
    assert.equal(d?.token, 'strategist');
    assert.equal(d?.payload, 'risks?');
  });

  it('reports an empty payload when the specialist is named with no question', () => {
    const d = parseDirectLineDirective('#strategist');
    assert.deepEqual(d, { token: 'strategist', payload: '' });
  });
});

describe('#332 resolveDirectLineTarget', () => {
  const candidates: DirectLineCandidate[] = [
    {
      toolName: 'ask_strategist',
      agentId: 'de.byte5.agent.strategist',
      label: 'Strategist',
    },
    { toolName: 'query_accounting', agentId: '@omadia/agent-accounting', label: 'Accounting' },
  ];

  it('resolves by label / agentId / tool name (verb-stripped)', () => {
    assert.equal(
      resolveDirectLineTarget('strategist', candidates).kind,
      'resolved',
    );
    assert.equal(
      resolveDirectLineTarget('accounting', candidates).kind,
      'resolved',
    );
  });

  it('returns unknown for a name no whitelisted agent matches', () => {
    assert.deepEqual(resolveDirectLineTarget('nobody', candidates), {
      kind: 'unknown',
    });
  });

  it('never silently routes — duplicate labels are ambiguous', () => {
    const dup: DirectLineCandidate[] = [
      { toolName: 'a', label: 'Twin' },
      { toolName: 'b', label: 'Twin' },
    ];
    const r = resolveDirectLineTarget('twin', dup);
    assert.equal(r.kind, 'ambiguous');
  });
});

describe('#332 directLineLabel', () => {
  it('humanizes agent ids and verb-prefixed tool names', () => {
    assert.equal(directLineLabel('de.byte5.agent.strategist'), 'Strategist');
    assert.equal(directLineLabel('@omadia/agent-seo-analyst'), 'Seo Analyst');
    assert.equal(directLineLabel('ask_strategist'), 'Strategist');
  });
});

// ── #332 Layer 1 — projection + plain-text fallback ──────────────────────────

describe('#332 toSemanticAnswer agentsConsulted projection', () => {
  const base: ChatTurnResult = { answer: 'hi', toolCalls: 0, iterations: 0 };

  it('projects runTrace.agentInvocations into a curated footer field', () => {
    const r: ChatTurnResult = {
      ...base,
      runTrace: {
        scope: 's',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        durationMs: 1000,
        status: 'success',
        iterations: 1,
        orchestratorToolCalls: [],
        agentInvocations: [
          {
            index: 0,
            agentName: 'ask_strategist',
            durationMs: 950,
            subIterations: 2,
            status: 'success',
            toolCalls: [
              {
                callId: 'c1',
                toolName: 'x',
                durationMs: 5,
                isError: false,
                agentContext: 'ask_strategist',
              },
            ],
          },
        ],
      },
    };
    const sa = toSemanticAnswer(r);
    assert.equal(sa.agentsConsulted?.length, 1);
    assert.equal(sa.agentsConsulted?.[0]?.label, 'Strategist');
    assert.equal(sa.agentsConsulted?.[0]?.status, 'success');
    assert.equal(sa.agentsConsulted?.[0]?.toolCalls, 1);
    assert.equal(
      agentsConsultedFooterText(sa),
      '🔎 Consulted: Strategist ✓ · 1 step',
    );
  });

  it('omits agentsConsulted (and footer) when no sub-agent ran — fabricated claims show nothing', () => {
    const sa = toSemanticAnswer(base);
    assert.equal(sa.agentsConsulted, undefined);
    assert.equal(agentsConsultedFooterText(sa), undefined);
  });
});

// ── #332 Layer 2 / 3 — integration via Orchestrator.chat() (Teams path) ───────

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

/** Provider whose every call throws — proves the LLM never ran (strict mode). */
function neverCalledProvider(): LlmProvider {
  const p = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (): Promise<LlmResponse> => {
      throw new Error('LLM must not be called on a strict direct-line turn');
    },
    stream: () => {
      throw new Error('LLM must not be called on a strict direct-line turn');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return p as unknown as LlmProvider;
}

const usage = {
  inputTokens: 10,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const textResponse = (text: string): LlmResponse =>
  ({
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage,
  }) as unknown as LlmResponse;
const toolResponse = (name: string, input: unknown): LlmResponse =>
  ({
    content: [{ type: 'tool_call', id: `use-${name}`, name, input }],
    finishReason: 'tool_calls',
    providerFinishReason: 'tool_use',
    model: 'test',
    usage,
  }) as unknown as LlmResponse;

/** Provider that returns a scripted sequence of `complete()` responses. */
function scriptedCompleteProvider(seq: LlmResponse[]): {
  provider: LlmProvider;
  calls: () => number;
} {
  let i = 0;
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (): Promise<LlmResponse> => {
      const r = seq[i] ?? textResponse('done');
      i += 1;
      return r;
    },
    stream: () => {
      throw new Error('not scripted for stream');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return { provider: provider as unknown as LlmProvider, calls: () => i };
}

function strategistTool(
  impl: (question: string) => Promise<string>,
  captured?: { q?: string },
) {
  return createDomainTool({
    name: 'ask_strategist',
    description: 'Strategy sparring partner',
    domain: 'strategy',
    agentId: 'de.byte5.agent.strategist',
    agent: {
      ask: async (question: string): Promise<string> => {
        if (captured) captured.q = question;
        return impl(question);
      },
    },
  });
}

describe('#332 Layer 2 — Direct Line (strict passthrough, non-streaming/Teams)', () => {
  it('delivers the verbatim answer attributed, with the LLM never called, input bound verbatim', async () => {
    const captured: { q?: string } = {};
    const tool = strategistTool(async () => 'VERBATIM-STRATEGIST-ANSWER', captured);
    const orch = new Orchestrator({
      provider: neverCalledProvider(),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [tool],
      nativeToolRegistry: new NativeToolRegistry(),
    });

    const sa = await orch.chat({
      userMessage: '#strategist What are three risks in plan A?',
      sessionScope: 's1',
    });

    assert.equal(captured.q, 'What are three risks in plan A?'); // verbatim input
    assert.ok(sa.delegatedAnswer, 'delegatedAnswer must be present');
    assert.equal(sa.delegatedAnswer?.label, 'Strategist');
    assert.equal(sa.delegatedAnswer?.status, 'success');
    assert.equal(sa.delegatedAnswer?.text, 'VERBATIM-STRATEGIST-ANSWER');
    assert.equal(sa.text, 'VERBATIM-STRATEGIST-ANSWER'); // graceful degrade
    assert.equal(sa.agentsConsulted?.[0]?.label, 'Strategist'); // L1 footer
  });

  it('an UNKNOWN token falls through to the normal LLM turn — ordinary `#…` messages are not hijacked', async () => {
    let asked = false;
    const tool = strategistTool(async () => {
      asked = true;
      return 'should not run';
    });
    // The LLM IS allowed to run here (this is a normal turn that merely starts
    // with `#`). It must not be short-circuited into a "no such agent" reply.
    const { provider } = scriptedCompleteProvider([
      textResponse('normal LLM answer'),
    ]);
    const orch = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [tool],
      nativeToolRegistry: new NativeToolRegistry(),
    });
    const sa = await orch.chat({ userMessage: '#urgent server is down', sessionScope: 's2' });
    assert.equal(asked, false, 'no sub-agent may run for an unknown token');
    assert.equal(sa.delegatedAnswer, undefined);
    assert.equal(sa.text, 'normal LLM answer'); // handled by the LLM, not hijacked
  });

  it('an AMBIGUOUS token disambiguates, never a silent wrong route', async () => {
    const a = createDomainTool({
      name: 'ask_twin_a',
      description: 'twin a',
      domain: 'x',
      agentId: 'de.byte5.agent.twin',
      agent: { ask: async () => 'A' },
    });
    const b = createDomainTool({
      name: 'ask_twin_b',
      description: 'twin b',
      domain: 'y',
      agentId: 'com.other.agent.twin',
      agent: { ask: async () => 'B' },
    });
    const orch = new Orchestrator({
      provider: neverCalledProvider(),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [a, b],
      nativeToolRegistry: new NativeToolRegistry(),
    });
    const sa = await orch.chat({ userMessage: '#twin go', sessionScope: 's2b' });
    assert.equal(sa.delegatedAnswer, undefined);
    assert.match(sa.text, /ambiguous/i);
  });

  it('delivers a sub-agent failure faithfully (no cover-up)', async () => {
    const tool = strategistTool(async () => {
      throw new Error('upstream 503');
    });
    const orch = new Orchestrator({
      provider: neverCalledProvider(),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [tool],
      nativeToolRegistry: new NativeToolRegistry(),
    });
    const sa = await orch.chat({ userMessage: '#strategist plan?', sessionScope: 's3' });
    assert.equal(sa.delegatedAnswer?.status, 'error');
    assert.match(sa.delegatedAnswer?.text ?? '', /Error|could not respond|503/i);
  });

  it('persists the verbatim exchange via the session logger (awareness / continuity)', async () => {
    const logged: Array<{ scope: string; assistantAnswer: string }> = [];
    const fakeLogger = {
      log: async (entry: { scope: string; assistantAnswer: string }) => {
        logged.push(entry);
        return { turnExternalId: 'turn:test:1' };
      },
    };
    const tool = strategistTool(async () => 'VERBATIM-LOGGED');
    const orch = new Orchestrator({
      provider: neverCalledProvider(),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [tool],
      nativeToolRegistry: new NativeToolRegistry(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionLogger: fakeLogger as any,
    });
    await orch.chat({ userMessage: '#strategist plan?', sessionScope: 'sLog' });
    assert.equal(logged.length, 1, 'the direct-line turn must be persisted');
    assert.equal(logged[0]?.scope, 'sLog');
    assert.equal(logged[0]?.assistantAnswer, 'VERBATIM-LOGGED');
  });
});

describe('#332 Layer 3 — forced-delegation obligation (non-streaming)', () => {
  it('forces a consult when the model would end the turn without it', async () => {
    const captured: { q?: string } = {};
    const tool = strategistTool(async () => 'STRATEGIST-CONSULTED', captured);
    // 1st model turn: pure text (skips the consult). After the forced
    // escalation: the model calls the obligation tool. Then a final text.
    const { provider, calls } = scriptedCompleteProvider([
      textResponse('Here is my own take, ignoring the specialist.'),
      toolResponse('ask_strategist', { question: 'forced question' }),
      textResponse('Final synthesis.'),
    ]);
    const orch = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 6,
      domainTools: [tool],
      nativeToolRegistry: new NativeToolRegistry(),
    });
    const sa = await orch.chat({
      userMessage: 'run the strategy process',
      sessionScope: 's4',
      expectedDomainTool: 'ask_strategist',
    });
    assert.equal(captured.q, 'forced question', 'obligation tool must have run');
    assert.ok(calls() >= 2, 'the harness escalated at least once');
    assert.ok(sa.text.length > 0);
  });

  it('does not force anything on an ordinary turn (no obligation set)', async () => {
    let asked = false;
    const tool = strategistTool(async () => {
      asked = true;
      return 'x';
    });
    const { provider } = scriptedCompleteProvider([textResponse('plain answer')]);
    const orch = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 6,
      domainTools: [tool],
      nativeToolRegistry: new NativeToolRegistry(),
    });
    const sa = await orch.chat({ userMessage: 'hello', sessionScope: 's5' });
    assert.equal(asked, false);
    assert.equal(sa.text, 'plain answer');
  });
});
