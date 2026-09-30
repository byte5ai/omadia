/**
 * The answer verifier wrapped around the REAL Orchestrator and the REAL
 * privacy-guard service: every request the verifier's own model receives
 * falls under the verified turn's privacy policy, and one receipt covers
 * the turn and its verifier. Also pins where the verifier does NOT run:
 * server-rendered answers, Direct Line relays, a disabled verifier, and the
 * subscription-CLI runtime (never wrapped).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  createAnthropicClient,
  createAnthropicProvider,
} from '@omadia/llm-adapter-anthropic';
import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import {
  VerifierService as BuiltVerifierService,
  createDomainTool,
  type Orchestrator,
} from '@omadia/orchestrator';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type {
  EntityRefBus,
  KnowledgeGraph,
  MemoryStore,
  PrivacyGuardService,
  TurnReceiptRecordInput,
} from '@omadia/plugin-api';
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
import {
  RAW_EMAIL,
  SURROGATE_EMAIL,
  buildOrch,
  countingService,
  doneOf,
  drain,
  echoingProvider,
} from './_helpers/privacyEgressHarness.js';

const REAL_NAME = 'Jana Beispielfrau';

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

/** The turn's model answers with an accounting reference (so the verifier
 *  triggers) and the e-mail it saw — the surrogate when masking is on. */
const invoiceReply = (email: string): string => `Rechnung INV/2026/0042 geht an ${email} heute`;

function wrapped(opts: {
  readonly requests: string[];
  readonly recorded: TurnReceiptRecordInput[];
  readonly maskUserPrompt?: boolean;
  readonly overrides?: Partial<PrivacyGuardService>;
  readonly domainTools?: Parameters<typeof buildOrch>[0]['domainTools'];
  readonly enabled?: boolean;
}): { agent: BuiltVerifierService; orch: Orchestrator; finalizeCalls: () => number } {
  const { service, finalizeCalls } = countingService(opts.maskUserPrompt ?? true, opts.overrides);
  const orch = buildOrch({
    service,
    provider: echoingProvider([], invoiceReply),
    recorded: opts.recorded,
    ...(opts.domainTools ? { domainTools: opts.domainTools } : {}),
  });
  const llm = verifierLlm(opts.requests);
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
  const agent = new BuiltVerifierService({
    orchestrator: orch,
    pipeline,
    enabled: opts.enabled ?? true,
    mode: 'shadow',
    log: () => undefined,
  });
  return { agent, orch, finalizeCalls };
}

const ASK = `Schick die Rechnung an ${RAW_EMAIL} bitte`;

describe('end to end — the verifier’s requests fall under the turn’s privacy policy', () => {
  it('chat(): extractor and judge requests carry placeholders only; one receipt books them apart', async () => {
    const requests: string[] = [];
    const recorded: TurnReceiptRecordInput[] = [];
    const { agent } = wrapped({ requests, recorded });

    const answer = await agent.chat({ userMessage: ASK, sessionScope: 'sess-e2e' });

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
    const { agent } = wrapped({ requests, recorded, maskUserPrompt: false });

    const answer = await agent.chat({ userMessage: ASK, sessionScope: 'sess-e2e-off' });

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
    const { agent } = wrapped({ requests, recorded });

    const events = await drain(agent.chatStream({ userMessage: ASK, sessionScope: 'sess-e2e-s' }));
    const types = events.map((e) => e.type);
    const done = doneOf(events);

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

describe('end to end — an MCP input-card reply reaches the verifier only as its label', () => {
  // The card answer arrives as a machine envelope whose values were typed for
  // a third-party server — a password the prompt detectors do not recognise,
  // an address they do. The turn's model sees only the label; so must the
  // verifier, with prompt masking on or off.
  const SECRET = 'private-secret-value';
  const CONTACT = 'secret@example.com';
  const ENVELOPE = `__mcp_input_reply__ ${JSON.stringify({
    correlationId: 'x',
    inputResponses: { password: SECRET, contact: CONTACT },
  })}`;
  const LABEL = '[Eingaben übermittelt: password, contact]';

  function assertNoEnvelope(requests: readonly string[]): void {
    assert.ok(requests.length > 0, 'the verifier did not run');
    for (const request of requests) {
      for (const part of [SECRET, CONTACT, '__mcp_input_reply__', 'inputResponses', 'correlationId']) {
        assert.equal(request.includes(part), false, `"${part}" reached a verifier request`);
      }
    }
    assert.ok(requests[0]!.includes(LABEL), 'the extraction request lacks the prompt the model saw');
  }

  for (const maskUserPrompt of [true, false]) {
    it(`chat(), prompt masking ${maskUserPrompt ? 'on' : 'off'}`, async () => {
      const requests: string[] = [];
      const { agent } = wrapped({ requests, recorded: [], maskUserPrompt });

      await agent.chat({ userMessage: ENVELOPE, sessionScope: `sess-e2e-mcp-${String(maskUserPrompt)}` });

      assertNoEnvelope(requests);
    });
  }

  it('chatStream()', async () => {
    const requests: string[] = [];
    const { agent } = wrapped({ requests, recorded: [], maskUserPrompt: false });

    await drain(agent.chatStream({ userMessage: ENVELOPE, sessionScope: 'sess-e2e-mcp-s' }));

    assertNoEnvelope(requests);
  });
});

describe('end to end — where the verifier sends nothing', () => {
  it('a server-rendered answer is not verified; its receipt is still finalized and attached', async () => {
    const requests: string[] = [];
    const recorded: TurnReceiptRecordInput[] = [];
    const rendered = `| Kunde | E-Mail |\n| ${REAL_NAME} | ${RAW_EMAIL} |`;
    const { agent, finalizeCalls } = wrapped({
      requests,
      recorded,
      overrides: {
        takeRenderedAnswerV4: async () => ({ text: rendered, maskedValues: [REAL_NAME, RAW_EMAIL] }),
      },
    });

    const answer = await agent.chat({ userMessage: ASK, sessionScope: 'sess-e2e-render' });

    assert.equal(answer.text.includes(RAW_EMAIL), true);
    assert.equal(requests.length, 0, 'rendered real values reached the verifier');
    assert.equal(finalizeCalls(), 1);
    assert.ok(answer.privacyReceipt);
    assert.equal(answer.privacyReceipt.verifierEgress, undefined);
    assert.equal(recorded.length, 1);
  });

  it('a streaming Direct Line relay is not verified; done still carries the receipt', async () => {
    const requests: string[] = [];
    const recorded: TurnReceiptRecordInput[] = [];
    const tool = createDomainTool({
      name: 'ask_strategist',
      description: 'Strategy sparring partner',
      domain: 'strategy',
      agentId: 'de.byte5.agent.strategist',
      agent: { ask: async (question: string) => `Rechnung INV/2026/0042: ${question}` },
    });
    const { agent, finalizeCalls } = wrapped({ requests, recorded, domainTools: [tool] });

    const events = await drain(
      agent.chatStream({ userMessage: `#strategist ${ASK}`, sessionScope: 'sess-e2e-direct' }),
    );
    const done = doneOf(events);

    assert.ok(done?.delegatedAnswer, 'not a Direct Line turn');
    assert.equal(requests.length, 0, 'the relay reached the verifier');
    assert.equal(events.at(-1)?.type, 'done', 'no verifier event for an unverified relay');
    assert.equal(finalizeCalls(), 1);
    assert.equal(recorded.length, 1);
    assert.ok(done.privacyReceipt);
    assert.equal(done.receiptId, recorded[0]!.turnId);
  });

  it('a disabled verifier leaves the turn to finalize itself, exactly as before', async () => {
    const requests: string[] = [];
    const recorded: TurnReceiptRecordInput[] = [];
    const { agent, orch, finalizeCalls } = wrapped({ requests, recorded, enabled: false });
    const input = { userMessage: ASK, sessionScope: 'sess-e2e-off-verifier' };

    const answer = await agent.chat(input);

    assert.equal(requests.length, 0);
    assert.equal(orch.takePrivacyEgress(input), undefined, 'a disabled verifier held the turn');
    assert.equal(finalizeCalls(), 1);
    assert.ok(answer.privacyReceipt);
    assert.equal(answer.privacyReceipt.verifierEgress, undefined);
    assert.equal(recorded.length, 1);
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
