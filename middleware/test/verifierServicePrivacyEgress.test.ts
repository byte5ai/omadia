/**
 * VerifierService.chat binds its model requests to the privacy view of the
 * turn it verifies and finalizes that turn's privacy state only afterwards —
 * exactly once per turn, on success, on failure and on every retry path.
 * The streaming side lives in verifierServiceStreamPrivacyEgress.test.ts.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  ChatTurnInput,
  ChatTurnResult,
} from '../packages/harness-channel-sdk/src/chatAgent.js';
import type { SemanticAnswer } from '../packages/harness-channel-sdk/src/outgoing.js';
import {
  PROMPT_MASK_BLOCKED_ANSWER,
  SECURITY_QUARANTINE_NOTICE,
} from '../packages/harness-orchestrator/src/orchestrator.js';
import { mergePrivacyReceipts } from '../packages/harness-orchestrator/src/requestReceipts.js';
import { VerifierService } from '../packages/harness-orchestrator/src/verifierService.js';
import {
  APPROVED,
  BLOCKED,
  BORDERLINE,
  SILENT,
  TRUTH,
  failingPipeline,
  stubOrchestrator,
  turn,
  verdicts,
} from './_helpers/verifierEgressStub.js';

/**
 * A turn whose run trace names the pass it ran as. The delivered pass then
 * shows up as the consulted agent — also on a withheld answer, which keeps
 * the delivered pass's run trace.
 */
function passTurn(answer: string, pass: number): ChatTurnResult {
  return turn(answer, {
    runTrace: {
      scope: 'test',
      startedAt: '2026-10-01T00:00:00Z',
      finishedAt: '2026-10-01T00:00:01Z',
      durationMs: 1,
      status: 'success',
      iterations: 1,
      orchestratorToolCalls: [],
      agentInvocations: [
        {
          index: 0,
          agentName: 'pass_marker',
          agentId: `pass-${String(pass)}`,
          durationMs: 1,
          subIterations: 1,
          status: 'success',
          toolCalls: [],
        },
      ],
    },
  });
}

function deliveredPass(answer: SemanticAnswer): string | undefined {
  return answer.agentsConsulted?.[0]?.agentId;
}

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
    // ONE receipt for the request: every pass's, each finalized after the
    // verifier — so it counts the verifier's requests of all three — and
    // one row written for it.
    const merged = mergePrivacyReceipts(state.continuations.map((c) => c.receipt));
    assert.deepEqual(answer.privacyReceipt, merged);
    assert.equal(merged?.verifierEgress?.requests, 1 + 2 + 3);
    assert.deepEqual(state.rows, [merged]);
  });

  for (const mode of ['shadow', 'enforce'] as const) {
    it(`still finalizes once when the verifier pipeline throws (${mode})`, async () => {
      const { orchestrator, state } = stubOrchestrator({
        results: [turn('Die Rechnung RE-1 beträgt 100 €.')],
        handOver: true,
        privacyActive: true,
      });
      const service = new VerifierService({
        orchestrator,
        pipeline: failingPipeline(),
        enabled: true,
        mode,
        log: SILENT,
      });

      const answer = await service.chat({ userMessage: 'frage' });

      // `shadow` delivers the answer; `enforce` fails closed and withholds an
      // answer the verifier could not check (`unavailable`).
      assert.equal(answer.text.startsWith('Die Rechnung RE-1'), mode === 'shadow');
      assert.equal(state.continuations[0]!.finalizeCalls, 1);
      assert.deepEqual(answer.privacyReceipt, state.continuations[0]!.receipt);
    });
  }

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
      results: [passTurn('Erste Antwort.', 0), passTurn('Zweite Antwort mit Platzhalter.', 1)],
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
    // The retry answer would show a fake value, so it is not judged and the
    // first verdict stands: `enforce` withholds the answer, and the request
    // delivered is the first turn's — never the retry's.
    assert.equal(answer.answerSource, 'verifier-blocked');
    assert.equal(answer.text.includes('Platzhalter'), false, 'the retry answer was shown');
    assert.equal(answer.verifier?.status, 'failed');
    assert.equal(deliveredPass(answer), 'pass-0');
    assert.deepEqual(
      answer.privacyReceipt,
      mergePrivacyReceipts(state.continuations.map((c) => c.receipt)),
    );
    assert.deepEqual(
      state.continuations.map((c) => c.finalizeCalls),
      [1, 1],
    );
  });

  // A borderline first answer, a re-sample that escalates to blocked and whose
  // restored text still carries a placeholder the model reworded ("10.000 €"
  // for "€10000"): whatever happens to the retry, the re-sample never
  // replaces the first answer — the user would see a fake value. Blocked in
  // `enforce`, the answer is withheld either way; the delivered request is
  // the first turn's (its receipt), never the re-sample's.
  describe('a blocked re-sample with unresolved placeholders', () => {
    const FIRST = 'Die Prämie ist beantragt.';
    const RESAMPLE = 'Die Prämie beträgt 10.000 €.';

    function resampleCase(opts: {
      readonly unresolved: number;
      readonly withholdRetry?: boolean;
      readonly retry?: 'blocked-unresolved';
      readonly maxRetries?: number;
    }): { service: VerifierService; state: ReturnType<typeof stubOrchestrator>['state'] } {
      const { orchestrator, state } = stubOrchestrator({
        results: [
          passTurn(FIRST, 0),
          passTurn(RESAMPLE, 1),
          passTurn('Dritte Antwort 10.000 €.', 2),
        ],
        handOver: true,
        privacyActive: true,
        continuation: (i, r) => ({
          wireAnswer: r.answer,
          unresolved: i === 1 ? opts.unresolved : i === 2 ? 1 : 0,
          maskWouldAlter: i === 1 && opts.withholdRetry === true,
        }),
      });
      const { pipeline } = verdicts([BORDERLINE, BLOCKED, BLOCKED]);
      const service = new VerifierService({
        orchestrator,
        pipeline,
        enabled: true,
        mode: 'enforce',
        ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
        log: SILENT,
      });
      return { service, state };
    }

    it('is not shown when the retry is withheld — the first answer is', async () => {
      const { service, state } = resampleCase({ unresolved: 1, withholdRetry: true });

      const answer = await service.chat({ userMessage: 'Wie hoch ist die Prämie?' });

      assert.equal(state.runs.length, 2, 'a retry ran although its hint was withheld');
      assert.equal(answer.answerSource, 'verifier-blocked');
      assert.equal(answer.text.includes(RESAMPLE), false, 'the re-sample with a placeholder was shown');
      assert.equal(answer.verifier?.status, 'failed');
      assert.equal(deliveredPass(answer), 'pass-0');
      assert.deepEqual(state.continuations.map((c) => c.finalizeCalls), [1, 1]);
    });

    it('is not shown when no retry is allowed — the first answer is', async () => {
      const { service, state } = resampleCase({ unresolved: 1, maxRetries: 0 });

      const answer = await service.chat({ userMessage: 'Wie hoch ist die Prämie?' });

      assert.equal(state.runs.length, 2);
      assert.equal(answer.answerSource, 'verifier-blocked');
      assert.equal(answer.text.includes(RESAMPLE), false, 'the re-sample with a placeholder was shown');
      assert.equal(answer.verifier?.status, 'failed');
      assert.equal(deliveredPass(answer), 'pass-0');
    });

    it('is not shown when the retry is still blocked with placeholders too', async () => {
      const { service, state } = resampleCase({ unresolved: 1 });

      const answer = await service.chat({ userMessage: 'Wie hoch ist die Prämie?' });

      assert.equal(state.runs.length, 3);
      assert.equal(answer.answerSource, 'verifier-blocked');
      assert.equal(answer.text.includes('10.000'), false, 'an answer with a placeholder was shown');
      assert.equal(answer.verifier?.status, 'failed');
      assert.equal(deliveredPass(answer), 'pass-0');
      assert.deepEqual(state.continuations.map((c) => c.finalizeCalls), [1, 1, 1]);
      assert.equal(state.rows.length, 1, 'one receipt row for the request');
    });

    it('control: a re-sample whose placeholders all resolved still replaces the first answer', async () => {
      const { service, state } = resampleCase({ unresolved: 0, withholdRetry: true });

      const answer = await service.chat({ userMessage: 'Wie hoch ist die Prämie?' });

      // Withheld as blocked, but the delivered request is the re-sample's.
      assert.equal(answer.answerSource, 'verifier-blocked');
      assert.equal(answer.verifier?.status, 'failed');
      assert.equal(deliveredPass(answer), 'pass-1');
    });
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

  it('hands the pipeline the label of an MCP input-card reply, never the envelope — shield or not', async () => {
    const envelope =
      '__mcp_input_reply__ {"correlationId":"x","inputResponses":{"password":"private-secret-value"}}';
    for (const shield of [false, true]) {
      const { orchestrator } = stubOrchestrator({
        results: [turn('Rechnung INV/2026/0042 ist verbucht.')],
        handOver: shield,
        privacyActive: shield,
      });
      const { pipeline, inputs } = verdicts([APPROVED]);
      const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'shadow', log: SILENT });

      await service.chat({ userMessage: envelope });

      assert.equal(inputs.length, 1);
      assert.equal(inputs[0]!.userMessage, '[Eingaben übermittelt: password]', `shield=${String(shield)}`);
    }
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

// The privacy refusal and the screening quarantine are notices the server
// composed for a turn whose model never ran: `enforce` releases them without
// a verdict, as it releases the other control-flow results — withholding them
// behind the fact-check notice would hide why the turn failed.
describe('VerifierService.chat (enforce) — server-composed notices', () => {
  for (const [label, notice] of [
    ['privacy refusal', PROMPT_MASK_BLOCKED_ANSWER],
    ['screening quarantine', SECURITY_QUARANTINE_NOTICE],
  ] as const) {
    it(`releases the ${label} unverified and still finalizes the turn once`, async () => {
      const { orchestrator, state } = stubOrchestrator({
        results: [turn(notice)],
        handOver: true,
        privacyActive: true,
        continuation: () => ({ wireAnswer: undefined }),
      });
      const { pipeline, inputs } = verdicts([APPROVED]);
      const service = new VerifierService({ orchestrator, pipeline, enabled: true, mode: 'enforce', log: SILENT });

      const answer = await service.chat({ userMessage: 'frage' });

      assert.equal(answer.text, notice);
      assert.equal(answer.answerSource, undefined, 'the notice was withheld');
      assert.equal(inputs.length, 0, 'the notice was sent to the verifier');
      assert.equal(state.continuations[0]!.finalizeCalls, 1);
      assert.deepEqual(answer.privacyReceipt, state.continuations[0]!.receipt);
    });
  }
});
