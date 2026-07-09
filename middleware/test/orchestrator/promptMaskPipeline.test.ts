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
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';
import { FactExtractor } from '@omadia/orchestrator-extras';
import type { FactIngest, KnowledgeGraph } from '@omadia/plugin-api';
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
});
