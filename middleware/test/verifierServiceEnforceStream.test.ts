/**
 * In `enforce` mode the answer verifier is a delivery gate on the stream:
 *   - nothing that carries answer or tool content (text deltas, tool calls and
 *     results, sub-agent tool traffic, nudges, annotations, canvas surfaces,
 *     the terminal `done`) reaches the consumer before the verdict; liveness,
 *     progress and usage events pass;
 *   - a verdict that confirms the answer (or finds nothing to check) releases
 *     the held events in their original order, with the verdict on `done`;
 *   - any other verdict — a contradiction, claims left unconfirmed, a
 *     verifier that could not run — withholds the answer: the consumer gets
 *     one notice delta and a `done` marked `answerSource: 'verifier-blocked'`;
 *   - control-flow terminals (choice card, MCP input form, slot picker, OAuth
 *     consent, degraded turn, NO_REPLY) are released without verification;
 *   - a failed turn releases nothing it held, and the stream path never
 *     starts a correction retry.
 * `shadow` stays the unchanged pass-through.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { RevisionId } from '../packages/harness-channel-sdk/src/surface.js';
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

type DoneEvent = Extract<ChatStreamEvent, { type: 'done' }>;

const ANSWER = `Der Umsatz im dritten Quartal beträgt ${AMOUNT_TEXT}.`;

/** Events in the script below that reach the consumer while the verdict is
 *  pending. `sub_iteration` is held with its parent `tool_use`. */
const LIVE_TYPES = new Set([
  'iteration_start',
  'turn_routing',
  'tool_progress',
  'iteration_usage',
]);

const DISCLOSURE = {
  text: 'Diese Antwort wurde von einem KI-System erzeugt.',
  level: 'standard' as const,
  locale: 'de',
  source: 'operator' as const,
  operatorNote: 'Bei Fragen: Support-Team.',
};

function done(extra: Partial<DoneEvent> = {}, answer = ANSWER): DoneEvent {
  return { type: 'done', answer, toolCalls: 1, iterations: 1, ...extra };
}

/** A full turn: live telemetry interleaved with content that states the
 *  figure the verdict is about. */
function turn(terminal: DoneEvent = done()): ChatStreamEvent[] {
  return [
    { type: 'iteration_start', iteration: 1 },
    { type: 'turn_routing', bucket: 'complex', classifierModel: 'class:fast', model: 'class:smart' },
    { type: 'tool_use', id: 't1', name: 'query_odoo_accounting', input: { question: 'Umsatz Q3' } },
    { type: 'tool_progress', id: 't1', elapsedMs: 5000 },
    { type: 'sub_iteration', parentId: 't1', iteration: 1 },
    { type: 'sub_tool_use', parentId: 't1', id: 's1', name: 'odoo_execute', input: { model: 'account.move' } },
    { type: 'sub_tool_result', parentId: 't1', id: 's1', output: `amount_total ${AMOUNT_TEXT}`, durationMs: 40, isError: false },
    { type: 'tool_result', id: 't1', output: `Umsatz Q3: ${AMOUNT_TEXT}`, durationMs: 900 },
    { type: 'nudge', id: 't1', nudgeId: 'n1', text: `${AMOUNT_TEXT} als Notiz speichern?` },
    {
      type: 'iteration_usage',
      iteration: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    { type: 'turn_annotation', channel: 'kg_insert', payload: { nodes: [{ id: 'k1', label: AMOUNT_TEXT }] } },
    {
      type: 'surface_snapshot',
      canvasSessionId: 'canvas-1',
      surfaceSeq: 1,
      producesRevision: '1' as RevisionId,
      tree: { type: 'text', content: AMOUNT_TEXT },
      protocolVersion: '1.0',
      opsCatalogVersion: '1.0',
    },
    { type: 'text_delta', text: 'Der Umsatz im dritten Quartal ' },
    { type: 'text_delta', text: `beträgt ${AMOUNT_TEXT}.` },
    terminal,
  ];
}

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

const doneOf = (events: ChatStreamEvent[]): DoneEvent | undefined =>
  events.find((e): e is DoneEvent => e.type === 'done');
const deltasOf = (events: ChatStreamEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : []));

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

  it('an approved verdict releases the held events verbatim and in order, then the verdict', async () => {
    const script = turn();
    const { events } = await runEnforced([approved()], script);
    const live = script.filter((e) => LIVE_TYPES.has(e.type));
    const held = script.filter((e) => !LIVE_TYPES.has(e.type));
    const summary = events.find((e) => e.type === 'verifier');
    assert.ok(summary && summary.type === 'verifier');
    assert.equal(summary.summary.badge, 'verified');
    assert.deepEqual(events, [
      ...live,
      ...held.slice(0, -1),
      { ...done(), verifier: summary.summary },
      summary,
    ]);
    assert.equal(doneOf(events)?.answerSource, undefined);
  });

  it('a verdict that found nothing to check releases the answer without a badge claim', async () => {
    for (const reason of ['no_trigger', 'no_claims'] as const) {
      const { events, h } = await runEnforced([skipped(reason)]);
      const terminal = doneOf(events);
      assert.equal(terminal?.answer, ANSWER, reason);
      assert.equal(terminal?.answerSource, undefined, reason);
      assert.equal(terminal?.verifier?.badge, 'unverified', reason);
      assert.deepEqual(deltasOf(events), ['Der Umsatz im dritten Quartal ', `beträgt ${AMOUNT_TEXT}.`]);
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

    // The stream path records the block and stores the verdict once — and
    // never starts a correction retry (it would re-run the turn's tools).
    assert.deepEqual(h.hookPoints, ['onVerifierBlocked']);
    assert.deepEqual(h.persisted, [{ status: 'blocked', retryCount: 0, mode: 'enforce' }]);
    assert.equal(h.streamCalls.length, 1);
    assert.equal(h.reentries.length, 0);
  });

  it('fails closed: unavailable, partly checked and unconfirmed verdicts withhold too', async () => {
    const cases: [string, ScriptedVerdict, RegExp][] = [
      ['pipeline error', new Error('pipeline down'), /abgeschlossen/],
      ['extractor outage', unavailable(), /abgeschlossen/],
      ['partly checked', partlyChecked(), /bestätigen/],
      ['none confirmed', noneConfirmed(), /bestätigen/],
      ['no checkable claims', skipped('no_checkable_claims'), /bestätigen/],
      ['incomplete coverage', skipped('incomplete_coverage'), /bestätigen/],
    ];
    for (const [label, verdict, why] of cases) {
      const { events, h } = await runEnforced([verdict]);
      const withheld = assertWithheld(events, label);
      assert.match(withheld.answer, why, label);
      assert.equal(h.hookPoints.length, 0, `${label}: no contradiction, no block hook`);
    }
  });

  it('keeps the disclosure the turn folded on done.answer only, never in the delta', async () => {
    const block = `${DISCLOSURE.text}\n\n${DISCLOSURE.operatorNote}`;
    const folded = done({ aiDisclosure: DISCLOSURE }, `${ANSWER}\n\n${block}`);
    const events = (await runEnforced([blocked()], turn(folded))).events;
    const withheld = assertWithheld(events, 'folded', block);
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
  it('releases control-flow terminals unverified and unchanged', async () => {
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
      ['NO_REPLY', done({}, 'NO_REPLY')],
    ];
    for (const [label, terminal] of terminals) {
      const script = turn(terminal);
      const { events, h } = await runEnforced([blocked()], script);
      assert.equal(h.verifyInputs.length, 0, `${label}: not verified`);
      const live = script.filter((e) => LIVE_TYPES.has(e.type));
      const held = script.filter((e) => !LIVE_TYPES.has(e.type));
      assert.deepEqual(events, [...live, ...held], `${label}: released as produced`);
    }
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
});
