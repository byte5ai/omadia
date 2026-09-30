/**
 * VerifierService.chat binds its model requests to the privacy view of the
 * turn it verifies and finalizes that turn's privacy state only afterwards —
 * exactly once per turn, on success, on failure and on every retry path.
 * The streaming side lives in verifierServiceStreamPrivacyEgress.test.ts.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatTurnInput } from '../packages/harness-channel-sdk/src/chatAgent.js';
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

  it('still finalizes and delivers the answer when the verifier pipeline throws', async () => {
    const { orchestrator, state } = stubOrchestrator({
      results: [turn('Die Rechnung RE-1 beträgt 100 €.')],
      handOver: true,
      privacyActive: true,
    });
    const service = new VerifierService({
      orchestrator,
      pipeline: failingPipeline(),
      enabled: true,
      mode: 'enforce',
      log: SILENT,
    });

    const answer = await service.chat({ userMessage: 'frage' });

    assert.equal(answer.text.startsWith('Die Rechnung RE-1'), true);
    assert.equal(state.continuations[0]!.finalizeCalls, 1);
    assert.deepEqual(answer.privacyReceipt, state.continuations[0]!.receipt);
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
