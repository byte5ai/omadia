/**
 * What `enforce` releases as text. The verifier judges `done.answer`; the
 * text deltas the orchestrator streamed can say more than that answer. A
 * response it discards and re-runs — a pure-text answer that skipped an
 * obligatory sub-agent consult (#332 layer 3), a file it announced but did
 * not build — has already been streamed as deltas when it is discarded, and
 * its text is not in `done.answer`. So a released turn never replays the raw
 * deltas: it carries the text of `done.answer` (without the disclosure block
 * a first turn folds into it) as one delta, right before `done`. The same
 * holds for turns released without a verdict.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { ChatStreamEvent } from '../packages/harness-channel-sdk/src/chatAgent.js';
import { createVerifierHarness } from './_helpers/verifierServiceHarness.js';
import type { ScriptedVerdict } from './_helpers/verifierServiceHarness.js';
import { AMOUNT_TEXT, approved, blocked } from './_helpers/verifierVerdictFixtures.js';
import {
  ANSWER,
  DISCLOSURE,
  DISCLOSURE_BLOCK,
  deltasOf,
  done,
  doneOf,
  releasedAs,
  turn,
} from './_helpers/verifierStreamScript.js';
import type { DoneEvent } from './_helpers/verifierStreamScript.js';

/** The figure of the response the orchestrator discarded. */
const DISCARDED = '7.000.000 €';

const FINAL = `Laut Buchhaltung beträgt der Umsatz im dritten Quartal ${AMOUNT_TEXT}.`;

/** A turn whose first response is streamed, then discarded and re-run. */
function rerunTurn(terminal: DoneEvent): ChatStreamEvent[] {
  return [
    { type: 'iteration_start', iteration: 1 },
    { type: 'text_delta', text: `Der Umsatz beträgt ${DISCARDED}.` },
    { type: 'iteration_start', iteration: 2 },
    { type: 'tool_use', id: 't1', name: 'ask_buchhaltung', input: { question: 'Umsatz Q3' } },
    { type: 'tool_result', id: 't1', output: `Umsatz Q3: ${AMOUNT_TEXT}`, durationMs: 900 },
    { type: 'iteration_start', iteration: 3 },
    { type: 'text_delta', text: 'Laut Buchhaltung beträgt der Umsatz im dritten Quartal ' },
    { type: 'text_delta', text: `${AMOUNT_TEXT}.` },
    terminal,
  ];
}

async function runEnforced(verdicts: readonly ScriptedVerdict[], script: ChatStreamEvent[]) {
  const h = createVerifierHarness({ mode: 'enforce', streams: [script], verdicts });
  return { h, events: await h.stream() };
}

const verifierEventOf = (events: readonly ChatStreamEvent[]) =>
  events.find((e): e is Extract<ChatStreamEvent, { type: 'verifier' }> => e.type === 'verifier');

describe('VerifierService.chatStream — enforce releases the text the verdict is about', () => {
  it('a response the orchestrator discarded never reaches the client, even when the final answer is approved', async () => {
    const script = rerunTurn(done({}, FINAL));
    const { events, h } = await runEnforced([approved()], script);
    assert.equal(h.verifyInputs[0]?.answer, FINAL, 'the verdict is about the final answer');
    assert.equal(JSON.stringify(events).includes(DISCARDED), false, 'the discarded figure leaked');
    assert.deepEqual(deltasOf(events), [FINAL]);
    const summary = verifierEventOf(events);
    assert.ok(summary);
    assert.deepEqual(events, [...releasedAs(script, { ...done({}, FINAL), verifier: summary.summary }), summary]);
  });

  it('the released delta is the answer without the disclosure block the turn folded', async () => {
    const folded = done({ aiDisclosure: DISCLOSURE }, `${ANSWER}\n\n${DISCLOSURE_BLOCK}`);
    const { events } = await runEnforced([approved()], turn(folded));
    assert.deepEqual(deltasOf(events), [ANSWER]);
    assert.equal(doneOf(events)?.answer, `${ANSWER}\n\n${DISCLOSURE_BLOCK}`, 'done.answer unchanged');

    // A turn whose answer is the disclosure block alone streams no delta.
    const onlyBlock = done({ aiDisclosure: DISCLOSURE }, DISCLOSURE_BLOCK);
    const bare = await runEnforced([approved()], turn(onlyBlock));
    assert.deepEqual(deltasOf(bare.events), []);
    assert.equal(doneOf(bare.events)?.answer, DISCLOSURE_BLOCK);
  });

  it('a later turn that did not fold the disclosure releases its answer whole', async () => {
    const unfolded = done({ aiDisclosure: DISCLOSURE });
    const { events } = await runEnforced([approved()], turn(unfolded));
    assert.deepEqual(deltasOf(events), [ANSWER]);
  });
});

describe('VerifierService.chatStream — enforce releases without a verdict carry their own answer', () => {
  it('a choice card releases its own text, not the response streamed before it', async () => {
    const card = done(
      { pendingUserChoice: { question: 'Welches Quartal?', options: [{ label: 'Q3', value: 'q3' }] } },
      'Welches Quartal meinst du?',
    );
    const script = rerunTurn(card);
    const { events, h } = await runEnforced([blocked()], script);
    assert.equal(h.verifyInputs.length, 0, 'released without a verdict');
    assert.equal(JSON.stringify(events).includes(DISCARDED), false, 'the discarded figure leaked');
    assert.deepEqual(deltasOf(events), ['Welches Quartal meinst du?']);
    assert.deepEqual(events, releasedAs(script, card));
  });

  it('a degraded turn releases the server notice, not the partial text it streamed', async () => {
    const notice = 'Die Anfrage wurde nicht abgeschlossen. Bereits ausgeführt: create_invoice.';
    const degraded = done({ degraded: true, committedTools: ['create_invoice'], correlationId: 'corr-2' }, notice);
    const { events, h } = await runEnforced([blocked()], rerunTurn(degraded));
    assert.equal(h.verifyInputs.length, 0, 'released without a verdict');
    assert.equal(JSON.stringify(events).includes(DISCARDED), false, 'the partial figure leaked');
    assert.deepEqual(deltasOf(events), [notice]);
    assert.equal(doneOf(events)?.answer, notice);
  });
});
