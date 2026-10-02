/**
 * The `enforce` stream retries a contradicted answer once, over the first
 * run's tool results — it never runs a tool handler twice for one request.
 *
 * The stream path used to withhold a contradicted answer without a retry,
 * because a retry re-ran the whole turn including its tool calls. With the
 * per-request replay ledger the correction retry re-generates the answer over
 * the first run's frozen tool results: the write the first run made is
 * replayed, a write it did not make abandons the retry, and the enforce release
 * rule still decides what the consumer gets (an answer only when the retry's
 * verdict releases it; otherwise one notice and `answerSource:
 * 'verifier-blocked'`). Canvas turns keep the withhold-only behaviour.
 *
 * Drives the REAL `Orchestrator.chatStream` under the REAL `VerifierService`;
 * only the model, the pipeline and the verdict store are scripted. All values
 * are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import {
  REQUEST,
  doneOf,
  drain,
  registerWriteTool,
  text,
  toolCalls,
  toolResultContents,
  verifiedTurn,
} from './_helpers/replayTurnFixture.js';
import { approved, blocked, partlyChecked } from './_helpers/verifierVerdictFixtures.js';

const INVOICE = { customer: 'K-1001', amount: 1200, currency: 'EUR' };
const OTHER_INVOICE = { customer: 'K-1001', amount: 1250, currency: 'EUR' };
const CREATED = 'Rechnung INV/2026/0042 über 1.200 EUR angelegt.';
/** The first answer states a wrong figure — the verdict blocks it. */
const WRONG = 'Die Rechnung INV/2026/0042 über 1.250 EUR ist angelegt.';
const CORRECTED = 'Die Rechnung INV/2026/0042 über 1.200 EUR ist angelegt.';

function setup(responses: Parameters<typeof verifiedTurn>[0]['responses'], verdicts: Parameters<typeof verifiedTurn>[0]['verdicts']) {
  const registry = new NativeToolRegistry();
  const invoice = registerWriteTool(registry, 'create_invoice', () => Promise.resolve(CREATED));
  return { invoice, t: verifiedTurn({ registry, responses, verdicts }) };
}

describe('VerifierService.chatStream — enforce retries a contradiction over frozen results', () => {
  it('MUTATION CHECK: the retry replays the write instead of running it again', async () => {
    const { invoice, t } = setup(
      [
        toolCalls(['create_invoice', INVOICE]),
        text(WRONG),
        toolCalls(['create_invoice', INVOICE]),
        text(CORRECTED),
      ],
      [blocked(), approved()],
    );

    const events = await drain(t.service.chatStream(REQUEST));

    assert.equal(t.model.requests.length, 4, 'the stream ran the correction retry');
    assert.deepEqual(invoice.inputs, [INVOICE], 'the write ran once for one user request');
    assert.ok(
      toolResultContents(t.model.requests[3]).includes(CREATED),
      'the retry’s model saw the first run’s tool result',
    );
    const terminal = doneOf(events);
    assert.equal(terminal?.answer, CORRECTED);
    assert.equal(terminal?.verifier?.badge, 'corrected');
    assert.deepEqual(t.persisted, [{ status: 'approved', retryCount: 1 }]);
  });

  it('nothing of the contradicted first answer reaches the consumer', async () => {
    const { t } = setup(
      [
        toolCalls(['create_invoice', INVOICE]),
        text(WRONG),
        toolCalls(['create_invoice', INVOICE]),
        text(CORRECTED),
      ],
      [blocked(), approved()],
    );

    const events = await drain(t.service.chatStream(REQUEST));

    assert.equal(JSON.stringify(events).includes('1.250'), false, 'the wrong figure leaked');
    assert.equal(events.filter((e) => e.type === 'done').length, 1, 'one terminal done');
    assert.equal(events.filter((e) => e.type === 'error').length, 0, 'no error event');
  });

  it('a retry that needs a write the first run did not make is abandoned; the answer stays withheld', async () => {
    const { invoice, t } = setup(
      [
        toolCalls(['create_invoice', INVOICE]),
        text(WRONG),
        toolCalls(['create_invoice', OTHER_INVOICE]),
        text(CORRECTED),
      ],
      [blocked(), approved()],
    );

    const events = await drain(t.service.chatStream(REQUEST));

    assert.equal(t.model.requests.length, 3, 'the retry ran until it asked for the new write');
    assert.deepEqual(invoice.inputs, [INVOICE], 'the second invoice was never created');
    const terminal = doneOf(events);
    assert.equal(terminal?.answerSource, 'verifier-blocked');
    assert.equal(terminal?.verifier?.badge, 'failed');
    assert.equal(JSON.stringify(events).includes('1.250'), false);
    assert.equal(events.filter((e) => e.type === 'error').length, 0, 'the abandoned retry stays internal');
    assert.deepEqual(t.persisted, [{ status: 'blocked', retryCount: 0 }]);
    assert.ok(t.logs.some((l) => /retry abandoned/.test(l) && l.includes('create_invoice')));
  });

  it('control: a verdict that is not a contradiction is withheld without a retry', async () => {
    const { invoice, t } = setup(
      [toolCalls(['create_invoice', INVOICE]), text(WRONG)],
      [partlyChecked()],
    );

    const events = await drain(t.service.chatStream(REQUEST));

    assert.equal(t.model.requests.length, 2);
    assert.deepEqual(invoice.inputs, [INVOICE]);
    assert.equal(doneOf(events)?.answerSource, 'verifier-blocked');
  });

  it('control: a canvas turn is withheld without a retry', async () => {
    const { invoice, t } = setup(
      [toolCalls(['create_invoice', INVOICE]), text(WRONG)],
      [blocked()],
    );

    const events = await drain(t.service.chatStream({ ...REQUEST, canvasSessionId: 'canvas-1' }));

    assert.equal(t.model.requests.length, 2, 'no retry on a canvas turn');
    assert.deepEqual(invoice.inputs, [INVOICE]);
    assert.equal(doneOf(events)?.answerSource, 'verifier-blocked');
    assert.deepEqual(t.persisted, [{ status: 'blocked', retryCount: 0 }]);
  });
});
