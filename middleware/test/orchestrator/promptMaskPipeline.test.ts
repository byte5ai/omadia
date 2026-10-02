/**
 * #361 — orchestrator-level end-to-end assertions for free-text user-prompt
 * PII masking. Complements `test/privacyPromptMask.test.ts` (engine/service
 * units) by exercising the REAL turn pipeline with the REAL privacy-guard
 * service and the REAL FactExtractor:
 *
 *   1. flag on → the outgoing LLM params of the MAIN call AND of the
 *      fact-extraction call carry surrogates and ZERO raw detected spans;
 *   2. persisted content (session log answer, ingested KG facts) carries
 *      the REAL values — never surrogates;
 *   3. turn-N+1 recalled prior context is masked before injection, so a
 *      raw span persisted on turn N never re-crosses the wire.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { InMemoryMemoryStore } from '@omadia/memory';
import {
  NativeToolRegistry,
  Orchestrator,
  SessionLogger,
  steeringBus,
} from '@omadia/orchestrator';
import { PROMPT_MASK_BLOCKED_ANSWER } from '@omadia/orchestrator/dist/orchestrator.js';
import {
  CaptureFilter,
  CaptureFilteringKnowledgeGraph,
  FactExtractor,
} from '@omadia/orchestrator-extras';
import type {
  FactIngest,
  KnowledgeGraph,
  PrivacyGuardService,
  PromptPiiDetector,
  PromptPiiSpan,
  TurnIngest,
} from '@omadia/plugin-api';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

const RAW_EMAIL = 'anna.schmidt@firma.de';
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** The privacy-guard service with the #361 flag forced ON. */
function maskingService(): ReturnType<typeof createPrivacyGuardService> {
  return createPrivacyGuardService({
    readConfig: (key: string) => (key === 'mask_user_prompt' ? 'on' : undefined),
  });
}

/** A C1 stand-in that finds the given names, as the GLiNER sidecar would. */
function namesC1(...names: readonly string[]): PromptPiiDetector {
  return {
    id: 'c1-test',
    async detect(text: string): Promise<readonly PromptPiiSpan[]> {
      const spans: PromptPiiSpan[] = [];
      for (const name of names) {
        for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + name.length)) {
          spans.push({ start: at, end: at + name.length, type: 'person', confidence: 0.99 });
        }
      }
      return spans;
    },
  };
}

function textResponse(text: string): LlmResponse {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage: {
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  };
}

/** Main-call fake: records every request and answers by echoing the first
 *  email-shaped token it can find in its own request — i.e. the surrogate
 *  the mask pass put on the wire. */
function echoingMainProvider(requests: string[]): LlmProvider {
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      const serialized = JSON.stringify(req);
      requests.push(serialized);
      const email = EMAIL_RE.exec(serialized)?.[0] ?? 'no-email-in-request';
      return textResponse(`Notiert. Ich schreibe an ${email}.`);
    },
    stream: (): AsyncIterable<LlmStreamEvent> => {
      throw new Error('echoingMainProvider: stream() not scripted');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return provider as unknown as LlmProvider;
}

/** Haiku fake for the FactExtractor: records the request and returns one
 *  fact whose object is the email token it saw — the surrogate, when the
 *  orchestrator fed it masked wire text. */
function factLlm(requests: string[]): LlmProvider {
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      const serialized = JSON.stringify(req);
      requests.push(serialized);
      const email = EMAIL_RE.exec(serialized)?.[0] ?? 'no-email-in-request';
      return textResponse(
        JSON.stringify([
          {
            subject: 'kunde:anna',
            predicate: 'kontakt_email',
            object: email,
            confidence: 0.9,
          },
        ]),
      );
    },
    stream: (): AsyncIterable<LlmStreamEvent> => {
      throw new Error('factLlm: stream() not scripted');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return provider as unknown as LlmProvider;
}

type OrchestratorOptions = ConstructorParameters<typeof Orchestrator>[0];

describe('#361 prompt masking — orchestrator pipeline', () => {
  it('masks main + fact-extraction LLM params, persists real values', async () => {
    const mainRequests: string[] = [];
    const factRequests: string[] = [];
    const loggedEntries: Array<{ userMessage: string; assistantAnswer: string }> =
      [];
    const ingestedFacts: FactIngest[] = [];
    let resolveIngest: () => void = () => undefined;
    const ingestDone = new Promise<void>((resolve) => {
      resolveIngest = resolve;
    });

    const sessionLogger = {
      log: async (entry: {
        userMessage: string;
        assistantAnswer: string;
      }): Promise<{ turnExternalId: string }> => {
        loggedEntries.push({
          userMessage: entry.userMessage,
          assistantAnswer: entry.assistantAnswer,
        });
        return { turnExternalId: 'turn:sess-1:t1' };
      },
    } as unknown as OrchestratorOptions['sessionLogger'];

    const graph = {
      ingestFacts: async (
        ingests: FactIngest[],
      ): Promise<{ inserted: number; updated: number; factIds: string[] }> => {
        ingestedFacts.push(...ingests);
        resolveIngest();
        return {
          inserted: ingests.length,
          updated: 0,
          factIds: ingests.map((i) => i.factId),
        };
      },
    } as unknown as KnowledgeGraph;

    const orch = new Orchestrator({
      provider: echoingMainProvider(mainRequests),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      sessionLogger,
      factExtractor: new FactExtractor({ llm: factLlm(factRequests), graph }),
      privacyGuard: () => maskingService(),
    });

    const result = await orch.runTurn({
      userMessage: `Bitte schreibe an ${RAW_EMAIL} wegen des Vertrags.`,
      sessionScope: 'sess-1',
      userId: 'u1',
    });

    // Fire-and-forget extraction — wait for the graph write (bounded).
    await Promise.race([
      ingestDone,
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          reject(new Error('fact ingest did not complete within 5s'));
        }, 5_000),
      ),
    ]);

    // (1) MAIN call: surrogate on the wire, zero raw spans.
    assert.equal(mainRequests.length, 1);
    assert.ok(
      !mainRequests[0]!.includes(RAW_EMAIL),
      'main LLM params must not contain the raw email',
    );
    const surrogate = EMAIL_RE.exec(mainRequests[0]!)?.[0];
    assert.ok(surrogate, 'main LLM params must carry an email-shaped surrogate');
    assert.notEqual(surrogate, RAW_EMAIL);

    // (1) FACT-EXTRACTION call: same wire rule.
    assert.equal(factRequests.length, 1);
    assert.ok(
      !factRequests[0]!.includes(RAW_EMAIL),
      'fact-extraction LLM params must not contain the raw email',
    );
    assert.ok(
      factRequests[0]!.includes(surrogate!),
      'fact-extraction call must see the SAME turn-stable surrogate',
    );

    // (2) Persisted session log: raw user message, POST-restore answer.
    assert.equal(loggedEntries.length, 1);
    assert.ok(loggedEntries[0]!.userMessage.includes(RAW_EMAIL));
    assert.ok(
      loggedEntries[0]!.assistantAnswer.includes(RAW_EMAIL),
      'persisted answer must carry the restored real value',
    );
    assert.ok(
      !loggedEntries[0]!.assistantAnswer.includes(surrogate!),
      'persisted answer must not carry the surrogate',
    );

    // (2) Persisted KG facts: restored to the real value.
    assert.equal(ingestedFacts.length, 1);
    assert.equal(ingestedFacts[0]!.object, RAW_EMAIL);

    // User-facing answer: restored.
    assert.ok(result.answer.includes(RAW_EMAIL));
    assert.ok(!result.answer.includes(surrogate!));

    // Transparency: the receipt records the masked prompt span (PII-free).
    assert.ok(result.privacyReceipt, 'a privacy receipt must be attached');
    const spans = result.privacyReceipt.maskedPromptSpans ?? [];
    assert.ok(
      spans.some((s) => s.type === 'email'),
      'receipt must record the masked email span',
    );
  });

  it('turn N+1: recalled prior context is masked before injection', async () => {
    const mainRequests: string[] = [];
    // Simulates the KG recall of turn N — real values, as persisted.
    const contextRetriever = {
      assembleForBudget: async (): Promise<unknown> => ({
        text: `## Letzte Turns in diesem Chat\nUser bat um Mail an ${RAW_EMAIL}.`,
        included: [],
        excluded: [],
        stats: { candidatePool: 1, compactMode: false, tokensUsed: 10 },
        recalled: undefined,
      }),
    } as unknown as OrchestratorOptions['contextRetriever'];

    const orch = new Orchestrator({
      provider: echoingMainProvider(mainRequests),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      contextRetriever,
      privacyGuard: () => maskingService(),
    });

    const result = await orch.runTurn({
      userMessage: 'An welche Adresse ging die Mail nochmal?',
      sessionScope: 'sess-1',
      userId: 'u1',
    });

    assert.equal(mainRequests.length, 1);
    assert.ok(
      !mainRequests[0]!.includes(RAW_EMAIL),
      'turn-N+1 LLM params must not re-leak the raw span from turn N',
    );
    const surrogate = EMAIL_RE.exec(mainRequests[0]!)?.[0];
    assert.ok(
      surrogate,
      'the recalled context must carry an email-shaped surrogate instead',
    );
    // Answer-side restore covers recall-injected spans too: the provider
    // echoed the surrogate, the user sees the real value.
    assert.ok(result.answer.includes(RAW_EMAIL));
  });

  it('turn N+2: a recalled answer with restored values is masked with mask_user_prompt off', async () => {
    // The session tail recalls an answer as persisted, with its real values
    // restored. It goes to the model like a replayed answer: masked whatever
    // `mask_user_prompt` says (off here, as shipped).
    const RAW_NAME = 'Jana Beispielfrau';
    const mainRequests: string[] = [];
    const contextRetriever = {
      assembleForBudget: async (): Promise<unknown> => ({
        text: `## Letzte Turns in diesem Chat\nAssistant: ${RAW_NAME} leitet das Team, erreichbar unter ${RAW_EMAIL}.`,
        included: [],
        excluded: [],
        stats: { candidatePool: 1, compactMode: false, tokensUsed: 10 },
        recalled: undefined,
      }),
    } as unknown as OrchestratorOptions['contextRetriever'];

    const orch = new Orchestrator({
      provider: echoingMainProvider(mainRequests),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      contextRetriever,
      // No `mask_user_prompt` in the config; C1 finds names.
      privacyGuard: () => createPrivacyGuardService({ c1Detector: namesC1(RAW_NAME) }),
    });

    const result = await orch.runTurn({
      userMessage: 'Wer war nochmal die Ansprechpartnerin?',
      sessionScope: 'sess-recalled-answer',
      userId: 'u1',
    });

    assert.equal(mainRequests.length, 1);
    assert.ok(!mainRequests[0]!.includes(RAW_EMAIL), 'the recalled answer must not carry the real e-mail');
    assert.ok(!mainRequests[0]!.includes(RAW_NAME), 'the recalled answer must not carry the real name');
    assert.ok(EMAIL_RE.exec(mainRequests[0]!)?.[0], 'the recalled answer must carry an e-mail-shaped surrogate');
    // Answer-side restore covers the recalled spans: the provider echoed the
    // surrogate, the user sees the real value.
    assert.ok(result.answer.includes(RAW_EMAIL), result.answer);
  });

  it('turn N+1: priorTurns (live chat history) are masked before assembly', async () => {
    // Second-review fix — persisted turns store restored REAL values by
    // design, and channels replay them verbatim as `priorTurns`. Turn 1
    // named an IBAN; turn 2 sends priorTurns=[turn 1] → the turn-2 request
    // body must contain ZERO raw detected spans.
    const RAW_IBAN = 'DE89370400440532013000';
    const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;
    const mainRequests: string[] = [];
    const provider = {
      id: 'anthropic',
      capabilities: providerCapabilities,
      complete: async (req: LlmRequest): Promise<LlmResponse> => {
        const serialized = JSON.stringify(req);
        mainRequests.push(serialized);
        const iban = IBAN_RE.exec(serialized)?.[0] ?? 'no-iban-in-request';
        return textResponse(`Die Überweisung geht an ${iban}.`);
      },
      stream: (): AsyncIterable<LlmStreamEvent> => {
        throw new Error('priorTurns provider: stream() not scripted');
      },
      classifyError: () => ({ retryable: false, kind: 'other' as const }),
    } as unknown as LlmProvider;

    const orch = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      privacyGuard: () => maskingService(),
    });

    const result = await orch.runTurn({
      userMessage: 'An welches Konto ging die Überweisung nochmal?',
      sessionScope: 'sess-1',
      userId: 'u1',
      // The IBAN is space-delimited in both copies: the detector's
      // word-boundary extension folds adjacent punctuation into the span
      // VALUE, and only byte-identical values share one map entry.
      priorTurns: [
        {
          userMessage: `Bitte überweise das Gehalt auf ${RAW_IBAN} sofort`,
          assistantAnswer: `Alles klar, ich habe ${RAW_IBAN} als Zielkonto notiert`,
        },
      ],
    });

    assert.equal(mainRequests.length, 1);
    assert.ok(
      !mainRequests[0]!.includes(RAW_IBAN),
      'turn-2 request body must contain zero raw detected spans from turn 1',
    );
    const surrogate = IBAN_RE.exec(mainRequests[0]!)?.[0];
    assert.ok(
      surrogate,
      'the prior turns must carry an IBAN-shaped surrogate instead',
    );
    assert.notEqual(surrogate, RAW_IBAN);
    // Both copies (prior user message AND prior assistant answer) carry the
    // SAME turn-stable surrogate — the shared per-turn map at work.
    const occurrences = mainRequests[0]!.split(surrogate!).length - 1;
    assert.ok(
      occurrences >= 2,
      'prior user message and prior assistant answer must share one surrogate',
    );
    // Answer-side restore covers priorTurn-derived spans too: the provider
    // echoed the surrogate, the user sees the real value.
    assert.ok(result.answer.includes(RAW_IBAN));
    assert.ok(!result.answer.includes(surrogate!));
  });

  it('turn N+1: a replayed answer is masked with mask_user_prompt off, the replayed user message is not', async () => {
    // Teams and Telegram replay the answer they delivered, and an answer the
    // shield rendered carries real values the model never saw, so a replayed
    // answer is masked whatever `mask_user_prompt` says. The user's own words
    // follow the flag: off here, as shipped.
    const RAW_NAME = 'Jana Beispielfrau';
    const RAW_ANSWER_EMAIL = 'jana.beispiel@firma.de';
    const RAW_USER_EMAIL = 'max.muster@firma.de';
    const SURROGATE_RE = /[^\s"\\]+@example\.net/;
    const mainRequests: string[] = [];
    const provider = {
      id: 'anthropic',
      capabilities: providerCapabilities,
      complete: async (req: LlmRequest): Promise<LlmResponse> => {
        const serialized = JSON.stringify(req);
        mainRequests.push(serialized);
        const surrogate = SURROGATE_RE.exec(serialized)?.[0] ?? 'no-surrogate-in-request';
        return textResponse(`Ich schreibe an ${surrogate} heute.`);
      },
      stream: (): AsyncIterable<LlmStreamEvent> => {
        throw new Error('replayed-answer provider: stream() not scripted');
      },
      classifyError: () => ({ retryable: false, kind: 'other' as const }),
    } as unknown as LlmProvider;

    const orch = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      // No `mask_user_prompt` in the config; C1 finds names, as the GLiNER
      // sidecar would.
      privacyGuard: () => createPrivacyGuardService({ c1Detector: namesC1(RAW_NAME) }),
    });

    const result = await orch.runTurn({
      userMessage: 'Schreib ihr bitte wegen des Termins.',
      sessionScope: 'sess-replayed-answer',
      userId: 'u1',
      priorTurns: [
        {
          userMessage: `Wer leitet das Team? Antwort bitte an ${RAW_USER_EMAIL} heute`,
          assistantAnswer: `${RAW_NAME} leitet das Team, erreichbar unter ${RAW_ANSWER_EMAIL} oder im Büro`,
        },
      ],
    });

    assert.equal(mainRequests.length, 1);
    const wire = mainRequests[0]!;
    assert.ok(!wire.includes(RAW_NAME), 'the replayed answer must not carry the real name');
    assert.ok(!wire.includes(RAW_ANSWER_EMAIL), 'the replayed answer must not carry the real e-mail');
    assert.ok(
      wire.includes(RAW_USER_EMAIL),
      'the replayed user message follows mask_user_prompt, which is off',
    );
    const surrogate = SURROGATE_RE.exec(wire)?.[0];
    assert.ok(surrogate, 'the replayed answer must carry an e-mail-shaped surrogate');
    // Answer-side restore covers the replayed answer's spans.
    assert.ok(result.answer.includes(RAW_ANSWER_EMAIL), result.answer);
    assert.ok(!result.answer.includes(surrogate!));
    // Booked as the turn's own egress.
    assert.deepEqual(
      (result.privacyReceipt?.maskedPromptSpans ?? []).map((s) => s.type).sort(),
      ['email', 'person'],
    );
    assert.equal(result.privacyReceipt?.verifierEgress, undefined);
  });

  it('turn N+1: a provider without maskReplayedAnswer masks the replayed answer through maskUserPrompt', async () => {
    // An older privacy plugin: the answer follows `mask_user_prompt` as
    // before, on here, so it is still masked.
    const RAW_IBAN = 'DE89370400440532013000';
    const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;
    const mainRequests: string[] = [];
    const provider = {
      id: 'anthropic',
      capabilities: providerCapabilities,
      complete: async (req: LlmRequest): Promise<LlmResponse> => {
        mainRequests.push(JSON.stringify(req));
        return textResponse('Notiert.');
      },
      stream: (): AsyncIterable<LlmStreamEvent> => {
        throw new Error('legacy provider: stream() not scripted');
      },
      classifyError: () => ({ retryable: false, kind: 'other' as const }),
    } as unknown as LlmProvider;
    const legacy = (): PrivacyGuardService => ({
      ...maskingService(),
      maskReplayedAnswer: undefined,
    });

    const orch = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      privacyGuard: legacy,
    });

    await orch.runTurn({
      userMessage: 'Und das Konto?',
      sessionScope: 'sess-legacy-provider',
      userId: 'u1',
      priorTurns: [
        { userMessage: 'Wohin geht das Gehalt?', assistantAnswer: `Auf ${RAW_IBAN} wie immer` },
      ],
    });

    assert.equal(mainRequests.length, 1);
    assert.ok(!mainRequests[0]!.includes(RAW_IBAN), 'the replayed answer must be masked');
    assert.ok(IBAN_RE.test(mainRequests[0]!), 'an IBAN-shaped surrogate must stand in for it');
  });

  it('turn N+1: a blocked replayed answer fails the turn closed before the model is called', async () => {
    const mainRequests: string[] = [];
    const orch = new Orchestrator({
      provider: echoingMainProvider(mainRequests),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      privacyGuard: () => ({
        ...createPrivacyGuardService(),
        maskReplayedAnswer: async () => ({
          outcome: 'blocked' as const,
          reason: 'test: masking could not be guaranteed',
        }),
      }),
    });

    const result = await orch.runTurn({
      userMessage: 'Und weiter?',
      sessionScope: 'sess-replay-blocked',
      userId: 'u1',
      priorTurns: [{ userMessage: 'Kontakt?', assistantAnswer: `Kontakt: ${RAW_EMAIL} bitte` }],
    });

    assert.equal(result.answer, PROMPT_MASK_BLOCKED_ANSWER);
    assert.equal(mainRequests.length, 0, 'the model must not be called');
  });

  it('mid-turn steering (/chat/steer) is masked before it crosses the wire', async () => {
    // Codex review fix — the steering bus injects RAW user text into the
    // running iteration loop (streaming path). That text is LLM-bound wire
    // content like the original user message: with the flag on, a steered
    // IBAN must reach the provider only as a surrogate, through the SAME
    // turn map (so answer-side restore covers steered spans too).
    const RAW_IBAN = 'DE89370400440532013000';
    const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;
    const streamRequests: string[] = [];
    const provider = {
      id: 'anthropic',
      capabilities: providerCapabilities,
      complete: async (): Promise<LlmResponse> => {
        throw new Error('steering provider: complete() not scripted');
      },
      stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
        const serialized = JSON.stringify(req);
        streamRequests.push(serialized);
        const iban = IBAN_RE.exec(serialized)?.[0] ?? 'no-iban-in-request';
        const text = `Verstanden, ich nutze ${iban}.`;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text_delta', text } as LlmStreamEvent;
            yield {
              type: 'final',
              response: {
                content: [{ type: 'text', text }],
                finishReason: 'stop',
                providerFinishReason: 'end_turn',
                model: 'test',
                usage: {
                  inputTokens: 10,
                  outputTokens: 1,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                },
              },
            } as LlmStreamEvent;
          },
        };
      },
      classifyError: () => ({ retryable: false, kind: 'other' as const }),
    } as unknown as LlmProvider;

    const orch = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      privacyGuard: () => maskingService(),
    });

    const events: Array<{ type: string } & Record<string, unknown>> = [];
    let steered = false;
    for await (const event of orch.chatStream({
      userMessage: 'Bitte fasse den Stand kurz zusammen.',
      sessionScope: 'sess-steer',
      userId: 'u1',
    })) {
      events.push(event as { type: string } & Record<string, unknown>);
      // The generator suspends at each yield: enqueueing on the first
      // `iteration_start` lands in the bus BEFORE the loop's drain runs,
      // exactly like a real /chat/steer request racing the model call.
      if (event.type === 'iteration_start' && !steered) {
        steered = true;
        const enq = steeringBus.enqueue(
          'sess-steer',
          `Wichtig: nimm das Konto ${RAW_IBAN} dafür.`,
        );
        assert.equal(enq.live, true, 'the turn must be live for steering');
      }
    }

    // The steer was applied — and echoed to the user RAW (user-facing).
    const applied = events.find((e) => e.type === 'steer_applied');
    assert.ok(applied, 'a steer_applied event must be emitted');
    assert.ok(String(applied!['message']).includes(RAW_IBAN));

    // ZERO raw detected spans in ANY outgoing streaming request body.
    assert.ok(streamRequests.length >= 1);
    for (const req of streamRequests) {
      assert.ok(
        !req.includes(RAW_IBAN),
        'streamed LLM params must not contain the raw steered IBAN',
      );
    }
    const withSurrogate = streamRequests.find((req) => IBAN_RE.test(req));
    assert.ok(
      withSurrogate,
      'the steered text must reach the wire as an IBAN-shaped surrogate',
    );
    const surrogate = IBAN_RE.exec(withSurrogate!)?.[0];
    assert.notEqual(surrogate, RAW_IBAN);

    // Answer-side restore covers steered spans (same turn map): the
    // provider echoed the surrogate, the final answer shows the real value.
    const done = events.find((e) => e.type === 'done');
    assert.ok(done, 'the stream must settle with a done event');
    assert.ok(String(done!['answer']).includes(RAW_IBAN));
    assert.ok(!String(done!['answer']).includes(surrogate!));
  });
});

/** Main-call fake for both paths: answers by echoing the first e-mail-shaped
 *  token of its own request — the surrogate, when the request was masked. */
function echoingStreamProvider(requests: string[]): LlmProvider {
  const answerFor = (req: LlmRequest): LlmResponse => {
    const serialized = JSON.stringify(req);
    requests.push(serialized);
    const email = EMAIL_RE.exec(serialized)?.[0] ?? 'no-email-in-request';
    return textResponse(`Notiert. Ich schreibe an ${email}.`);
  };
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (req: LlmRequest): Promise<LlmResponse> => answerFor(req),
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      const response = answerFor(req);
      const text = (response.content[0] as { text: string }).text;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text_delta', text } as LlmStreamEvent;
          yield { type: 'final', response } as LlmStreamEvent;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return provider as unknown as LlmProvider;
}

describe('WP-09 — the capture filter scores the masked turn', () => {
  /** A real session logger over the extras capture filter (level `normal`,
   *  the default), with a scorer that keeps what it was sent and an inner
   *  graph that keeps what it stored. */
  function capturePipeline(): {
    sessionLogger: SessionLogger;
    scored: string[];
    stored: TurnIngest[];
  } {
    const scored: string[] = [];
    const stored: TurnIngest[] = [];
    const inner = new InMemoryKnowledgeGraph();
    const recordingInner = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'ingestTurn') {
          return async (turn: TurnIngest) => {
            stored.push(turn);
            return target.ingestTurn(turn);
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const filter = new CaptureFilter({
      captureLevel: 'normal',
      defaultVisibility: 'team',
      significanceThreshold: 0.2,
      significanceScorer: {
        async score(text: string) {
          scored.push(text);
          return { score: 0.9 };
        },
      },
    });
    const graph = new CaptureFilteringKnowledgeGraph({ inner: recordingInner, filter, log: () => {} });
    return { sessionLogger: new SessionLogger(new InMemoryMemoryStore(), graph), scored, stored };
  }

  function assertScoredMasked(
    mainRequests: readonly string[],
    scored: readonly string[],
    stored: readonly TurnIngest[],
  ): void {
    const surrogate = EMAIL_RE.exec(mainRequests[0] ?? '')?.[0];
    assert.ok(surrogate && surrogate !== RAW_EMAIL, 'the model got a surrogate');
    assert.equal(scored.length, 1, 'the stored turn is scored once');
    assert.ok(!scored[0]!.includes(RAW_EMAIL), `the scorer got the real e-mail: ${scored[0]!}`);
    assert.ok(
      scored[0]!.includes(`Ich schreibe an ${surrogate}`),
      'the scorer gets the answer as the model wrote it, surrogate included',
    );
    assert.equal(stored.length, 1);
    assert.ok(stored[0]!.userMessage.includes(RAW_EMAIL), 'the stored message keeps the real value');
    assert.ok(stored[0]!.assistantAnswer.includes(RAW_EMAIL), 'the stored answer is restored');
    assert.equal('maskedView' in stored[0]!, false, 'the masked view is never stored');
  }

  for (const path of ['non-streaming', 'streaming'] as const) {
    it(`${path}: the scorer gets the masked message and the unrestored answer`, async () => {
      const mainRequests: string[] = [];
      const { sessionLogger, scored, stored } = capturePipeline();
      const orch = new Orchestrator({
        provider: echoingStreamProvider(mainRequests),
        model: 'test',
        maxTokens: 1024,
        maxToolIterations: 3,
        domainTools: [],
        nativeToolRegistry: new NativeToolRegistry(),
        sessionLogger,
        privacyGuard: () => maskingService(),
      });
      const input = {
        userMessage: `Bitte schreibe an ${RAW_EMAIL} wegen des Vertrags.`,
        sessionScope: `wp09-score-${path}`,
        userId: 'u1',
      };
      if (path === 'streaming') {
        for await (const ev of orch.chatStream(input)) void ev;
      } else {
        await orch.runTurn(input);
      }
      assertScoredMasked(mainRequests, scored, stored);
    });
  }
});
