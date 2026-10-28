/**
 * #1528 / #1529 — the orchestrator side of the masking edge cases, through the
 * REAL turn pipeline and the REAL privacy-guard service:
 *
 *   - a model that upper-cases the e-mail stand-in still hands the user the
 *     real address (tolerant restore), with no notice;
 *   - a model that reads a name out of the stand-in, where restore has no real
 *     name to put back, gets a notice appended instead of passing the
 *     placeholder off as the user's value;
 *   - the prompt-mask refusal is persisted in both languages and delivered in
 *     the turn's language.
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
import {
  PROMPT_MASK_BLOCKED_ANSWER,
  PSEUDONYM_UNRESOLVED_NOTICE,
  isPromptMaskBlockedNotice,
  localizeRefusalNotice,
} from '@omadia/orchestrator/dist/orchestrator.js';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

const SURROGATE_EMAIL = /[\w.]+@example\.net/;

function maskingService(): ReturnType<typeof createPrivacyGuardService> {
  return createPrivacyGuardService({
    readConfig: (key: string) => (key === 'mask_user_prompt' ? 'on' : undefined),
  });
}

/** Answers with whatever `reply` makes of the e-mail stand-in it was sent. */
function rewritingProvider(requests: string[], reply: (surrogate: string) => string): LlmProvider {
  const provider = {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      promptCaching: true,
      forcedToolChoice: true,
      parallelToolCalls: true,
    },
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      const serialized = JSON.stringify(req);
      requests.push(serialized);
      const surrogate = SURROGATE_EMAIL.exec(serialized)?.[0] ?? 'no-surrogate';
      return {
        content: [{ type: 'text', text: reply(surrogate) }],
        finishReason: 'stop',
        providerFinishReason: 'end_turn',
        model: 'test',
        usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
    stream: (): AsyncIterable<LlmStreamEvent> => {
      throw new Error('rewritingProvider: stream() not scripted');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return provider as unknown as LlmProvider;
}

function orchestratorWith(provider: LlmProvider): Orchestrator {
  return new Orchestrator({
    provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    privacyGuard: () => maskingService(),
  });
}

describe('#1528 rewritten prompt surrogates reach the user restored or flagged', () => {
  it('an upper-cased stand-in comes back as the real address in upper case', async () => {
    const requests: string[] = [];
    const orch = orchestratorWith(
      rewritingProvider(requests, (s) => `In Großbuchstaben: ${s.toUpperCase()}`),
    );
    const result = await orch.runTurn({
      userMessage:
        'Mein Kollege Jonas Weber, jonas.weber@example.com, schreib seine Adresse in GROSSBUCHSTABEN.',
      sessionScope: 'sess-1528-upper',
      userId: 'u1',
    });
    assert.ok(!requests[0]!.includes('jonas.weber@example.com'), 'the real address stays off the wire');
    assert.equal(result.answer, 'In Großbuchstaben: JONAS.WEBER@EXAMPLE.COM');
  });

  it('a name read out of the stand-in that restore cannot map gets the notice', async () => {
    const requests: string[] = [];
    const orch = orchestratorWith(
      rewritingProvider(requests, (s) => {
        const [first, last] = s.split('@')[0]!.split('.');
        const cap = (w: string): string => w[0]!.toUpperCase() + w.slice(1);
        return `Die Adresse gehört ${cap(first!)} ${cap(last!)}.`;
      }),
    );
    const result = await orch.runTurn({
      userMessage: 'Wem gehört jw1984@example.com?',
      sessionScope: 'sess-1528-notice',
      userId: 'u1',
    });
    assert.ok(
      result.answer.endsWith(`\n\n${PSEUDONYM_UNRESOLVED_NOTICE}`),
      `notice expected, got: ${result.answer}`,
    );
  });

  it('a cleanly restored answer carries no notice', async () => {
    const orch = orchestratorWith(rewritingProvider([], (s) => `Notiert: ${s}`));
    const result = await orch.runTurn({
      userMessage: 'Kontakt: jonas.weber@example.com',
      sessionScope: 'sess-1528-clean',
      userId: 'u1',
    });
    assert.equal(result.answer, 'Notiert: jonas.weber@example.com');
  });
});

describe('#1528 / #1529 bilingual notices are delivered in the turn language', () => {
  it('the prompt-mask refusal is persisted bilingual and localized at delivery', () => {
    const de = localizeRefusalNotice(PROMPT_MASK_BLOCKED_ANSWER, 'de');
    const en = localizeRefusalNotice(PROMPT_MASK_BLOCKED_ANSWER, 'en-US');
    assert.match(de, /^Diese Nachricht konnte nicht verarbeitet werden/);
    assert.ok(!de.includes('could not'), de);
    assert.match(en, /^This message could not be processed/);
    assert.ok(!en.includes('Nachricht'), en);
    for (const text of [PROMPT_MASK_BLOCKED_ANSWER, de, en]) {
      assert.ok(isPromptMaskBlockedNotice(text), text);
    }
    assert.ok(!isPromptMaskBlockedNotice(`${de} Noch etwas.`));
  });

  it('the unresolved-placeholder notice follows the same rule', () => {
    const answer = `Antwort.\n\n${PSEUDONYM_UNRESOLVED_NOTICE}`;
    assert.match(localizeRefusalNotice(answer, undefined), /^Antwort\.\n\nHinweis: Das Sprachmodell/);
    assert.match(localizeRefusalNotice(answer, 'en'), /^Antwort\.\n\nNote: the language model/);
  });
});
