/**
 * The verifier wrapper binds its model requests to the privacy view of the
 * turn it verifies and finalizes that turn's privacy state only afterwards.
 *
 * A stub orchestrator implements the hand-over (`markPrivacyFinalizeHeld` /
 * `takePrivacyEgress` / `isPrivacyGuardActive`) with recording
 * continuations, so these tests pin the wrapper's side of the contract:
 * which view reaches the pipeline, when `done` is emitted, and that every
 * turn is finalized exactly once — on success, on failure and when a client
 * walks away.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  ClaimVerdict,
  VerifierInput,
  VerifierPipeline,
  VerifierPrivacy,
  VerifierVerdict,
} from '@omadia/verifier';
import type { PrivacyReceipt } from '@omadia/plugin-api';
import type {
  ChatStreamEvent,
  ChatTurnInput,
  ChatTurnResult,
} from '../packages/harness-channel-sdk/src/chatAgent.js';
import type { Orchestrator } from '../packages/harness-orchestrator/src/orchestrator.js';
import type { PrivacyEgressContinuation } from '../packages/harness-orchestrator/src/privacyEgress.js';
import { VerifierService } from '../packages/harness-orchestrator/src/verifierService.js';

// --- recording continuation + stub orchestrator ---------------------------

interface RecordingContinuation extends PrivacyEgressContinuation {
  finalizeCalls: number;
  readonly receipt: PrivacyReceipt;
}

function receiptFor(n: number): PrivacyReceipt {
  return {
    datasetsInterned: n,
    fieldsMasked: 0,
    fieldsCleartext: 0,
    verbsExecuted: [],
    pseudonymProjectionUsed: false,
    verifierEgress: { requests: n, maskedSpans: [] },
  };
}

function recordingContinuation(
  n: number,
  opts: {
    readonly wireAnswer?: string | undefined;
    readonly maskWouldAlter?: boolean;
    readonly unresolved?: number;
  },
): RecordingContinuation {
  const receipt = receiptFor(n);
  const view: VerifierPrivacy | undefined =
    opts.wireAnswer === undefined
      ? undefined
      : {
          wireAnswer: opts.wireAnswer,
          maskForWire: async (t) => t,
          projectForWire: async (t) => t,
          restore: async (t) => t,
        };
  const c: RecordingContinuation = {
    receiptId: `turn-${String(n)}`,
    verifierPrivacy: view,
    receipt,
    finalizeCalls: 0,
    maskWouldAlter: async () => opts.maskWouldAlter === true,
    countUnresolvedSurrogates: async () => opts.unresolved ?? 0,
    finalize: async () => {
      c.finalizeCalls += 1;
      return receipt;
    },
  };
  return c;
}

interface StubState {
  readonly marks: ChatTurnInput[];
  readonly runs: ChatTurnInput[];
  readonly continuations: RecordingContinuation[];
  streamClosed: boolean;
}

type ContinuationOpts = Parameters<typeof recordingContinuation>[1];

function stubOrchestrator(opts: {
  readonly results?: readonly ChatTurnResult[];
  readonly stream?: readonly ChatStreamEvent[];
  /** Hand the finalisation over when marked (a privacy provider is wired). */
  readonly handOver?: boolean;
  readonly privacyActive?: boolean;
  /** Per-turn continuation options, by run index; default: a view whose
   *  wire answer is the run's own answer. */
  readonly continuation?: (index: number, result: ChatTurnResult) => ContinuationOpts;
  readonly throwOnRun?: number;
}): { orchestrator: Orchestrator; state: StubState } {
  const held = new WeakSet<object>();
  const stashed = new WeakMap<object, RecordingContinuation>();
  const state: StubState = { marks: [], runs: [], continuations: [], streamClosed: false };
  const handOver = (input: ChatTurnInput, result: ChatTurnResult): void => {
    if (!held.delete(input) || opts.handOver !== true) return;
    const index = state.continuations.length;
    const c = recordingContinuation(
      index + 1,
      opts.continuation?.(index, result) ?? { wireAnswer: result.answer },
    );
    state.continuations.push(c);
    stashed.set(input, c);
  };
  const orchestrator = {
    agentId: 'default',
    markScreeningReentry(): void {},
    markPrivacyFinalizeHeld(input: ChatTurnInput): void {
      state.marks.push(input);
      held.add(input);
    },
    takePrivacyEgress(input: ChatTurnInput): PrivacyEgressContinuation | undefined {
      const c = stashed.get(input);
      stashed.delete(input);
      return c;
    },
    isPrivacyGuardActive: (): boolean => opts.privacyActive === true,
    async runTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
      const index = state.runs.length;
      state.runs.push(input);
      if (opts.throwOnRun === index) throw new Error('turn failed');
      const result = opts.results?.[index] ?? opts.results?.[opts.results.length - 1];
      assert.ok(result, 'stub has no scripted result');
      handOver(input, result);
      return result;
    },
    async *chatStream(input: ChatTurnInput): AsyncGenerator<ChatStreamEvent> {
      state.runs.push(input);
      try {
        for (const event of opts.stream ?? []) {
          if (event.type === 'done') {
            handOver(input, { answer: event.answer, toolCalls: 0, iterations: 0 });
          }
          await Promise.resolve();
          yield event;
        }
      } finally {
        state.streamClosed = true;
      }
    },
  };
  return { orchestrator: orchestrator as unknown as Orchestrator, state };
}

function verdicts(sequence: readonly VerifierVerdict[]): {
  pipeline: VerifierPipeline;
  inputs: VerifierInput[];
  onVerify: { hook?: () => void };
} {
  const inputs: VerifierInput[] = [];
  const onVerify: { hook?: () => void } = {};
  let i = 0;
  const pipeline = {
    verify: async (input: VerifierInput): Promise<VerifierVerdict> => {
      inputs.push(input);
      onVerify.hook?.();
      const v = sequence[i] ?? sequence[sequence.length - 1]!;
      i += 1;
      return v;
    },
  } as unknown as VerifierPipeline;
  return { pipeline, inputs, onVerify };
}

const CLAIM = {
  id: 'c_001',
  text: 'Die Rechnung ist offen',
  type: 'qualitative' as const,
  expectedSource: 'odoo' as const,
  relatedEntities: [],
};
// The channel badge only shows when at least one claim was checked.
const APPROVED: VerifierVerdict = {
  status: 'approved',
  claims: [{ status: 'verified', claim: CLAIM, source: 'odoo' }],
  latencyMs: 0,
};
const BORDERLINE: VerifierVerdict = {
  status: 'approved_with_disclaimer',
  claims: [{ status: 'unverified', claim: CLAIM, reason: 'no evidence' }],
  unverified: [{ status: 'unverified', claim: CLAIM, reason: 'no evidence' }],
  latencyMs: 0,
};
const TRUTH = 'Tatsaechlich-Wert-4711';
const CONTRADICTION: ClaimVerdict = {
  status: 'contradicted',
  claim: CLAIM,
  truth: TRUTH,
  source: 'odoo',
  detail: `Δ=${TRUTH}`,
};
const BLOCKED: VerifierVerdict = {
  status: 'blocked',
  claims: [CONTRADICTION],
  contradictions: [CONTRADICTION],
  latencyMs: 0,
};

function turn(answer: string, extra: Partial<ChatTurnResult> = {}): ChatTurnResult {
  return { answer, toolCalls: 0, iterations: 1, ...extra };
}

const SILENT = (): void => undefined;

// --- chat() ----------------------------------------------------------------

describe('VerifierService.chat — privacy egress', () => {
  it('verifies through the turn’s privacy view, then finalizes once and attaches that receipt', async () => {
    const { orchestrator, state } = stubOrchestrator({
      results: [turn('Die Rechnung RE-1 beträgt 100 €.')],
      handOver: true,
      privacyActive: true,
    });
    const { pipeline, inputs } = verdicts([APPROVED]);
    const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'enforce', log: SILENT });
    const input: ChatTurnInput = { userMessage: 'Wie hoch ist RE-1?' };

    const answer = await service.chat(input);

    assert.equal(state.marks[0], input, 'the caller’s own input object must be marked');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.privacy, state.continuations[0]!.verifierPrivacy);
    assert.equal(state.continuations[0]!.finalizeCalls, 1);
    assert.deepEqual(answer.privacyReceipt, state.continuations[0]!.receipt);
  });

  it('finalizes every turn exactly once across first sample, re-sample and retry', async () => {
    const { orchestrator, state } = stubOrchestrator({
      results: [turn('eins'), turn('zwei'), turn('drei')],
      handOver: true,
      privacyActive: true,
    });
    // first borderline → re-sample escalates to blocked → retry approved.
    const { pipeline } = verdicts([BORDERLINE, BLOCKED, APPROVED]);
    const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'enforce', log: SILENT });

    const answer = await service.chat({ userMessage: 'frage' });

    assert.equal(state.runs.length, 3);
    assert.equal(state.continuations.length, 3);
    assert.deepEqual(
      state.continuations.map((c) => c.finalizeCalls),
      [1, 1, 1],
    );
    assert.equal(answer.text.startsWith('drei'), true);
    assert.deepEqual(answer.privacyReceipt, state.continuations[2]!.receipt);
  });

  it('sends a correction without truth values or value-bearing details', async () => {
    const { orchestrator, state } = stubOrchestrator({
      results: [turn('Die Rechnung ist offen.'), turn('Die Rechnung ist bezahlt.')],
      handOver: true,
      privacyActive: true,
    });
    const { pipeline } = verdicts([BLOCKED, APPROVED]);
    const service = new VerifierService({
      orchestrator,
      pipeline,
      enabled: true,
      mode: 'enforce',
      resampleOnBorderline: false,
      log: SILENT,
    });

    await service.chat({ userMessage: 'Ist die Rechnung offen?' });

    assert.equal(state.runs.length, 2);
    const hint = state.runs[1]!.extraSystemHint ?? '';
    assert.match(hint, /Die Rechnung ist offen/);
    assert.equal(hint.includes(TRUTH), false, 'the re-queried truth reached the retry prompt');
  });

  it('withholds the retry when the turn’s masking would alter the hint', async () => {
    const { orchestrator, state } = stubOrchestrator({
      results: [turn('Die Rechnung ist offen.'), turn('nie gesendet')],
      handOver: true,
      privacyActive: true,
      continuation: (_i, r) => ({ wireAnswer: r.answer, maskWouldAlter: true }),
    });
    const { pipeline } = verdicts([BLOCKED]);
    const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'enforce', log: SILENT });

    const answer = await service.chat({ userMessage: 'Ist die Rechnung offen?' });

    assert.equal(state.runs.length, 1, 'a retry ran although its hint would carry masked values');
    assert.equal(answer.verifier?.status, 'failed');
    assert.equal(state.continuations[0]!.finalizeCalls, 1);
  });

  it('never returns a still-blocked retry answer that carries unresolved placeholders', async () => {
    const { orchestrator, state } = stubOrchestrator({
      results: [turn('Erste Antwort.'), turn('Zweite Antwort mit Platzhalter.')],
      handOver: true,
      privacyActive: true,
      continuation: (i, r) => ({ wireAnswer: r.answer, unresolved: i === 1 ? 1 : 0 }),
    });
    const { pipeline } = verdicts([BLOCKED, BLOCKED]);
    const service = new VerifierService({
      orchestrator,
      pipeline,
      enabled: true,
      mode: 'enforce',
      resampleOnBorderline: false,
      log: SILENT,
    });

    const answer = await service.chat({ userMessage: 'frage' });

    assert.equal(state.runs.length, 2);
    assert.equal(answer.text.startsWith('Erste Antwort.'), true);
    assert.equal(answer.verifier?.status, 'failed');
    assert.deepEqual(answer.privacyReceipt, state.continuations[0]!.receipt);
    assert.deepEqual(
      state.continuations.map((c) => c.finalizeCalls),
      [1, 1],
    );
  });

  it('still finalizes every turn when the retry run throws', async () => {
    const { orchestrator, state } = stubOrchestrator({
      results: [turn('Die Rechnung ist offen.')],
      handOver: true,
      privacyActive: true,
      throwOnRun: 1,
    });
    const { pipeline } = verdicts([BLOCKED]);
    const service = new VerifierService({
      orchestrator,
      pipeline,
      enabled: true,
      mode: 'enforce',
      resampleOnBorderline: false,
      log: SILENT,
    });

    const answer = await service.chat({ userMessage: 'frage' });

    assert.equal(state.runs.length, 2);
    assert.equal(answer.verifier?.status, 'failed');
    assert.equal(state.continuations[0]!.finalizeCalls, 1);
  });

  it('fails closed: a shield without a handed-over view means no verification', async () => {
    const { orchestrator } = stubOrchestrator({
      results: [turn('Die Rechnung RE-1 beträgt 100 €.')],
      handOver: false,
      privacyActive: true,
    });
    const { pipeline, inputs } = verdicts([APPROVED]);
    const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'enforce', log: SILENT });

    const answer = await service.chat({ userMessage: 'frage' });

    assert.equal(inputs.length, 0, 'the verifier ran raw behind an active shield');
    assert.equal(answer.verifier, undefined);
  });

  it('never verifies a server-rendered answer, but still finalizes it', async () => {
    const { orchestrator, state } = stubOrchestrator({
      results: [turn('| Name | Gehalt |', { answerSource: 'privacy-render', maskedValues: ['x'] })],
      handOver: true,
      privacyActive: true,
    });
    const { pipeline, inputs } = verdicts([APPROVED]);
    const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'enforce', log: SILENT });

    const answer = await service.chat({ userMessage: 'Tabelle bitte' });

    assert.equal(inputs.length, 0);
    assert.equal(state.continuations[0]!.finalizeCalls, 1);
    assert.deepEqual(answer.privacyReceipt, state.continuations[0]!.receipt);
  });

  it('skips a turn whose continuation has no view (Direct Line relay) and still attaches its receipt', async () => {
    const { orchestrator, state } = stubOrchestrator({
      results: [turn('Antwort des Spezialisten mit 100 €.')],
      handOver: true,
      privacyActive: true,
      continuation: () => ({ wireAnswer: undefined }),
    });
    const { pipeline, inputs } = verdicts([APPROVED]);
    const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'enforce', log: SILENT });

    const answer = await service.chat({ userMessage: '#spezialist frage' });

    assert.equal(inputs.length, 0);
    assert.equal(state.continuations[0]!.finalizeCalls, 1);
    assert.deepEqual(answer.privacyReceipt, state.continuations[0]!.receipt);
  });

  it('covers a routine-shaped caller (scheduler / conductor) the same way', async () => {
    const { orchestrator, state } = stubOrchestrator({
      results: [turn('Routine erledigt: 3 Rechnungen über 100 € offen.')],
      handOver: true,
      privacyActive: true,
    });
    const { pipeline, inputs } = verdicts([APPROVED]);
    const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'shadow', log: SILENT });

    await service.chat({
      userMessage: 'Scheduled run: perform your configured routine.',
      sessionScope: 'schedule:sched-1',
    });

    assert.equal(inputs[0]!.privacy, state.continuations[0]!.verifierPrivacy);
    assert.equal(state.continuations[0]!.finalizeCalls, 1);
  });

  it('without a shield the wrapper behaves as before (no hand-over, raw verification)', async () => {
    const { orchestrator, state } = stubOrchestrator({
      results: [turn('Die Rechnung RE-1 beträgt 100 €.')],
      handOver: false,
      privacyActive: false,
    });
    const { pipeline, inputs } = verdicts([APPROVED]);
    const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'enforce', log: SILENT });

    const answer = await service.chat({ userMessage: 'frage' });

    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.privacy, undefined);
    assert.equal(state.continuations.length, 0);
    assert.equal(answer.verifier?.status, 'verified');
  });
});

// --- chatStream() ----------------------------------------------------------

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
    const done = events[1] as Extract<ChatStreamEvent, { type: 'done' }>;
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
      assert.deepEqual(
        (events[0] as Extract<ChatStreamEvent, { type: 'done' }>).privacyReceipt,
        state.continuations[0]!.receipt,
      );
    }
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

  it('a pipeline failure still finalizes and delivers done', async () => {
    const { orchestrator, state } = stubOrchestrator({ stream: [DONE], handOver: true, privacyActive: true });
    const pipeline = {
      verify: async (): Promise<VerifierVerdict> => {
        throw new Error('verifier provider down');
      },
    } as unknown as VerifierPipeline;
    const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'shadow', log: SILENT });

    const events = await collect(service.chatStream({ userMessage: 'frage' }));

    assert.equal(events[0]?.type, 'done');
    assert.equal(state.continuations[0]!.finalizeCalls, 1);
  });
});
