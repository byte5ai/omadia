/**
 * A request the verifier may re-enter writes ONE `turn_receipts` row whenever
 * any of its passes had a receipt — also when only a re-entry that never
 * delivered had one.
 *
 * The first run below answers without a tool call: the Privacy Shield has
 * nothing to account for, so that pass has no receipt. Its verdict blocks the
 * answer. The correction retry reads the chat roster live — a kernel read, so
 * the re-entry may run it although the first run did not — and the shield
 * interns the result: the retry's pass has a receipt. Then the retry ends
 * without an answer: it needs a write the first run never made (abandoned),
 * its model fails (thrown), or the client leaves (cut off). Such a pass's
 * receipt used to join the request's without an offer to own the row, so the
 * merged receipt went out on the answer while no row was written at all.
 *
 * Drives the REAL `Orchestrator` under the REAL `VerifierService`. All values
 * are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PrivacyGuardService, PrivacyReceipt, TurnReceiptRecordInput } from '@omadia/plugin-api';
import type { LlmResponse } from '@omadia/llm-provider';

import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { OrchestratorOptions } from '../packages/harness-orchestrator/src/orchestrator.js';
import {
  CHAT_PARTICIPANTS_TOOL_NAME,
  ChatParticipantsTool,
} from '../packages/harness-orchestrator/src/tools/chatParticipantsTool.js';
import {
  REQUEST,
  doneOf,
  drain,
  maskingPrivacy,
  registerWriteTool,
  text,
  toolCalls,
  verifiedTurn,
  type CountingTool,
  type VerifiedTurn,
} from './_helpers/replayTurnFixture.js';
import { approved, blocked } from './_helpers/verifierVerdictFixtures.js';

const INVOICE = { customer: 'K-1001', amount: 1200, currency: 'EUR' };
const FIRST_ANSWER = 'Die Rechnung über 1.250 EUR ist angelegt.';
const RETRY_ANSWER = 'Die Rechnung über 1.200 EUR ist angelegt.';

/** The retry's live read of the chat roster: a kernel read the first run
 *  did not make. */
const rosterRead = (): LlmResponse => toolCalls([CHAT_PARTICIPANTS_TOOL_NAME, {}]);
/** A write the first run never made: the re-entry is abandoned on it. */
const unrecordedWrite = (): LlmResponse => toolCalls(['create_invoice', INVOICE]);

interface ShieldedRequest extends VerifiedTurn {
  readonly rows: TurnReceiptRecordInput[];
  /** The turn ids the shield interned a result in, in order. */
  readonly internedIn: string[];
  readonly invoices: CountingTool;
}

function shieldedRequest(responses: readonly LlmResponse[]): ShieldedRequest {
  const rows: TurnReceiptRecordInput[] = [];
  const internedIn: string[] = [];
  const inner = maskingPrivacy().service;
  const service = {
    ...inner,
    internToolResultV4(request: { turnId: string; toolName: string; rawResult: string }) {
      internedIn.push(request.turnId);
      return inner.internToolResultV4(request as never);
    },
  } as PrivacyGuardService;
  const registry = new NativeToolRegistry();
  const invoices = registerWriteTool(registry, 'create_invoice', () =>
    Promise.resolve('Rechnung angelegt.'),
  );
  const turn = verifiedTurn({
    registry,
    responses,
    verdicts: [blocked(), approved()],
    orchestrator: {
      privacyGuard: () => service,
      chatParticipantsTool: new ChatParticipantsTool(),
      turnReceiptStore: () => ({
        record(entry: TurnReceiptRecordInput) {
          rows.push(entry);
          return Promise.resolve();
        },
      }),
    } as Partial<OrchestratorOptions>,
  });
  return { ...turn, rows, internedIn, invoices };
}

/** One row for the request, owned by the retry — the only pass with a
 *  receipt — and holding the receipt the answer carried. */
function assertOneRowOwnedByTheRetry(t: ShieldedRequest, carried: PrivacyReceipt | undefined): void {
  assert.equal(t.internedIn.length, 1, 'only the retry’s live read was interned');
  assert.equal(t.rows.length, 1, 'one receipt row for the request');
  assert.equal(t.rows[0]?.turnId, t.internedIn[0], 'the retry owns the row');
  assert.equal(t.rows[0]?.receipt.datasetsInterned, 1, 'the row accounts for the live read');
  assert.deepEqual(carried, t.rows[0]?.receipt, 'the answer carries the row’s receipt');
}

describe('a request whose only receipt is an undelivered re-entry’s still gets its row', () => {
  it('MUTATION CHECK: a correction retry abandoned after a live read (chat)', async () => {
    const t = shieldedRequest([text(FIRST_ANSWER), rosterRead(), unrecordedWrite()]);

    const sa = await t.service.chat(REQUEST);

    assert.equal(t.model.requests.length, 3, 'the retry ran until it needed the write');
    assert.equal(t.invoices.inputs.length, 0, 'the unrecorded write never ran');
    assert.ok(t.logs.some((line) => line.includes('retry abandoned')));
    assertOneRowOwnedByTheRetry(t, sa.privacyReceipt);
  });

  it('MUTATION CHECK: a correction retry whose model fails after a live read (chat)', async () => {
    // Nothing is scripted after the read: the retry's next model call throws.
    const t = shieldedRequest([text(FIRST_ANSWER), rosterRead()]);

    const sa = await t.service.chat(REQUEST);

    assert.equal(t.model.requests.length, 3, 'the retry failed on its second model call');
    assert.ok(t.logs.some((line) => line.includes('retry FAIL')));
    assertOneRowOwnedByTheRetry(t, sa.privacyReceipt);
  });

  it('MUTATION CHECK: a stream retry the client leaves after a live read', async () => {
    const t = shieldedRequest([text(FIRST_ANSWER), rosterRead(), text(RETRY_ANSWER)]);

    // Iteration 1 is the first run's; 2 and 3 are the retry's. The client
    // leaves once the retry's live read was interned.
    let iterations = 0;
    for await (const event of t.service.chatStream(REQUEST)) {
      if (event.type === 'iteration_start') iterations += 1;
      if (iterations === 3) break;
    }

    assert.equal(t.model.requests.length, 2, 'the client left before the retry answered');
    assert.equal(t.rows.length, 1, 'one receipt row for the request');
    assert.equal(t.rows[0]?.turnId, t.internedIn[0], 'the retry owns the row');
    assert.equal(t.rows[0]?.receipt.datasetsInterned, 1);
  });

  it('MUTATION CHECK: a stream retry abandoned after a live read — done names the row', async () => {
    const t = shieldedRequest([text(FIRST_ANSWER), rosterRead(), unrecordedWrite()]);

    const done = doneOf(await drain(t.service.chatStream(REQUEST)));

    assert.ok(done, 'the first answer’s outcome is delivered');
    assert.equal(done.answerSource, 'verifier-blocked');
    assertOneRowOwnedByTheRetry(t, done.privacyReceipt);
    assert.equal(done.receiptId, t.rows[0]?.turnId, '`done.receiptId` names the request’s row');
  });

  it('a first run with a receipt keeps the row, also when the retry closed itself first', async () => {
    // Both passes read the roster — the retry gets the first run's result
    // replayed, interned in its own scope — so both have a receipt. The
    // abandoned retry is closed before the verifier finalizes the first run.
    const t = shieldedRequest([rosterRead(), text(FIRST_ANSWER), rosterRead(), unrecordedWrite()]);

    const sa = await t.service.chat(REQUEST);

    assert.equal(t.internedIn.length, 2, 'each pass interned the roster in its own scope');
    assert.equal(t.rows.length, 1, 'one receipt row for the request');
    assert.equal(t.rows[0]?.turnId, t.internedIn[0], 'the first run owns the row');
    assert.deepEqual(sa.privacyReceipt, t.rows[0]?.receipt);
  });
});
