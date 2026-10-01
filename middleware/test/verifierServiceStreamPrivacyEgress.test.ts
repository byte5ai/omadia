/**
 * VerifierService.chatStream behind a Privacy Shield: `done` — which carries
 * the receipt — is held until the inner stream has drained and the verifier
 * finished through the turn's privacy view; the turn is finalized exactly
 * once, also when the client walks away or the verifier fails. Without a
 * shield, `done` goes out before verification, as it always did. In
 * `enforce` every pass — the correction retry too — is verified through its
 * own view, and the request carries one merged receipt.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { applyAiDisclosure, type AiDisclosure } from '../packages/harness-channel-sdk/src/aiDisclosure.js';
import type { ChatStreamEvent } from '../packages/harness-channel-sdk/src/chatAgent.js';
import {
  PROMPT_MASK_BLOCKED_ANSWER,
  SECURITY_QUARANTINE_NOTICE,
} from '../packages/harness-orchestrator/src/orchestrator.js';
import { mergePrivacyReceipts } from '../packages/harness-orchestrator/src/requestReceipts.js';
import { VerifierService } from '../packages/harness-orchestrator/src/verifierService.js';
import {
  APPROVED,
  BLOCKED,
  SILENT,
  failingPipeline,
  stubOrchestrator,
  verdicts,
} from './_helpers/verifierEgressStub.js';

async function collect(
  gen: AsyncGenerator<ChatStreamEvent>,
  stopAfter?: ChatStreamEvent['type'],
): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
    if (event.type === stopAfter) break;
  }
  return events;
}

function doneAt(events: readonly ChatStreamEvent[], index: number): Extract<ChatStreamEvent, { type: 'done' }> {
  const event = events[index];
  assert.equal(event?.type, 'done');
  return event as Extract<ChatStreamEvent, { type: 'done' }>;
}

const DONE: ChatStreamEvent = {
  type: 'done',
  answer: 'Die Rechnung RE-1 beträgt 100 €.',
  toolCalls: 0,
  iterations: 1,
};
const DELTA: ChatStreamEvent = { type: 'text_delta', text: 'Die Rechnung' } as ChatStreamEvent;

describe('VerifierService.chatStream — privacy egress', () => {
  it('holds done until the inner stream is drained and verified, then emits done with the receipt and the verifier event', async () => {
    const { orchestrator, state } = stubOrchestrator({ stream: [DELTA, DONE], handOver: true, privacyActive: true });
    const { pipeline, inputs, onVerify } = verdicts([APPROVED]);
    let innerClosedAtVerify: boolean | undefined;
    onVerify.hook = () => {
      innerClosedAtVerify = state.streamClosed;
    };
    const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'shadow', log: SILENT });

    const events = await collect(service.chatStream({ userMessage: 'frage' }));

    assert.deepEqual(
      events.map((e) => e.type),
      ['text_delta', 'done', 'verifier'],
    );
    assert.equal(innerClosedAtVerify, true, 'verification ran before the turn’s stream had finished');
    assert.equal(inputs[0]!.privacy, state.continuations[0]!.verifierPrivacy);
    const done = doneAt(events, 1);
    assert.deepEqual(done.privacyReceipt, state.continuations[0]!.receipt);
    assert.equal(done.receiptId, state.continuations[0]!.receiptId);
    assert.equal(state.continuations[0]!.finalizeCalls, 1);
  });

  it('a degraded or clarification done is not verified but is still finalized and delivered', async () => {
    for (const special of [
      { ...DONE, degraded: true } as ChatStreamEvent,
      { ...DONE, pendingUserChoice: { question: 'Welche?', options: [] } } as unknown as ChatStreamEvent,
    ]) {
      const { orchestrator, state } = stubOrchestrator({ stream: [special], handOver: true, privacyActive: true });
      const { pipeline, inputs } = verdicts([APPROVED]);
      const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'shadow', log: SILENT });

      const events = await collect(service.chatStream({ userMessage: 'frage' }));

      assert.deepEqual(events.map((e) => e.type), ['done']);
      assert.equal(inputs.length, 0);
      assert.equal(state.continuations[0]!.finalizeCalls, 1);
      assert.deepEqual(doneAt(events, 0).privacyReceipt, state.continuations[0]!.receipt);
    }
  });

  it('a continuation without a view (Direct Line relay) is not verified; done still carries its receipt', async () => {
    const { orchestrator, state } = stubOrchestrator({
      stream: [DELTA, DONE],
      handOver: true,
      privacyActive: true,
      continuation: () => ({ wireAnswer: undefined }),
    });
    const { pipeline, inputs } = verdicts([APPROVED]);
    const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'shadow', log: SILENT });

    const events = await collect(service.chatStream({ userMessage: '#spezialist frage' }));

    assert.deepEqual(events.map((e) => e.type), ['text_delta', 'done']);
    assert.equal(inputs.length, 0);
    assert.equal(state.continuations[0]!.finalizeCalls, 1);
    const done = doneAt(events, 1);
    assert.deepEqual(done.privacyReceipt, state.continuations[0]!.receipt);
    assert.equal(done.receiptId, state.continuations[0]!.receiptId);
  });

  it('without a continuation, done goes out before verification (no shield installed)', async () => {
    const { orchestrator } = stubOrchestrator({ stream: [DELTA, DONE], handOver: false, privacyActive: false });
    const order: string[] = [];
    const { pipeline, onVerify } = verdicts([APPROVED]);
    onVerify.hook = () => order.push('verify');
    const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'shadow', log: SILENT });

    for await (const event of service.chatStream({ userMessage: 'frage' })) {
      order.push(event.type);
    }

    assert.deepEqual(order, ['text_delta', 'done', 'verify', 'verifier']);
  });

  it('fails closed on the stream: an active shield without a continuation is not verified', async () => {
    const { orchestrator } = stubOrchestrator({ stream: [DONE], handOver: false, privacyActive: true });
    const { pipeline, inputs } = verdicts([APPROVED]);
    const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'shadow', log: SILENT });

    const events = await collect(service.chatStream({ userMessage: 'frage' }));

    assert.deepEqual(events.map((e) => e.type), ['done']);
    assert.equal(inputs.length, 0);
  });

  it('a client that stops right after done still gets the turn finalized exactly once', async () => {
    const { orchestrator, state } = stubOrchestrator({ stream: [DELTA, DONE], handOver: true, privacyActive: true });
    const { pipeline } = verdicts([APPROVED]);
    const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'shadow', log: SILENT });

    const events = await collect(service.chatStream({ userMessage: 'frage' }), 'done');

    assert.deepEqual(events.map((e) => e.type), ['text_delta', 'done']);
    assert.equal(state.continuations[0]!.finalizeCalls, 1);
  });

  it('a client that leaves before done hands nothing over and finalizes nothing twice', async () => {
    const { orchestrator, state } = stubOrchestrator({ stream: [DELTA, DONE], handOver: true, privacyActive: true });
    const { pipeline, inputs } = verdicts([APPROVED]);
    const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'shadow', log: SILENT });

    const events = await collect(service.chatStream({ userMessage: 'frage' }), 'text_delta');

    assert.deepEqual(events.map((e) => e.type), ['text_delta']);
    assert.equal(state.streamClosed, true, 'the inner stream was not closed');
    assert.equal(inputs.length, 0);
    // The turn never reached `done`, so it handed nothing over: the
    // orchestrator drops its own state (see orchestratorPrivacyEgress).
    assert.equal(state.continuations.length, 0);
  });

  it('a pipeline failure still finalizes and delivers done', async () => {
    const { orchestrator, state } = stubOrchestrator({ stream: [DONE], handOver: true, privacyActive: true });
    const service = new VerifierService({
      orchestrator,
      pipeline: failingPipeline(),
      enabled: true,
      mode: 'shadow',
      log: SILENT,
    });

    const events = await collect(service.chatStream({ userMessage: 'frage' }));

    assert.equal(events[0]?.type, 'done');
    assert.equal(state.continuations[0]!.finalizeCalls, 1);
  });
});

// `enforce` holds every content event until the verdict; behind a shield the
// verdict on each pass goes through that pass's own privacy view, every pass
// is finalized exactly once, and the request's one receipt — every pass
// merged, the verifier's requests included — rides on the `done` that goes
// out, also on a withheld answer.
describe('VerifierService.chatStream (enforce) — privacy egress', () => {
  const ITERATION: ChatStreamEvent = { type: 'iteration_start', iteration: 1 } as ChatStreamEvent;

  it('verifies through the pass’s view and puts its receipt on the released done', async () => {
    const { orchestrator, state } = stubOrchestrator({ stream: [DELTA, DONE], handOver: true, privacyActive: true });
    const { pipeline, inputs } = verdicts([APPROVED]);
    const service = new VerifierService({
      orchestrator,
      pipeline,
      enabled: true,
      mode: 'enforce',
      maxRetries: 0,
      log: SILENT,
    });

    const events = await collect(service.chatStream({ userMessage: 'frage' }));

    // The answer goes out as the one text the verdict is about.
    assert.deepEqual(events.map((e) => e.type), ['text_delta', 'done', 'verifier']);
    assert.equal(inputs[0]!.privacy, state.continuations[0]!.verifierPrivacy);
    const done = doneAt(events, 1);
    assert.equal(done.answerSource, undefined);
    assert.deepEqual(done.privacyReceipt, state.continuations[0]!.receipt);
    assert.equal(done.receiptId, state.continuations[0]!.receiptId);
    assert.equal(state.continuations[0]!.finalizeCalls, 1);
  });

  it('a withheld answer keeps the pass’s receipt', async () => {
    const { orchestrator, state } = stubOrchestrator({ stream: [DELTA, DONE], handOver: true, privacyActive: true });
    const { pipeline } = verdicts([BLOCKED]);
    const service = new VerifierService({
      orchestrator,
      pipeline,
      enabled: true,
      mode: 'enforce',
      maxRetries: 0,
      log: SILENT,
    });

    const events = await collect(service.chatStream({ userMessage: 'frage' }));

    assert.deepEqual(events.map((e) => e.type), ['text_delta', 'done', 'verifier']);
    const done = doneAt(events, 1);
    assert.equal(done.answerSource, 'verifier-blocked');
    assert.equal(JSON.stringify(events).includes('RE-1'), false, 'the withheld answer reached the client');
    assert.deepEqual(done.privacyReceipt, state.continuations[0]!.receipt);
    assert.equal(state.continuations[0]!.finalizeCalls, 1);
  });

  it('the stream retry is verified through its own view; one merged receipt, one row', async () => {
    const { orchestrator, state } = stubOrchestrator({ stream: [DELTA, DONE], handOver: true, privacyActive: true });
    const { pipeline, inputs } = verdicts([BLOCKED, APPROVED]);
    const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'enforce', log: SILENT });

    const events = await collect(service.chatStream({ userMessage: 'frage' }));

    assert.equal(state.runs.length, 2, 'the stream ran its correction retry');
    assert.equal(state.continuations.length, 2);
    assert.equal(inputs[0]!.privacy, state.continuations[0]!.verifierPrivacy);
    assert.equal(inputs[1]!.privacy, state.continuations[1]!.verifierPrivacy, 'the retry was verified through another pass’s view');
    assert.deepEqual(state.continuations.map((c) => c.finalizeCalls), [1, 1]);
    const done = events.find((e): e is Extract<ChatStreamEvent, { type: 'done' }> => e.type === 'done');
    const merged = mergePrivacyReceipts(state.continuations.map((c) => c.receipt));
    assert.deepEqual(done?.privacyReceipt, merged);
    assert.equal(done?.receiptId, state.continuations[0]!.receiptId, 'the first pass owns the request’s row');
    assert.equal(merged?.verifierEgress?.requests, 1 + 2);
    assert.deepEqual(state.rows, [merged]);
  });

  it('a client that leaves during the retry still finalizes the first pass once and writes one row', async () => {
    const { orchestrator, state } = stubOrchestrator({
      stream: [ITERATION, DELTA, DONE],
      handOver: true,
      privacyActive: true,
    });
    const { pipeline } = verdicts([BLOCKED, APPROVED]);
    const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'enforce', log: SILENT });

    // The first liveness event is the first pass's, the second the retry's.
    const stream = service.chatStream({ userMessage: 'frage' });
    let seen = 0;
    for await (const event of stream) {
      if (event.type === 'iteration_start') seen += 1;
      if (seen === 2) break;
    }

    assert.equal(state.runs.length, 2);
    assert.equal(state.continuations.length, 1, 'the retry never reached its done');
    assert.equal(state.continuations[0]!.finalizeCalls, 1);
    assert.deepEqual(state.rows, [state.continuations[0]!.receipt]);
  });
});

describe('VerifierService.chatStream (enforce) — server-composed notices', () => {
  const DISCLOSURE: AiDisclosure = {
    text: 'Diese Antwort wurde mit KI erstellt.',
    level: 'standard',
    locale: 'de',
    source: 'default',
  };

  for (const [label, notice] of [
    ['privacy refusal', PROMPT_MASK_BLOCKED_ANSWER],
    ['screening quarantine', SECURITY_QUARANTINE_NOTICE],
  ] as const) {
    it(`releases the ${label} unverified, also with the disclosure folded in`, async () => {
      // A first turn of a scope folds the disclosure block into `done.answer`.
      const folded = applyAiDisclosure(notice, { disclosure: DISCLOSURE }).text;
      assert.notEqual(folded, notice);
      const terminal = {
        type: 'done',
        answer: folded,
        toolCalls: 0,
        iterations: 0,
        aiDisclosure: DISCLOSURE,
      } as ChatStreamEvent;
      const { orchestrator, state } = stubOrchestrator({
        stream: [terminal],
        handOver: true,
        privacyActive: true,
        continuation: () => ({ wireAnswer: undefined }),
      });
      const { pipeline, inputs } = verdicts([APPROVED]);
      const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'enforce', log: SILENT });

      const events = await collect(service.chatStream({ userMessage: 'frage' }));

      const done = events.find((e): e is Extract<ChatStreamEvent, { type: 'done' }> => e.type === 'done');
      assert.equal(done?.answer, folded);
      assert.equal(done?.answerSource, undefined, 'the notice was withheld');
      assert.equal(inputs.length, 0, 'the notice was sent to the verifier');
      assert.equal(state.continuations[0]!.finalizeCalls, 1);
    });
  }
});
