/**
 * In `enforce` mode the answer verifier is a delivery gate on the stream:
 *   - nothing that carries answer or tool content (text deltas, tool calls and
 *     results, sub-agent tool traffic, nudges, annotations, canvas surfaces,
 *     the terminal `done`) reaches the consumer before the verdict; liveness,
 *     progress and usage events pass;
 *   - a verdict that confirms the answer (or finds nothing to check) releases
 *     the held events in their original order, the answer the verdict is
 *     about as one text delta, and the verdict on `done`
 *     (`verifierServiceEnforceRelease.test.ts` pins that delta);
 *   - any other verdict — a contradiction, claims left unconfirmed, a
 *     verifier that could not run — withholds the answer: the consumer gets
 *     one notice delta and a `done` marked `answerSource: 'verifier-blocked'`;
 *   - control-flow terminals (choice card, MCP input form, slot picker, OAuth
 *     consent, a degraded turn's notice) are released without verification;
 *     a bare NO_REPLY releases its `done` and nothing else, and an answer that
 *     only ends with NO_REPLY is verified like any other;
 *   - an answer Privacy Shield rendered server-side, degraded or not, never
 *     reaches the verifier pipeline (it holds values the shield kept from the
 *     model) and is withheld; a withheld degraded turn keeps its failure
 *     markers;
 *   - a failed turn releases nothing it held; a contradiction buys one
 *     correction retry, which re-enters the turn over its first run's tool
 *     results (`verifierStreamRetry.test.ts` drives that with real tools)
 *     and is held and judged by the same rule.
 * `shadow` stays the unchanged pass-through, and never verifies a degraded
 * turn.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  ChatStreamEvent,
  ChatStreamObserver,
} from '../packages/harness-channel-sdk/src/chatAgent.js';
import { createVerifierHarness, USER_INPUT } from './_helpers/verifierServiceHarness.js';
import type { ScriptedVerdict } from './_helpers/verifierServiceHarness.js';
import {
  AMOUNT_TEXT,
  approved,
  blocked,
  noneConfirmed,
  partlyChecked,
  skipped,
  unavailable,
} from './_helpers/verifierVerdictFixtures.js';
import {
  ANSWER,
  DISCLOSURE,
  DISCLOSURE_BLOCK,
  LIVE_TYPES,
  deltasOf,
  done,
  doneOf,
  releasedAs,
  turn,
} from './_helpers/verifierStreamScript.js';
import type { DoneEvent } from './_helpers/verifierStreamScript.js';

async function runEnforced(
  verdicts: readonly ScriptedVerdict[],
  script: ChatStreamEvent[] = turn(),
  locale?: string,
) {
  const h = createVerifierHarness({
    mode: 'enforce',
    streams: [script],
    verdicts,
    ...(locale !== undefined ? { locale } : {}),
  });
  const events = await h.stream();
  return { h, events };
}

/**
 * What a withheld turn must look like on the wire, whatever the verdict: the
 * figure nowhere, one delta carrying the notice, and `done.answer` = that
 * notice plus the disclosure block the turn folded (if any).
 */
function assertWithheld(
  events: ChatStreamEvent[],
  label: string,
  disclosureBlock?: string,
): DoneEvent {
  assert.equal(JSON.stringify(events).includes(AMOUNT_TEXT), false, `${label}: the figure leaked`);
  const terminal = doneOf(events);
  assert.ok(terminal, `${label}: a done event`);
  assert.equal(terminal.answerSource, 'verifier-blocked', label);
  assert.equal(terminal.answerIsError, true, label);
  const deltas = deltasOf(events);
  assert.equal(deltas.length, 1, `${label}: exactly one notice delta`);
  const notice = deltas[0] ?? '';
  assert.match(notice, /zurückgehalten|withheld/, label);
  assert.equal(
    terminal.answer,
    disclosureBlock === undefined ? notice : `${notice}\n\n${disclosureBlock}`,
    `${label}: done.answer is the notice`,
  );
  const verifierEvents = events.filter((e) => e.type === 'verifier');
  assert.equal(verifierEvents.length, 1, `${label}: one trailing verifier event`);
  assert.deepEqual(terminal.verifier, (verifierEvents[0] as { summary: unknown }).summary, label);
  assert.equal(events[events.length - 1]?.type, 'verifier', `${label}: verifier comes last`);
  return terminal;
}

describe('VerifierService.chatStream — enforce holds content until the verdict', () => {
  it('the consumer has no content event when the verifier is asked', async () => {
    const { h } = await runEnforced([approved()]);
    assert.equal(h.receivedAtVerify.length, 1);
    assert.deepEqual(h.receivedAtVerify[0], [
      'iteration_start',
      'turn_routing',
      'tool_progress',
      'iteration_usage',
    ]);
  });

  it('an approved verdict releases the held events in order, the answer as one delta, then the verdict', async () => {
    const script = turn();
    const { events } = await runEnforced([approved()], script);
    const summary = events.find((e) => e.type === 'verifier');
    assert.ok(summary && summary.type === 'verifier');
    assert.equal(summary.summary.badge, 'verified');
    assert.deepEqual(events, [...releasedAs(script, { ...done(), verifier: summary.summary }), summary]);
    assert.equal(doneOf(events)?.answerSource, undefined);
  });

  it('a verdict that found nothing to check releases the answer without a badge claim', async () => {
    for (const reason of ['no_trigger', 'no_claims'] as const) {
      const { events, h } = await runEnforced([skipped(reason)]);
      const terminal = doneOf(events);
      assert.equal(terminal?.answer, ANSWER, reason);
      assert.equal(terminal?.answerSource, undefined, reason);
      assert.equal(terminal?.verifier?.badge, 'unverified', reason);
      assert.deepEqual(deltasOf(events), [ANSWER], reason);
      assert.equal(h.receivedAtVerify[0]?.includes('text_delta'), false, reason);
    }
  });
});

describe('VerifierService.chatStream — enforce withholds an answer it could not confirm', () => {
  it('a contradiction delivers one notice and a done marked verifier-blocked', async () => {
    const terminal = done({
      turnId: 'turn:scope-1:1',
      model: 'class:smart',
      receiptId: 'r-1',
      attachments: [{ kind: 'image', url: 'https://files.example/d.png', altText: 'Umsatz', diagramKind: 'bar', cacheHit: false }],
      fileAttachments: [{ kind: 'file', url: 'https://files.example/u.xlsx', altText: 'Umsatz', mediaType: 'application/vnd.ms-excel' }],
      followUpOptions: [{ label: 'Q4?', prompt: `Und Q4 nach ${AMOUNT_TEXT}?` }],
      maskedValues: [AMOUNT_TEXT],
      delegatedAnswer: { agentId: 'a', label: 'Buchhaltung', text: AMOUNT_TEXT, status: 'success' },
      agentsConsulted: [{ label: 'Buchhaltung', status: 'success', toolCalls: 1 }],
      directLineSession: { active: false },
      // The orchestrator also sets these two, outside the SDK type.
      ...({ palaiaExcerpt: { text: AMOUNT_TEXT }, autoPromotedMkId: 'mk-1' } as unknown as Partial<DoneEvent>),
    });
    const { h, events } = await runEnforced([blocked()], turn(terminal));
    const withheld = assertWithheld(events, 'blocked');

    assert.match(withheld.answer, /Widerspruch/, 'names the contradiction');
    assert.equal(withheld.verifier?.status, 'blocked');
    assert.equal(withheld.verifier?.badge, 'failed');
    assert.equal(withheld.verifier?.mode, 'enforce');
    for (const key of [
      'attachments',
      'fileAttachments',
      'followUpOptions',
      'maskedValues',
      'delegatedAnswer',
      'palaiaExcerpt',
      'autoPromotedMkId',
    ]) {
      assert.equal(key in withheld, false, `${key} is stripped`);
    }
    assert.equal(withheld.turnId, 'turn:scope-1:1');
    assert.equal(withheld.model, 'class:smart');
    assert.equal(withheld.receiptId, 'r-1');
    assert.equal(withheld.toolCalls, 1);
    assert.deepEqual(withheld.agentsConsulted, terminal.agentsConsulted);
    assert.deepEqual(withheld.directLineSession, { active: false });

    // The stream path records the block, runs ONE correction retry (here
    // contradicted again, so the notice goes out) and stores the final
    // verdict once.
    assert.deepEqual(h.hookPoints, ['onVerifierBlocked']);
    assert.deepEqual(h.persisted, [{ status: 'blocked', retryCount: 1, mode: 'enforce' }]);
    assert.equal(h.streamCalls.length, 2);
    assert.equal(h.reentries.length, 1);
    assert.match(h.streamCalls[1]?.input.extraSystemHint ?? '', /\S/, 'the retry carries the correction hint');
  });

  it('fails closed: unavailable, partly checked and unconfirmed verdicts withhold too', async () => {
    const cases: [string, ScriptedVerdict, RegExp][] = [
      ['pipeline error', new Error('pipeline down'), /technischen Störung nicht abgeschlossen/],
      ['extractor outage', unavailable(), /technischen Störung nicht abgeschlossen/],
      ['partly checked', partlyChecked(), /nicht alle Angaben ließen sich/i],
      ['none confirmed', noneConfirmed(), /nicht alle Angaben ließen sich/i],
      ['no checkable claims', skipped('no_checkable_claims'), /nicht alle Angaben ließen sich/i],
      ['incomplete coverage', skipped('incomplete_coverage'), /nicht alle Angaben ließen sich/i],
    ];
    for (const [label, verdict, why] of cases) {
      const { events, h } = await runEnforced([verdict]);
      const withheld = assertWithheld(events, label);
      assert.match(withheld.answer, why, label);
      assert.equal(h.hookPoints.length, 0, `${label}: no contradiction, no block hook`);
    }
  });

  it('keeps the disclosure the turn folded on done.answer only, never in the delta', async () => {
    const folded = done({ aiDisclosure: DISCLOSURE }, `${ANSWER}\n\n${DISCLOSURE_BLOCK}`);
    const events = (await runEnforced([blocked()], turn(folded))).events;
    const withheld = assertWithheld(events, 'folded', DISCLOSURE_BLOCK);
    assert.equal(deltasOf(events)[0]?.includes(DISCLOSURE.text), false, 'never in the delta');
    assert.deepEqual(withheld.aiDisclosure, DISCLOSURE);

    // A later turn of the scope did not fold the line: neither does the notice.
    const unfolded = done({ aiDisclosure: DISCLOSURE });
    const later = assertWithheld((await runEnforced([blocked()], turn(unfolded))).events, 'later');
    assert.equal(later.answer.includes(DISCLOSURE.text), false);
    assert.deepEqual(later.aiDisclosure, DISCLOSURE);
  });

  it('words the notice in the turn locale, then the operator locale, German by default', async () => {
    const english = { ...DISCLOSURE, locale: 'en', text: 'This response was generated by an AI system.' };
    const byTurn = doneOf((await runEnforced([blocked()], turn(done({ aiDisclosure: english })))).events);
    assert.match(byTurn?.answer ?? '', /withheld/);
    const byOperator = doneOf((await runEnforced([blocked()], turn(), 'en')).events);
    assert.match(byOperator?.answer ?? '', /withheld/);
    const byDefault = doneOf((await runEnforced([blocked()], turn())).events);
    assert.match(byDefault?.answer ?? '', /zurückgehalten/);
  });
});

describe('VerifierService.chatStream — enforce release rules without a verdict', () => {
  it('releases control-flow terminals unverified, with the text of their own answer', async () => {
    const terminals: [string, DoneEvent][] = [
      ['choice card', done({ pendingUserChoice: { question: 'Welches Quartal?', options: [{ label: 'Q3', value: 'q3' }] } })],
      [
        'MCP input form',
        done({
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
        done({
          pendingSlotCard: {
            question: 'Welcher Termin?',
            slots: [{ slotId: 's1', start: '2026-10-02T09:00:00Z', end: '2026-10-02T09:30:00Z', timeZone: 'UTC', label: 'Fr 9:00', confidence: 1 }],
          },
        }),
      ],
      ['OAuth consent', done({ pendingOAuthConsent: true })],
      ['degraded turn', done({ degraded: true, committedTools: ['create_invoice'], correlationId: 'corr-2' })],
    ];
    for (const [label, terminal] of terminals) {
      const script = turn(terminal);
      const { events, h } = await runEnforced([blocked()], script);
      assert.equal(h.verifyInputs.length, 0, `${label}: not verified`);
      assert.deepEqual(events, releasedAs(script, terminal), `${label}: released`);
    }
  });

  it('a bare NO_REPLY releases its done and nothing the turn held', async () => {
    for (const answer of ['NO_REPLY', '  NO_REPLY\n']) {
      const script = turn(done({}, answer));
      const { events, h } = await runEnforced([blocked()], script);
      assert.equal(h.verifyInputs.length, 0, 'not verified');
      assert.deepEqual(events, [...script.filter((e) => LIVE_TYPES.has(e.type)), done({}, answer)]);
      assert.equal(JSON.stringify(events).includes(AMOUNT_TEXT), false, 'tool content stays held');
    }
  });

  it('an answer that only ends with NO_REPLY is verified, and withheld like any other', async () => {
    const { events, h } = await runEnforced([blocked()], turn(done({}, `${ANSWER}\nNO_REPLY`)));
    // Verified, and — contradicted like any other answer — re-verified after
    // its correction retry.
    assert.equal(h.verifyInputs.length, 2, 'verified, then the retry');
    assert.equal(h.verifyInputs[0]?.answer, `${ANSWER}\nNO_REPLY`);
    assertWithheld(events, 'trailing NO_REPLY');
  });

  it('never sends an answer the privacy shield rendered to the verifier, and withholds it', async () => {
    const cases: [string, DoneEvent][] = [
      ['rendered', done({ answerSource: 'privacy-render', maskedValues: [AMOUNT_TEXT] })],
      [
        'rendered, then degraded',
        done({
          degraded: true,
          committedTools: ['v4_render_answer'],
          correlationId: 'corr-4',
          answerSource: 'privacy-render',
        }),
      ],
    ];
    for (const [label, terminal] of cases) {
      // The pipeline would approve it; it must not be asked at all.
      const { events, h } = await runEnforced([approved()], turn(terminal));
      assert.equal(h.verifyInputs.length, 0, `${label}: never sent to the verifier`);
      const withheld = assertWithheld(events, label);
      // Not a technical fault: the answer was never handed to the check.
      assert.match(withheld.answer, /der Faktenprüfung nicht übergeben/, `${label}: the check could not run`);
      assert.doesNotMatch(withheld.answer, /technische/, `${label}: no fault claimed`);
      assert.equal(withheld.verifier?.status, 'unavailable', label);
      assert.equal(withheld.verifier?.reason, 'privacy_shield', label);
      assert.equal(withheld.verifier?.badge, 'unavailable', label);
      assert.deepEqual(h.persisted, [{ status: 'unavailable', retryCount: 0, mode: 'enforce' }], label);
    }
  });

  it('a withheld degraded turn keeps the markers that report its failure', async () => {
    const rendered = done({
      degraded: true,
      committedTools: ['create_invoice', 'v4_render_answer'],
      correlationId: 'corr-4',
      answerSource: 'privacy-render',
    });
    const withheld = assertWithheld((await runEnforced([approved()], turn(rendered))).events, 'degraded');
    assert.equal(withheld.degraded, true);
    assert.deepEqual(withheld.committedTools, ['create_invoice', 'v4_render_answer']);
    assert.equal(withheld.correlationId, 'corr-4');

    const ordinary = assertWithheld((await runEnforced([blocked()])).events, 'not degraded');
    assert.equal('degraded' in ordinary, false);
    assert.equal('committedTools' in ordinary, false);
  });

  it('a failed turn releases nothing it held', async () => {
    const script: ChatStreamEvent[] = [
      { type: 'iteration_start', iteration: 1 },
      { type: 'text_delta', text: `Der Umsatz beträgt ${AMOUNT_TEXT}` },
      { type: 'tool_use', id: 't1', name: 'query_odoo_accounting', input: {} },
      { type: 'tool_result', id: 't1', output: AMOUNT_TEXT, durationMs: 3 },
      { type: 'error', message: 'provider unavailable', correlationId: 'corr-3' },
    ];
    const { events, h } = await runEnforced([approved()], script);
    assert.deepEqual(events, [script[0], script[4]]);
    assert.equal(h.verifyInputs.length, 0);
  });
});

describe('VerifierService.chatStream — observer and the unchanged modes', () => {
  it('forwards the route observer to the orchestrator in every mode', async () => {
    const observer: ChatStreamObserver = { onIteration: () => undefined };
    for (const opts of [
      { mode: 'enforce' as const },
      { mode: 'shadow' as const },
      { mode: 'enforce' as const, enabled: false },
    ]) {
      const h = createVerifierHarness({ ...opts, streams: [turn()], verdicts: [approved()] });
      await h.stream(USER_INPUT, observer);
      assert.equal(h.streamCalls[0]?.observer, observer, JSON.stringify(opts));
    }
  });

  it('declares that it holds content until the verdict only when enforce is on', () => {
    const holds = (mode: 'shadow' | 'enforce', enabled = true): boolean | undefined =>
      createVerifierHarness({ mode, enabled, verdicts: [approved()] }).service.holdsContentUntilVerdict;
    assert.equal(holds('enforce'), true);
    assert.equal(holds('shadow'), false);
    assert.equal(holds('enforce', false), false);
  });

  it('a disabled verifier passes the stream through untouched, whatever the mode', async () => {
    const script = turn();
    const h = createVerifierHarness({ mode: 'enforce', enabled: false, streams: [script], verdicts: [blocked()] });
    assert.deepEqual(await h.stream(), script);
    assert.equal(h.verifyInputs.length, 0);
  });

  it('shadow still streams everything as produced and reports the verdict afterwards', async () => {
    const script = turn();
    const h = createVerifierHarness({ mode: 'shadow', streams: [script], verdicts: [blocked()] });
    const events = await h.stream();
    assert.deepEqual(events.slice(0, script.length), script);
    assert.equal(events[script.length]?.type, 'verifier');
    assert.equal(events.length, script.length + 1);
    assert.ok(h.receivedAtVerify[0]?.includes('text_delta'), 'shadow delivers before the verdict');
    assert.ok(h.receivedAtVerify[0]?.includes('done'));
  });

  it('shadow never verifies a degraded turn, rendered by the privacy shield or not', async () => {
    for (const terminal of [
      done({ degraded: true, committedTools: ['create_invoice'] }),
      done({ degraded: true, committedTools: ['v4_render_answer'], answerSource: 'privacy-render' }),
    ]) {
      const script = turn(terminal);
      const h = createVerifierHarness({ mode: 'shadow', streams: [script], verdicts: [approved()] });
      assert.deepEqual(await h.stream(), script);
      assert.equal(h.verifyInputs.length, 0);
    }
  });
});
