import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import {
  NativeToolRegistry,
  Orchestrator,
  createDomainTool,
  parseDirectLineDirective,
  resolveDirectLineTarget,
  directLineLabel,
  type ChatStreamEvent,
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
    // all-whitespace remainder collapses to empty too
    assert.equal(parseDirectLineDirective('#strategist   ')?.payload, '');
  });

  it('keeps internal/trailing whitespace verbatim — only the separator is stripped', () => {
    const d = parseDirectLineDirective('#strategist  line1\n\n  indented\n');
    assert.equal(d?.token, 'strategist');
    assert.equal(d?.payload, 'line1\n\n  indented\n');
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

  it('#332 gap-closure — carries agentId through the projection when the run-trace resolved one', () => {
    const r: ChatTurnResult = {
      ...base,
      runTrace: {
        scope: 's',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        durationMs: 100,
        status: 'success',
        iterations: 1,
        orchestratorToolCalls: [],
        agentInvocations: [
          {
            index: 0,
            agentName: 'ask_strategist',
            agentId: 'de.byte5.agent.strategist',
            durationMs: 50,
            subIterations: 1,
            status: 'success',
            toolCalls: [],
          },
        ],
      },
    };
    const sa = toSemanticAnswer(r);
    assert.equal(sa.agentsConsulted?.[0]?.agentId, 'de.byte5.agent.strategist');
  });

  it('#332 gap-closure — two agents sharing a display label still resolve to distinct agentIds', () => {
    // Both tool names humanize to the SAME label ("Strategist") — the bug
    // this closes: before agentId was threaded through, these were
    // indistinguishable in the projection.
    const r: ChatTurnResult = {
      ...base,
      runTrace: {
        scope: 's',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        durationMs: 100,
        status: 'success',
        iterations: 1,
        orchestratorToolCalls: [],
        agentInvocations: [
          {
            index: 0,
            agentName: 'ask_strategist',
            agentId: 'de.byte5.agent.strategist',
            durationMs: 50,
            subIterations: 1,
            status: 'success',
            toolCalls: [],
          },
          {
            index: 1,
            agentName: 'consult_strategist',
            agentId: 'com.other.agent.strategist',
            durationMs: 40,
            subIterations: 1,
            status: 'success',
            toolCalls: [],
          },
        ],
      },
    };
    const sa = toSemanticAnswer(r);
    assert.equal(sa.agentsConsulted?.length, 2);
    assert.equal(sa.agentsConsulted?.[0]?.label, 'Strategist');
    assert.equal(sa.agentsConsulted?.[1]?.label, 'Strategist');
    assert.equal(sa.agentsConsulted?.[0]?.agentId, 'de.byte5.agent.strategist');
    assert.equal(sa.agentsConsulted?.[1]?.agentId, 'com.other.agent.strategist');
    assert.notEqual(
      sa.agentsConsulted?.[0]?.agentId,
      sa.agentsConsulted?.[1]?.agentId,
    );
  });

  it('#332 gap-closure — agentId is absent from the plain-text footer fallback (internal id stays internal)', () => {
    const r: ChatTurnResult = {
      ...base,
      runTrace: {
        scope: 's',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        durationMs: 100,
        status: 'success',
        iterations: 1,
        orchestratorToolCalls: [],
        agentInvocations: [
          {
            index: 0,
            agentName: 'ask_strategist',
            agentId: 'de.byte5.agent.strategist',
            durationMs: 50,
            subIterations: 1,
            status: 'success',
            toolCalls: [],
          },
        ],
      },
    };
    const sa = toSemanticAnswer(r);
    const footer = agentsConsultedFooterText(sa);
    assert.ok(footer);
    assert.doesNotMatch(footer ?? '', /de\.byte5\.agent\.strategist/);
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

// Minimal privacy-guard service stub. #332 gap-closure: direct-line now
// routes through the same `dispatchTool` choke point as every other
// domain-tool dispatch, so `internToolResultV4` IS exercised here — the
// digest it returns is what a masked delegated answer looks like. The
// digest text is deterministic-but-distinguishable from the raw input so
// tests can assert masking actually happened (not just pass through).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakePrivacyGuard = (): any => () =>
  ({
    internToolResultV4: async (input: {
      toolName: string;
      rawResult: string;
    }) => ({
      digestText: `[masked:${input.toolName}:${input.rawResult.length}]`,
      datasetId: 'ds-test-1',
    }),
    subAgentResultV4: async (i: { narration: string }) => ({
      resultText: i.narration,
    }),
    takeRenderedAnswerV4: async () => undefined,
    finalizeTurn: async () => undefined,
  }) as any;

describe('#332 Layer 2 — guarded-additive mode', () => {
  it('appends an attributed note but keeps the verbatim block byte-for-byte (no-redaction)', async () => {
    const tool = strategistTool(async () => 'VERBATIM-X');
    // provider.complete is called once, for the note generation.
    const { provider } = scriptedCompleteProvider([
      textResponse('cross-domain caveat'),
    ]);
    const orch = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [tool],
      nativeToolRegistry: new NativeToolRegistry(),
      directLineMode: 'guarded',
    });
    const sa = await orch.chat({ userMessage: '#strategist plan?', sessionScope: 'g1' });
    assert.equal(sa.delegatedAnswer?.text, 'VERBATIM-X'); // intact, independent
    assert.match(sa.text, /VERBATIM-X/);
    assert.match(sa.text, /▸ omadia note: cross-domain caveat/);
  });

  it('degrades to strict (no note LLM call) when a privacy guard is active — no PII to the provider', async () => {
    const tool = strategistTool(async () => 'VERBATIM-Y');
    const orch = new Orchestrator({
      provider: neverCalledProvider(), // throws if the note LLM is invoked
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [tool],
      nativeToolRegistry: new NativeToolRegistry(),
      directLineMode: 'guarded',
      privacyGuard: fakePrivacyGuard(),
    });
    const sa = await orch.chat({ userMessage: '#strategist plan?', sessionScope: 'g2' });
    // #332 gap-closure: the verbatim answer is now routed through the same
    // masking cascade as every other domain-tool dispatch — the raw
    // 'VERBATIM-Y' must NOT reach the user when a privacy guard is active.
    assert.equal(sa.delegatedAnswer?.text, '[masked:ask_strategist:10]');
    assert.equal(sa.text, '[masked:ask_strategist:10]'); // no note appended → no provider call
  });
});

describe('#332 gap-closure — Direct Line answers are actually PII-masked', () => {
  it('a verbatim answer is interned (masked) when a privacy guard is active (strict mode)', async () => {
    const tool = strategistTool(
      async () => 'contact jane.doe@example.com for details',
    );
    const orch = new Orchestrator({
      provider: neverCalledProvider(),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [tool],
      nativeToolRegistry: new NativeToolRegistry(),
      privacyGuard: fakePrivacyGuard(), // strict is the default directLineMode
    });
    const sa = await orch.chat({ userMessage: '#strategist plan?', sessionScope: 'pii1' });
    assert.ok(sa.delegatedAnswer);
    assert.doesNotMatch(sa.delegatedAnswer?.text ?? '', /jane\.doe@example\.com/);
    assert.match(sa.delegatedAnswer?.text ?? '', /^\[masked:ask_strategist:/);
    assert.doesNotMatch(sa.text, /jane\.doe@example\.com/);
  });

  it('the raw verbatim text passes through unmasked when NO privacy guard is configured (documented contract)', async () => {
    const tool = strategistTool(
      async () => 'contact jane.doe@example.com for details',
    );
    const orch = new Orchestrator({
      provider: neverCalledProvider(),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [tool],
      nativeToolRegistry: new NativeToolRegistry(),
      // no privacyGuard configured — matches production hosts that never
      // registered a `privacy.redact@1` provider.
    });
    const sa = await orch.chat({ userMessage: '#strategist plan?', sessionScope: 'pii2' });
    assert.equal(
      sa.delegatedAnswer?.text,
      'contact jane.doe@example.com for details',
    );
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

describe('#332 gap-closure — standing requiredConsultToolName (L3 real producer)', () => {
  it('forces the consult from a standing orchestrator-level obligation, with no per-turn expectedDomainTool', async () => {
    const captured: { q?: string } = {};
    const tool = strategistTool(async () => 'STANDING-CONSULTED', captured);
    const { provider, calls } = scriptedCompleteProvider([
      textResponse('ignoring the specialist'),
      toolResponse('ask_strategist', { question: 'standing-forced question' }),
      textResponse('final synthesis'),
    ]);
    const orch = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 6,
      domainTools: [tool],
      nativeToolRegistry: new NativeToolRegistry(),
      requiredConsultToolName: 'ask_strategist',
    });
    const sa = await orch.chat({
      userMessage: 'run the strategy process',
      sessionScope: 's6',
      // no expectedDomainTool — the STANDING config must be what forces it
    });
    assert.equal(captured.q, 'standing-forced question');
    assert.ok(calls() >= 2, 'the harness escalated at least once');
    assert.ok(sa.text.length > 0);
  });

  it('a standing obligation for an unknown tool name is ignored (isolation — never forces a non-whitelisted tool)', async () => {
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
      requiredConsultToolName: 'ask_nonexistent',
    });
    const sa = await orch.chat({ userMessage: 'hello', sessionScope: 's7' });
    assert.equal(asked, false);
    assert.equal(sa.text, 'plain answer');
  });

  it('a per-turn expectedDomainTool overrides the standing requiredConsultToolName', async () => {
    const captured: { strategist?: string; twin?: string } = {};
    const strategist = strategistTool(async (q) => {
      captured.strategist = q;
      return 'S';
    });
    const twin = createDomainTool({
      name: 'ask_twin',
      description: 'twin',
      domain: 'x',
      agentId: 'com.other.agent.twin',
      agent: {
        ask: async (q: string) => {
          captured.twin = q;
          return 'T';
        },
      },
    });
    const { provider, calls } = scriptedCompleteProvider([
      textResponse('ignoring both specialists'),
      toolResponse('ask_twin', { question: 'per-turn wins' }),
      textResponse('final synthesis'),
    ]);
    const orch = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 6,
      domainTools: [strategist, twin],
      nativeToolRegistry: new NativeToolRegistry(),
      requiredConsultToolName: 'ask_strategist', // standing default
    });
    const sa = await orch.chat({
      userMessage: 'run the process',
      sessionScope: 's8',
      expectedDomainTool: 'ask_twin', // per-turn override
    });
    assert.equal(captured.twin, 'per-turn wins', 'the per-turn obligation must win');
    assert.equal(captured.strategist, undefined, 'the standing default must not also fire');
    assert.ok(calls() >= 2);
    assert.ok(sa.text.length > 0);
  });
});

describe('#332 gap-closure — agentsConsulted on the STREAMING done event (web-ui path)', () => {
  it('a Direct Line streamed turn carries agentsConsulted on its done event', async () => {
    const tool = strategistTool(async () => 'STREAMED-VERBATIM');
    const orch = new Orchestrator({
      provider: neverCalledProvider(),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [tool],
      nativeToolRegistry: new NativeToolRegistry(),
    });
    let doneEvent: Extract<ChatStreamEvent, { type: 'done' }> | undefined;
    for await (const event of orch.chatStream({
      userMessage: '#strategist plan?',
      sessionScope: 'stream1',
    })) {
      if (event.type === 'done') doneEvent = event;
    }
    assert.ok(doneEvent, 'a done event must be yielded');
    assert.equal(doneEvent?.delegatedAnswer?.text, 'STREAMED-VERBATIM');
    assert.equal(doneEvent?.agentsConsulted?.length, 1);
    assert.equal(doneEvent?.agentsConsulted?.[0]?.label, 'Strategist');
    assert.equal(
      doneEvent?.agentsConsulted?.[0]?.agentId,
      'de.byte5.agent.strategist',
    );
  });

  it('an ordinary orchestrator-driven streamed turn carries agentsConsulted on its done event', async () => {
    const tool = strategistTool(async () => 'ORDINARY-STREAMED');
    // `chatStream` drives the LLM via `provider.stream()` (an SSE-shaped
    // event protocol), NOT `provider.complete()` — mirrors the pattern in
    // parallelTool.test.ts. Two scripted calls: 1st yields a tool_use, 2nd
    // yields the final text.
    let callIdx = 0;
    const streams: LlmStreamEvent[][] = [
      [
        { type: 'tool_use_start' },
        { type: 'tool_input_delta', text: JSON.stringify({ question: 'what now?' }) },
        {
          type: 'final',
          response: {
            content: [
              { type: 'tool_call', id: 'u1', name: 'ask_strategist', input: { question: 'what now?' } },
            ],
            finishReason: 'tool_calls',
            providerFinishReason: 'tool_use',
            model: 'test',
            usage,
          } as unknown as LlmResponse,
        },
      ],
      [
        { type: 'text_delta', text: 'final synthesis' },
        {
          type: 'final',
          response: textResponse('final synthesis'),
        },
      ],
    ];
    const provider = {
      id: 'anthropic',
      capabilities: providerCapabilities,
      complete: async (): Promise<LlmResponse> => {
        throw new Error('complete() not scripted for this streaming test');
      },
      stream: (_req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
        const events = streams[callIdx] ?? [];
        callIdx += 1;
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
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [tool],
      nativeToolRegistry: new NativeToolRegistry(),
    });
    let sawAgentsConsulted = false;
    for await (const event of orch.chatStream({
      userMessage: 'consult the strategist',
      sessionScope: 'stream2',
    })) {
      if (event.type === 'done') {
        sawAgentsConsulted =
          (event.agentsConsulted?.length ?? 0) === 1 &&
          event.agentsConsulted?.[0]?.label === 'Strategist';
      }
    }
    assert.ok(sawAgentsConsulted, 'the done event must carry agentsConsulted');
  });
});
