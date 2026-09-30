/**
 * Orchestrator side of the verifier's privacy hand-over, against the REAL
 * Orchestrator and the REAL privacy-guard service (prompt masking on):
 *
 *   - a held turn returns without a receipt, keeps its privacy state alive
 *     and hands a continuation over; `finalize()` then finalizes and persists
 *     exactly once, with the model attribution captured at hand-over;
 *   - an unheld turn behaves exactly as before;
 *   - the continuation's view is the turn's WIRE view (pre-restore answer,
 *     masked prompt) — never a real value;
 *   - a caller-supplied system hint (the verifier's correction) reaches the
 *     model only masked, and a blocked mask refuses the turn;
 *   - a thrown or abandoned turn drops its privacy state;
 *   - the streaming paths (model turn, Direct Line) hand over the same way;
 *   - the subscription-CLI runtime is never wrapped by the verifier.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  createAnthropicClient,
  createAnthropicProvider,
} from '@omadia/llm-adapter-anthropic';
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import {
  NativeToolRegistry,
  Orchestrator,
  VerifierService as BuiltVerifierService,
  createDomainTool,
  type ChatStreamEvent,
  type ChatTurnInput,
} from '@omadia/orchestrator';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type {
  EntityRefBus,
  KnowledgeGraph,
  MemoryStore,
  PrivacyGuardService,
  TurnReceiptRecordInput,
} from '@omadia/plugin-api';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import { findIdentityLeaks } from '@omadia/plugin-privacy-guard/dist/v4/onTheWire.js';
import {
  ClaimExtractor,
  DeterministicChecker,
  EvidenceJudge,
  VerifierPipeline,
  type EvidenceSnippet,
} from '@omadia/verifier';

import {
  buildOrchestratorForAgent,
  type OrchestratorDeps,
} from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry as NativeToolRegistryType } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { VerifierService } from '../packages/harness-orchestrator/src/verifierService.js';

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

// Synthetic identity; no trailing period right after it (word-boundary
// extension would fold the period into the masked value).
const RAW_EMAIL = 'jana.beispiel@firma.example';
const SURROGATE_EMAIL = /[a-z]+\.[a-z]+@example\.net/;

function countingService(maskUserPrompt = true): {
  service: PrivacyGuardService;
  finalizeCalls: () => number;
} {
  const inner = createPrivacyGuardService({
    readConfig: (key: string) =>
      key === 'mask_user_prompt' && maskUserPrompt ? 'on' : undefined,
  });
  let calls = 0;
  const service: PrivacyGuardService = {
    ...inner,
    finalizeTurn: async (turnId, turnInput) => {
      calls += 1;
      return inner.finalizeTurn(turnId, turnInput);
    },
  };
  return { service, finalizeCalls: () => calls };
}

function textResponse(text: string): LlmResponse {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

/** Answers by echoing the e-mail it finds in its own request — i.e. the
 *  surrogate, when the orchestrator masked the prompt. Records requests. */
function echoingProvider(requests: string[]): LlmProvider {
  const answerFor = (req: LlmRequest): string => {
    const serialized = JSON.stringify(req);
    requests.push(serialized);
    const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(serialized)?.[0];
    return `Notiert, ich schreibe an ${email ?? 'niemanden'} heute`;
  };
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (req: LlmRequest): Promise<LlmResponse> => textResponse(answerFor(req)),
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      const text = answerFor(req);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text_delta', text } as LlmStreamEvent;
          yield { type: 'final', response: textResponse(text) } as LlmStreamEvent;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return provider as unknown as LlmProvider;
}

type OrchestratorOptions = ConstructorParameters<typeof Orchestrator>[0];

const sessionLogger = {
  log: async (): Promise<{ turnExternalId: string }> => ({ turnExternalId: 'turn:s:t1' }),
} as unknown as OrchestratorOptions['sessionLogger'];

function buildOrch(opts: {
  readonly service: PrivacyGuardService;
  readonly provider: LlmProvider;
  readonly recorded?: TurnReceiptRecordInput[];
  readonly domainTools?: OrchestratorOptions['domainTools'];
}): Orchestrator {
  return new Orchestrator({
    provider: opts.provider,
    model: 'test-model',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: opts.domainTools ?? [],
    nativeToolRegistry: new NativeToolRegistry(),
    sessionLogger,
    privacyGuard: () => opts.service,
    turnReceiptStore: () => ({
      record: async (entry: TurnReceiptRecordInput) => {
        opts.recorded?.push(entry);
      },
    }),
  });
}

describe('orchestrator — privacy hand-over for the verifier (runTurn)', () => {
  it('a held turn keeps its privacy state until the continuation finalizes it, then persists once', async () => {
    const { service, finalizeCalls } = countingService();
    const recorded: TurnReceiptRecordInput[] = [];
    const orch = buildOrch({ service, provider: echoingProvider([]), recorded });
    const input: ChatTurnInput = {
      userMessage: `Bitte schreibe an ${RAW_EMAIL} heute`,
      sessionScope: 'sess-held',
      userId: 'u1',
      channelIdentity: { channelKind: 'teams', channelUserId: 'aad-1' },
    };

    orch.markPrivacyFinalizeHeld(input);
    const result = await orch.runTurn(input);

    assert.equal(result.privacyReceipt, undefined, 'a held turn must not attach a receipt');
    assert.equal(finalizeCalls(), 0, 'finalizeTurn ran before the verifier');
    assert.equal(recorded.length, 0);
    assert.ok(result.answer.includes(RAW_EMAIL), 'the user still gets the restored answer');

    const egress = orch.takePrivacyEgress(input);
    assert.ok(egress, 'no continuation was handed over');
    assert.equal(orch.takePrivacyEgress(input), undefined, 'a continuation is taken once');
    const view = egress.verifierPrivacy;
    assert.ok(view);
    // The verifier's view is the WIRE view: the model's own answer (surrogate)
    // and the prompt as the turn masked it.
    assert.deepEqual(findIdentityLeaks(view.wireAnswer, [RAW_EMAIL]), []);
    assert.match(view.wireAnswer, SURROGATE_EMAIL);
    const wireUser = await view.maskForWire(input.userMessage);
    assert.deepEqual(findIdentityLeaks(wireUser, [RAW_EMAIL]), []);
    assert.equal(await view.restore(view.wireAnswer), result.answer);

    const receipt = await egress.finalize();
    assert.equal(finalizeCalls(), 1);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.turnId, egress.receiptId);
    assert.deepEqual(recorded[0]!.receipt, receipt);
    // Attribution captured at hand-over survives the deferred persist.
    assert.equal(recorded[0]!.model, 'test-model');
    // Turn spans and verifier requests are booked apart.
    assert.ok((receipt?.maskedPromptSpans ?? []).some((s) => s.type === 'email'));
    assert.equal(receipt?.verifierEgress?.requests, 1);

    // Idempotent: a second finalize neither re-finalizes nor re-persists.
    assert.deepEqual(await egress.finalize(), receipt);
    assert.equal(finalizeCalls(), 1);
    assert.equal(recorded.length, 1);
  });

  it('an unheld turn finalizes itself exactly as before', async () => {
    const { service, finalizeCalls } = countingService();
    const recorded: TurnReceiptRecordInput[] = [];
    const orch = buildOrch({ service, provider: echoingProvider([]), recorded });
    const input = { userMessage: `Bitte schreibe an ${RAW_EMAIL} heute`, sessionScope: 'sess-plain' };

    const result = await orch.runTurn(input);

    assert.ok(result.privacyReceipt);
    assert.equal(finalizeCalls(), 1);
    assert.equal(recorded.length, 1);
    assert.equal(orch.takePrivacyEgress(input), undefined);
    assert.equal(result.privacyReceipt.verifierEgress, undefined);
  });

  it('the hold is one-shot: a later run with the same object finalizes itself', async () => {
    const { service, finalizeCalls } = countingService();
    const orch = buildOrch({ service, provider: echoingProvider([]) });
    const input = { userMessage: `Bitte schreibe an ${RAW_EMAIL} heute`, sessionScope: 'sess-once' };

    orch.markPrivacyFinalizeHeld(input);
    await orch.runTurn(input);
    const egress = orch.takePrivacyEgress(input);
    await egress?.finalize();
    const again = await orch.runTurn(input);

    assert.ok(again.privacyReceipt, 'the second run was still held');
    assert.equal(finalizeCalls(), 2);
  });

  it('a correction hint reaches the model only as surrogates', async () => {
    const { service } = countingService();
    const requests: string[] = [];
    const orch = buildOrch({ service, provider: echoingProvider(requests) });

    await orch.runTurn({
      userMessage: 'Wie ist der Stand?',
      sessionScope: 'sess-hint',
      extraSystemHint: `# Verifier hat Widersprüche erkannt\n- Behauptet: "Mail an ${RAW_EMAIL} ist raus" → widerspricht der Quelle`,
    });

    assert.ok(requests.length > 0);
    for (const request of requests) {
      assert.deepEqual(findIdentityLeaks(request, [RAW_EMAIL]), []);
    }
    assert.match(requests[0]!, /Behauptet: \\"Mail an [a-z]+\.[a-z]+@example\.net ist raus/);
  });

  it('a blocked hint mask refuses the turn instead of sending the raw hint', async () => {
    const requests: string[] = [];
    const service: PrivacyGuardService = {
      internToolResultV4: async () => ({ digestText: '', datasetId: 'ds' }),
      recordBypassedTool: async () => undefined,
      runV4Tool: async () => ({ resultText: '' }),
      subAgentResultV4: async () => ({ resultText: '' }),
      takeRenderedAnswerV4: async () => undefined,
      v4ToolSpecs: () => [],
      finalizeTurn: async () => undefined,
      maskUserPrompt: async (request) =>
        request.text.includes('HINT-VALUE-4711')
          ? { outcome: 'blocked', reason: 'test' }
          : { outcome: 'disabled' },
    };
    const orch = buildOrch({ service, provider: echoingProvider(requests) });

    const result = await orch.runTurn({
      userMessage: 'Wie ist der Stand?',
      sessionScope: 'sess-hint-blocked',
      extraSystemHint: 'Behauptet: "HINT-VALUE-4711"',
    });

    assert.equal(requests.length, 0, 'the model was called with an unmaskable hint');
    assert.match(result.answer, /privacy protection for your text/);
  });

  it('a turn that throws drops its privacy state instead of keeping it until restart', async () => {
    const { service, finalizeCalls } = countingService();
    const failing = {
      ...echoingProvider([]),
      complete: async (): Promise<LlmResponse> => {
        throw new Error('provider down');
      },
    } as unknown as LlmProvider;
    const orch = buildOrch({ service, provider: failing });

    await assert.rejects(
      orch.runTurn({ userMessage: `Bitte schreibe an ${RAW_EMAIL} heute`, sessionScope: 'sess-throw' }),
    );
    assert.equal(finalizeCalls(), 1);
  });
});

async function drain(stream: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('orchestrator — privacy hand-over for the verifier (chatStream)', () => {
  it('a held stream emits done without a receipt and hands the wire view over', async () => {
    const { service, finalizeCalls } = countingService();
    const recorded: TurnReceiptRecordInput[] = [];
    const orch = buildOrch({ service, provider: echoingProvider([]), recorded });
    const input = { userMessage: `Bitte schreibe an ${RAW_EMAIL} heute`, sessionScope: 'sess-stream' };

    orch.markPrivacyFinalizeHeld(input);
    const events = await drain(orch.chatStream(input));
    const done = events.find((e) => e.type === 'done') as
      | Extract<ChatStreamEvent, { type: 'done' }>
      | undefined;

    assert.ok(done);
    assert.equal(done.privacyReceipt, undefined);
    assert.equal(done.receiptId, undefined);
    assert.ok(done.answer.includes(RAW_EMAIL));
    assert.equal(finalizeCalls(), 0);
    const egress = orch.takePrivacyEgress(input);
    assert.ok(egress?.verifierPrivacy);
    assert.deepEqual(findIdentityLeaks(egress.verifierPrivacy.wireAnswer, [RAW_EMAIL]), []);

    await egress.finalize();
    assert.equal(finalizeCalls(), 1);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.turnId, egress.receiptId);
  });

  it('the Direct Line site hands over too — with no view for the verifier', async () => {
    const { service, finalizeCalls } = countingService();
    const recorded: TurnReceiptRecordInput[] = [];
    const tool = createDomainTool({
      name: 'ask_strategist',
      description: 'Strategy sparring partner',
      domain: 'strategy',
      agentId: 'de.byte5.agent.strategist',
      agent: { ask: async (question: string) => `Antwort auf: ${question}` },
    });
    const orch = buildOrch({ service, provider: echoingProvider([]), recorded, domainTools: [tool] });
    const input = {
      userMessage: `#strategist Schreib an ${RAW_EMAIL} bitte`,
      sessionScope: 'sess-direct',
    };

    orch.markPrivacyFinalizeHeld(input);
    const events = await drain(orch.chatStream(input));
    const done = events.find((e) => e.type === 'done') as
      | Extract<ChatStreamEvent, { type: 'done' }>
      | undefined;

    assert.ok(done?.delegatedAnswer, 'not a Direct Line turn');
    assert.equal(done.privacyReceipt, undefined);
    const egress = orch.takePrivacyEgress(input);
    assert.ok(egress, 'the Direct Line site did not hand over');
    assert.equal(egress.verifierPrivacy, undefined, 'a restored relay must not reach the verifier');
    assert.equal(finalizeCalls(), 0);
    await egress.finalize();
    assert.equal(finalizeCalls(), 1);
    assert.equal(recorded.length, 1);
  });

  it('a stream abandoned before done drops its privacy state', async () => {
    const { service, finalizeCalls } = countingService();
    const orch = buildOrch({ service, provider: echoingProvider([]) });

    for await (const event of orch.chatStream({
      userMessage: `Bitte schreibe an ${RAW_EMAIL} heute`,
      sessionScope: 'sess-abandon',
    })) {
      if (event.type === 'text_delta') break;
    }

    assert.equal(finalizeCalls(), 1);
  });
});

describe('end to end — the verifier’s requests fall under the turn’s privacy policy', () => {
  const REAL_NAME = 'Jana Beispielfrau';

  /** The turn's model: answers with an accounting reference (so the
   *  verifier triggers) and the e-mail it saw — the surrogate. */
  function invoiceProvider(): LlmProvider {
    const answerFor = (req: LlmRequest): string => {
      const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(JSON.stringify(req))?.[0];
      return `Rechnung INV/2026/0042 geht an ${email ?? 'niemanden'} heute`;
    };
    return {
      ...echoingProvider([]),
      complete: async (req: LlmRequest): Promise<LlmResponse> => textResponse(answerFor(req)),
      stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
        const text = answerFor(req);
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text_delta', text } as LlmStreamEvent;
            yield { type: 'final', response: textResponse(text) } as LlmStreamEvent;
          },
        };
      },
    } as unknown as LlmProvider;
  }

  /** The verifier's own provider: records every request; extracts the one
   *  sentence of the answer it was shown; the judge verifies. */
  function verifierLlm(requests: string[]): LlmProvider {
    return {
      complete: async (req: LlmRequest): Promise<LlmResponse> => {
        const serialized = JSON.stringify(req);
        requests.push(serialized);
        const tool = (req.tools ?? [])[0]?.name;
        const input =
          tool === 'record_claims'
            ? {
                claims: [
                  {
                    text:
                      /Rechnung INV\/2026\/0042 geht an \S+ heute/.exec(
                        serialized.split('ASSISTANT ANSWER:')[1] ?? '',
                      )?.[0] ?? 'missing',
                    type: 'qualitative',
                    expected_source: 'graph',
                    related_entities: ['odoo:res.partner:7'],
                  },
                ],
              }
            : { verdict: 'verified', evidence_node_id: 'odoo:res.partner:7', rationale: 'passt' };
        return {
          content: [{ type: 'tool_call', id: 'toolu_x', name: tool ?? 'none', input }],
          finishReason: 'tool_use',
          providerFinishReason: 'tool_use',
          model: 'haiku',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        } as unknown as LlmResponse;
      },
    } as unknown as LlmProvider;
  }

  const EVIDENCE: EvidenceSnippet = {
    nodeId: 'odoo:res.partner:7',
    source: 'graph',
    title: REAL_NAME,
    content: `Graph-Node odoo:res.partner:7 — ${REAL_NAME} (email=${RAW_EMAIL}, customer_rank=1)`,
    identityValues: [REAL_NAME, RAW_EMAIL],
  };

  function wrapped(
    requests: string[],
    recorded: TurnReceiptRecordInput[],
    maskUserPrompt = true,
  ): BuiltVerifierService {
    const { service } = countingService(maskUserPrompt);
    const orch = buildOrch({ service, provider: invoiceProvider(), recorded });
    const llm = verifierLlm(requests);
    const pipeline = new VerifierPipeline({
      extractor: new ClaimExtractor({ llm, log: () => undefined }),
      deterministic: new DeterministicChecker({ log: () => undefined }),
      judge: new EvidenceJudge({
        llm,
        fetcher: { fetch: async () => [EVIDENCE] },
        log: () => undefined,
      }),
      log: () => undefined,
    });
    return new BuiltVerifierService({
      orchestrator: orch,
      pipeline,
      enabled: true,
      mode: 'shadow',
      log: () => undefined,
    });
  }

  it('chat(): extractor and judge requests carry placeholders only; one receipt books them apart', async () => {
    const requests: string[] = [];
    const recorded: TurnReceiptRecordInput[] = [];
    const agent = wrapped(requests, recorded);

    const answer = await agent.chat({
      userMessage: `Schick die Rechnung an ${RAW_EMAIL} bitte`,
      sessionScope: 'sess-e2e',
    });

    assert.equal(requests.length, 2, 'expected one extraction and one judge request');
    for (const request of requests) {
      assert.deepEqual(findIdentityLeaks(request, [RAW_EMAIL, REAL_NAME]), []);
    }
    // One map: the judge sees the SAME surrogate for the e-mail in the claim
    // and in the evidence as the turn's own model did.
    const surrogate = SURROGATE_EMAIL.exec(requests[0]!)?.[0];
    assert.ok(surrogate);
    assert.equal(requests[1]!.split(surrogate).length - 1, 2, 'claim and evidence share one placeholder');
    // The user still gets real values.
    assert.ok(answer.text.includes(RAW_EMAIL));
    // One receipt covers the turn AND the verifier, booked apart, persisted once.
    const receipt = answer.privacyReceipt;
    assert.ok(receipt);
    assert.equal(receipt.verifierEgress?.requests, 2);
    assert.ok((receipt.maskedPromptSpans ?? []).length > 0);
    assert.ok((receipt.verifierEgress?.maskedSpans ?? []).length > 0);
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0]!.receipt, receipt);
  });

  it('prompt masking off (the default): the prompt follows the policy, the evidence is still projected', async () => {
    const requests: string[] = [];
    const recorded: TurnReceiptRecordInput[] = [];
    const agent = wrapped(requests, recorded, false);

    const answer = await agent.chat({
      userMessage: `Schick die Rechnung an ${RAW_EMAIL} bitte`,
      sessionScope: 'sess-e2e-off',
    });

    assert.equal(requests.length, 2);
    // Extraction request: the operator's policy says the prompt is not
    // masked, so it carries what the turn's own model saw — nothing more.
    assert.ok(requests[0]!.includes(RAW_EMAIL));
    // Judge request: knowledge-graph evidence is projected regardless.
    assert.deepEqual(findIdentityLeaks(requests[1]!, [RAW_EMAIL, REAL_NAME]), []);
    assert.match(requests[1]!, /PLATZHALTER-NAME-\d+/);
    assert.equal(answer.privacyReceipt?.verifierEgress?.requests, 2);
    assert.equal(answer.privacyReceipt?.maskedPromptSpans, undefined);
    assert.equal(recorded.length, 1);
  });

  it('chatStream(): done arrives after verification and carries the complete receipt', async () => {
    const requests: string[] = [];
    const recorded: TurnReceiptRecordInput[] = [];
    const agent = wrapped(requests, recorded);

    const events = await drain(
      agent.chatStream({ userMessage: `Schick die Rechnung an ${RAW_EMAIL} bitte`, sessionScope: 'sess-e2e-s' }),
    );
    const types = events.map((e) => e.type);
    const done = events.find((e) => e.type === 'done') as
      | Extract<ChatStreamEvent, { type: 'done' }>
      | undefined;

    assert.equal(types.indexOf('done'), types.length - 2, 'done must be followed by the verifier event only');
    assert.equal(types.at(-1), 'verifier');
    for (const request of requests) {
      assert.deepEqual(findIdentityLeaks(request, [RAW_EMAIL, REAL_NAME]), []);
    }
    assert.equal(done?.privacyReceipt?.verifierEgress?.requests, 2);
    assert.equal(recorded.length, 1);
    assert.equal(done?.receiptId, recorded[0]!.turnId);
  });
});

describe('verifier wrapping — subscription-CLI runtime', () => {
  function fakeNativeToolRegistry(): NativeToolRegistryType {
    const names = new Set<string>();
    return {
      has: (name: string) => names.has(name),
      register: (name: string) => {
        names.add(name);
        return () => names.delete(name);
      },
    } as unknown as NativeToolRegistryType;
  }

  function deps(provider: OrchestratorDeps['provider']): OrchestratorDeps {
    return {
      provider,
      knowledgeGraph: {} as KnowledgeGraph,
      memoryStore: {} as MemoryStore,
      entityRefBus: {} as EntityRefBus,
      nativeToolRegistry: fakeNativeToolRegistry(),
      nudgeRegistry: new InMemoryNudgeRegistry(),
      responseGuard: () => undefined,
      privacyGuard: () => undefined,
      verifierBundle: {
        pipeline: {} as VerifierPipeline,
        mode: 'enforce',
        maxRetries: 1,
      },
    };
  }

  it('never wraps a claude-cli agent, while an API-key agent with the same bundle is wrapped', () => {
    const cli = buildOrchestratorForAgent(
      { agentId: 'cli', model: 'opus-cli', maxTokens: 100, maxToolIterations: 4 },
      deps({ id: 'claude-cli' } as unknown as OrchestratorDeps['provider']),
    );
    const api = buildOrchestratorForAgent(
      { agentId: 'api', model: 'm', maxTokens: 100, maxToolIterations: 4 },
      deps(createAnthropicProvider({ client: createAnthropicClient({ apiKey: 'test-key' }) })),
    );

    assert.equal(cli.bundle.agent instanceof VerifierService, false);
    assert.notEqual(cli.bundle.agent, cli.orchestrator);
    assert.equal(api.bundle.agent instanceof VerifierService, true);
  });
});
