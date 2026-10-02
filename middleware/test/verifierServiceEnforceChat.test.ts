/**
 * The non-streaming path (`VerifierService.chat`, used by Teams, Telegram and
 * `/api/chat`) follows the same delivery rule as the stream in `enforce`
 * mode: an answer the verifier could not confirm — still contradicted after
 * the correction retry, partly checked, unconfirmed, or not checkable because
 * the verifier failed — is replaced by the withheld notice, marked
 * `answerSource: 'verifier-blocked'` + `answerIsError`, without the
 * attachments, cards and follow-ups that carried its claims. Control-flow
 * results (choice card, MCP input form, slot picker, OAuth consent, a bare
 * NO_REPLY) are delivered without verification; an answer that only ends
 * with NO_REPLY is verified like any answer. An answer Privacy Shield
 * rendered server-side — first answer, resample or retry — never reaches the
 * verifier pipeline and is withheld. `shadow` still delivers the answer.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { SemanticAnswer } from '@omadia/channel-sdk';

import type { ChatTurnResult } from '../packages/harness-channel-sdk/src/chatAgent.js';
import { createVerifierHarness } from './_helpers/verifierServiceHarness.js';
import type { ScriptedVerdict, VerifierHarness } from './_helpers/verifierServiceHarness.js';
import {
  AMOUNT_TEXT,
  approved,
  blocked,
  borderline,
  partlyChecked,
  skipped,
  unavailable,
} from './_helpers/verifierVerdictFixtures.js';

const ANSWER = `Der Umsatz im dritten Quartal beträgt ${AMOUNT_TEXT}.`;
const CORRECTED = 'Der Umsatz im dritten Quartal beträgt 4.100.000 €.';

function result(extra: Partial<ChatTurnResult> = {}, answer = ANSWER): ChatTurnResult {
  return {
    answer,
    toolCalls: 1,
    iterations: 1,
    turnId: 'turn:scope-1:1',
    attachments: [{ kind: 'image', url: 'https://files.example/d.png', altText: 'Umsatz', diagramKind: 'bar', cacheHit: false }],
    fileAttachments: [{ kind: 'file', url: 'https://files.example/u.xlsx', altText: 'Umsatz', mediaType: 'application/vnd.ms-excel' }],
    followUpOptions: [{ label: 'Q4?', prompt: `Und Q4 nach ${AMOUNT_TEXT}?` }],
    maskedValues: [AMOUNT_TEXT],
    delegatedAnswer: { agentId: 'a', label: 'Buchhaltung', text: AMOUNT_TEXT, status: 'success' },
    pendingRoutineList: { filter: 'all', totals: { all: 0, active: 0, paused: 0 }, routines: [] },
    ...extra,
  };
}

async function chatEnforced(
  verdicts: readonly ScriptedVerdict[],
  results: readonly ChatTurnResult[] = [result()],
  opts: { maxRetries?: number; locale?: string } = {},
): Promise<{ h: VerifierHarness; sa: SemanticAnswer }> {
  const h = createVerifierHarness({ mode: 'enforce', results, verdicts, ...opts });
  const sa = await h.service.chat({ userMessage: 'Wie hoch war der Umsatz?', sessionScope: 'scope-1' });
  return { h, sa };
}

/** A withheld answer: the notice, the markers, none of the answer's content. */
function assertWithheld(sa: SemanticAnswer, label: string): void {
  assert.equal(JSON.stringify(sa).includes(AMOUNT_TEXT), false, `${label}: the figure leaked`);
  assert.match(sa.text, /zurückgehalten|withheld/, label);
  assert.equal(sa.answerSource, 'verifier-blocked', label);
  assert.equal(sa.answerIsError, true, label);
  for (const key of ['attachments', 'followUps', 'interactive', 'maskedValues', 'delegatedAnswer']) {
    assert.equal(key in sa, false, `${label}: ${key} is stripped`);
  }
}

describe('VerifierService.chat — enforce withholds what it could not confirm', () => {
  it('a turn still contradicted after the retry delivers the notice, never the answer', async () => {
    const { h, sa } = await chatEnforced([blocked(), blocked()], [result(), result()]);
    assertWithheld(sa, 'blocked twice');
    assert.match(sa.text, /Widerspruch/);
    assert.deepEqual(sa.verifier, { status: 'failed' });
    // The existing correction retry still runs once, exempt from inbound
    // screening by identity, and one row records the final verdict.
    assert.equal(h.runTurnInputs.length, 2);
    assert.equal(h.reentries.length, 1);
    assert.equal(h.reentries[0], h.runTurnInputs[1]);
    assert.deepEqual(h.persisted, [{ status: 'blocked', retryCount: 1, mode: 'enforce' }]);
  });

  it('withholds at once when no retry is allowed', async () => {
    const { h, sa } = await chatEnforced([blocked()], [result()], { maxRetries: 0 });
    assertWithheld(sa, 'no retry');
    assert.equal(h.runTurnInputs.length, 1);
  });

  it('fails closed: unavailable, partly checked and unconfirmed verdicts withhold too', async () => {
    const cases: [string, ScriptedVerdict][] = [
      ['pipeline error', new Error('pipeline down')],
      ['extractor outage', unavailable()],
      ['partly checked', partlyChecked()],
      ['no checkable claims', skipped('no_checkable_claims')],
      ['incomplete coverage', skipped('incomplete_coverage')],
    ];
    for (const [label, verdict] of cases) {
      const { sa } = await chatEnforced([verdict]);
      assertWithheld(sa, label);
    }
  });

  it('control: a corrected retry and an answer with nothing to check are delivered', async () => {
    const corrected = await chatEnforced([blocked(), approved()], [result(), result({}, CORRECTED)]);
    assert.equal(corrected.sa.text, CORRECTED);
    assert.deepEqual(corrected.sa.verifier, { status: 'corrected' });
    assert.equal(corrected.sa.answerSource, undefined);

    const smallTalk = await chatEnforced([skipped('no_trigger')]);
    assert.equal(smallTalk.sa.text, ANSWER);
    assert.equal(smallTalk.sa.answerSource, undefined);
    assert.equal(smallTalk.sa.attachments?.length, 2);
  });

  it('delivers control-flow results without verification', async () => {
    const results: [string, ChatTurnResult][] = [
      ['choice card', result({ pendingUserChoice: { question: 'Welches Quartal?', options: [{ label: 'Q3', value: 'q3' }] } })],
      [
        'MCP input form',
        result({
          pendingMcpInput: {
            correlationId: 'corr-1',
            serverName: 'Buchhaltung',
            serverId: 'srv-1',
            toolName: 'lookup',
            fields: [{ name: 'period' }],
          },
        }),
      ],
      [
        'slot picker',
        result({
          pendingSlotCard: {
            question: 'Welcher Termin?',
            slots: [{ slotId: 's1', start: '2026-10-02T09:00:00Z', end: '2026-10-02T09:30:00Z', timeZone: 'UTC', label: 'Fr 9:00', confidence: 1 }],
          },
        }),
      ],
      ['OAuth consent', result({ pendingOAuthConsent: true })],
      ['NO_REPLY', result({}, 'NO_REPLY')],
    ];
    for (const [label, r] of results) {
      const { h, sa } = await chatEnforced([blocked()], [r], { maxRetries: 0 });
      assert.equal(h.verifyInputs.length, 0, `${label}: not verified`);
      assert.equal(sa.answerSource, undefined, `${label}: not withheld`);
      assert.ok(sa.text.startsWith(r.answer), `${label}: answer delivered`);
    }
  });

  it('never sends an answer the privacy shield rendered to the verifier, and withholds it', async () => {
    // The pipeline would approve it; it must not be asked at all.
    const { h, sa } = await chatEnforced([approved()], [result({ answerSource: 'privacy-render' })]);
    assert.equal(h.verifyInputs.length, 0, 'never sent to the verifier');
    assertWithheld(sa, 'rendered');
    assert.match(sa.text, /abgeschlossen/);
    assert.deepEqual(h.persisted, [{ status: 'unavailable', retryCount: 0, mode: 'enforce' }]);
  });

  it('nor a rendered correction retry or resample', async () => {
    const rendered = result({ answerSource: 'privacy-render' }, CORRECTED);

    const retried = await chatEnforced([blocked(), approved()], [result(), rendered]);
    assert.equal(retried.h.runTurnInputs.length, 2, 'the retry ran');
    assert.equal(retried.h.verifyInputs.length, 1, 'only the first answer was verified');
    assertWithheld(retried.sa, 'rendered retry');
    assert.equal(retried.sa.text.includes('4.100.000'), false, 'the retry answer stays withheld');
    assert.deepEqual(retried.h.persisted, [{ status: 'unavailable', retryCount: 1, mode: 'enforce' }]);

    const resampled = await chatEnforced([borderline(), approved()], [result(), rendered]);
    assert.equal(resampled.h.runTurnInputs.length, 2, 'the resample ran');
    assert.equal(resampled.h.verifyInputs.length, 1, 'only the first answer was verified');
    assertWithheld(resampled.sa, 'rendered resample');
  });

  it('verifies an answer that only ends with NO_REPLY, and withholds it like any other', async () => {
    const { h, sa } = await chatEnforced([blocked()], [result({}, `${ANSWER}\nNO_REPLY`)], { maxRetries: 0 });
    assert.equal(h.verifyInputs.length, 1, 'verified');
    assert.equal(h.verifyInputs[0]?.answer, `${ANSWER}\nNO_REPLY`);
    assertWithheld(sa, 'trailing NO_REPLY');
  });

  it('words the notice in the turn locale, then the operator locale', async () => {
    const english = {
      text: 'This response was generated by an AI system.',
      level: 'standard' as const,
      locale: 'en',
      source: 'operator' as const,
    };
    const byTurn = await chatEnforced([blocked()], [result({ aiDisclosure: english })], { maxRetries: 0 });
    assert.match(byTurn.sa.text, /^This answer was withheld/);
    // The disclosure still marks the notice, as it marks every answer.
    assert.ok(byTurn.sa.text.endsWith(english.text));
    assert.deepEqual(byTurn.sa.aiDisclosure, english);

    const byOperator = await chatEnforced([blocked()], [result()], { maxRetries: 0, locale: 'en' });
    assert.match(byOperator.sa.text, /^This answer was withheld/);
  });
});

describe('VerifierService.chat — shadow is unchanged', () => {
  it('delivers the answer with its badge whatever the verdict', async () => {
    const h = createVerifierHarness({ mode: 'shadow', results: [result()], verdicts: [blocked()] });
    const sa = await h.service.chat({ userMessage: 'Wie hoch war der Umsatz?' });
    assert.equal(sa.text, ANSWER);
    assert.deepEqual(sa.verifier, { status: 'failed' });
    assert.equal(sa.answerSource, undefined);
    assert.equal(h.runTurnInputs.length, 1);
  });
});
