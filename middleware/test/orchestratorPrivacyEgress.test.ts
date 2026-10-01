/**
 * Orchestrator side of the verifier's privacy hand-over, against the REAL
 * Orchestrator and the REAL privacy-guard service (prompt masking on):
 *
 *   - a held turn returns without a receipt, keeps its privacy state alive
 *     and hands a continuation over; `finalize()` then finalizes and persists
 *     exactly once, with the model attribution captured at hand-over;
 *   - an unheld turn behaves exactly as before;
 *   - the continuation's view is the turn's WIRE view (pre-restore answer,
 *     masked prompt) — never a real value, never a server-rendered answer;
 *   - a caller-supplied system hint (the verifier's correction) reaches the
 *     model only masked, and a blocked mask refuses the turn;
 *   - a thrown or abandoned turn drops its privacy state and keeps its
 *     receipt: its own row, or under a request ledger the request's one row
 *     (a re-entry's receipt joins it; the first run, finalized later, still
 *     takes the row over);
 *   - the streaming paths (model turn, Direct Line) hand over the same way.
 *
 * The verifier wrapped around this, end to end: verifierPrivacyEgressEndToEnd.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import { ToolReplayLedger, createDomainTool, type ChatTurnInput } from '@omadia/orchestrator';
import type { PrivacyGuardService, TurnReceiptRecordInput } from '@omadia/plugin-api';
import { findIdentityLeaks } from '@omadia/plugin-privacy-guard/dist/v4/onTheWire.js';

import {
  RAW_EMAIL,
  SURROGATE_EMAIL,
  buildOrch,
  countingService,
  doneOf,
  drain,
  echoingProvider,
} from './_helpers/privacyEgressHarness.js';

/** The echoing model for its first `answers` buffered calls, then a provider
 *  that fails — after the turn sent its (masked) prompt. */
function failingProvider(answers = 0): LlmProvider {
  const echoing = echoingProvider();
  let calls = 0;
  return {
    ...echoing,
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      calls += 1;
      if (calls > answers) throw new Error('provider down');
      return echoing.complete(req);
    },
  } as unknown as LlmProvider;
}

/** The counting privacy service whose every receipt names its turn, so a
 *  request's merged receipt shows which passes it covers. */
function passTaggingService(): PrivacyGuardService {
  const { service } = countingService();
  return {
    ...service,
    finalizeTurn: async (turnId, turnInput) => {
      const receipt = await service.finalizeTurn(turnId, turnInput);
      return receipt && { ...receipt, verbsExecuted: [`pass:${turnId}`] };
    },
  };
}

describe('orchestrator — privacy hand-over for the verifier (runTurn)', () => {
  it('a held turn keeps its privacy state until the continuation finalizes it, then persists once', async () => {
    const { service, finalizeCalls } = countingService();
    const recorded: TurnReceiptRecordInput[] = [];
    const modelRequests: string[] = [];
    const orch = buildOrch({ service, provider: echoingProvider(modelRequests), recorded });
    const input: ChatTurnInput = {
      userMessage: `Bitte schreibe an ${RAW_EMAIL} heute`,
      sessionScope: 'sess-held',
      userId: 'u1',
      channelIdentity: { channelKind: 'teams', channelUserId: 'aad-1' },
    };

    orch.markPrivacyFinalizeHeld(input);
    const result = await orch.runTurn(input);

    assert.equal(result.privacyReceipt, undefined, 'a held turn must not attach a receipt');
    assert.equal(finalizeCalls(), 0, 'finalizeTurn ran before the verifier');
    assert.equal(recorded.length, 0);
    assert.ok(result.answer.includes(RAW_EMAIL), 'the user still gets the restored answer');

    const egress = orch.takePrivacyEgress(input);
    assert.ok(egress, 'no continuation was handed over');
    assert.equal(orch.takePrivacyEgress(input), undefined, 'a continuation is taken once');
    const view = egress.verifierPrivacy;
    assert.ok(view);
    // The verifier's view is the WIRE view: the model's own answer (surrogate)
    // and the prompt exactly as the model received it.
    assert.deepEqual(findIdentityLeaks(view.wireAnswer, [RAW_EMAIL]), []);
    assert.match(view.wireAnswer, SURROGATE_EMAIL);
    assert.deepEqual(findIdentityLeaks(view.wireUserMessage, [RAW_EMAIL]), []);
    assert.match(view.wireUserMessage, SURROGATE_EMAIL);
    assert.ok(modelRequests[0]!.includes(view.wireUserMessage), 'not the prompt the model received');
    assert.equal(await view.restore(view.wireAnswer), result.answer);
    // One verifier request (the extractor's) is admitted through the view.
    await view.admitWireView();

    const receipt = await egress.finalize();
    assert.equal(finalizeCalls(), 1);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.turnId, egress.receiptId);
    assert.deepEqual(recorded[0]!.receipt, receipt);
    // Attribution captured at hand-over survives the deferred persist.
    assert.equal(recorded[0]!.model, 'test-model');
    // Turn spans and verifier requests are booked apart; admitting the wire
    // view masked nothing new.
    assert.ok((receipt?.maskedPromptSpans ?? []).some((s) => s.type === 'email'));
    assert.equal(receipt?.verifierEgress?.requests, 1);
    assert.deepEqual(receipt?.verifierEgress?.maskedSpans, []);

    // Idempotent: a second finalize neither re-finalizes nor re-persists.
    assert.deepEqual(await egress.finalize(), receipt);
    assert.equal(finalizeCalls(), 1);
    assert.equal(recorded.length, 1);
  });

  it('hands over an MCP input-card reply as the label its model saw, on both paths', async () => {
    const envelope = `__mcp_input_reply__ ${JSON.stringify({
      correlationId: 'x',
      inputResponses: { password: 'private-secret-value' },
    })}`;
    for (const path of ['runTurn', 'chatStream'] as const) {
      const { service } = countingService();
      const orch = buildOrch({ service, provider: echoingProvider() });
      const input = { userMessage: envelope, sessionScope: `sess-mcp-${path}` };

      orch.markPrivacyFinalizeHeld(input);
      if (path === 'runTurn') await orch.runTurn(input);
      else await drain(orch.chatStream(input));

      const egress = orch.takePrivacyEgress(input);
      assert.equal(egress?.verifierPrivacy?.wireUserMessage, '[Eingaben übermittelt: password]', path);
      await egress?.finalize();
    }
  });

  it('an unheld turn finalizes itself exactly as before', async () => {
    const { service, finalizeCalls } = countingService();
    const recorded: TurnReceiptRecordInput[] = [];
    const orch = buildOrch({ service, provider: echoingProvider(), recorded });
    const input = { userMessage: `Bitte schreibe an ${RAW_EMAIL} heute`, sessionScope: 'sess-plain' };

    const result = await orch.runTurn(input);

    assert.ok(result.privacyReceipt);
    assert.equal(finalizeCalls(), 1);
    assert.equal(recorded.length, 1);
    assert.equal(orch.takePrivacyEgress(input), undefined);
    assert.equal(result.privacyReceipt.verifierEgress, undefined);
  });

  it('the hold is one-shot: a later run with the same object finalizes itself', async () => {
    const { service, finalizeCalls } = countingService();
    const orch = buildOrch({ service, provider: echoingProvider() });
    const input = { userMessage: `Bitte schreibe an ${RAW_EMAIL} heute`, sessionScope: 'sess-once' };

    orch.markPrivacyFinalizeHeld(input);
    await orch.runTurn(input);
    const egress = orch.takePrivacyEgress(input);
    await egress?.finalize();
    const again = await orch.runTurn(input);

    assert.ok(again.privacyReceipt, 'the second run was still held');
    assert.equal(finalizeCalls(), 2);
  });

  it('a server-rendered answer is handed over without a view for the verifier', async () => {
    // A v4 render materializes real values the turn's model never saw; the
    // verifier must not get them, but the wrapper still owns the finalize.
    const rendered = `| Name | E-Mail |\n| Jana | ${RAW_EMAIL} |`;
    const { service, finalizeCalls } = countingService(true, {
      takeRenderedAnswerV4: async () => ({ text: rendered, maskedValues: [RAW_EMAIL] }),
    });
    const orch = buildOrch({ service, provider: echoingProvider() });
    const input = { userMessage: 'Tabelle bitte', sessionScope: 'sess-render' };

    orch.markPrivacyFinalizeHeld(input);
    const result = await orch.runTurn(input);

    assert.equal(result.answerSource, 'privacy-render');
    assert.equal(result.answer, rendered);
    const egress = orch.takePrivacyEgress(input);
    assert.ok(egress, 'the render site did not hand over');
    assert.equal(egress.verifierPrivacy, undefined, 'rendered values must not reach the verifier');
    assert.equal(finalizeCalls(), 0);
    await egress.finalize();
    assert.equal(finalizeCalls(), 1);
  });

  it('a correction hint reaches the model only as surrogates', async () => {
    const { service } = countingService();
    const requests: string[] = [];
    const orch = buildOrch({ service, provider: echoingProvider(requests) });

    await orch.runTurn({
      userMessage: 'Wie ist der Stand?',
      sessionScope: 'sess-hint',
      extraSystemHint: `# Verifier hat Widersprüche erkannt\n- Behauptet: "Mail an ${RAW_EMAIL} ist raus" → widerspricht der Quelle`,
    });

    assert.ok(requests.length > 0);
    for (const request of requests) {
      assert.deepEqual(findIdentityLeaks(request, [RAW_EMAIL]), []);
    }
    assert.match(requests[0]!, /Behauptet: \\"Mail an [a-z]+\.[a-z]+@example\.net ist raus/);
  });

  it('a blocked hint mask refuses the turn instead of sending the raw hint', async () => {
    const requests: string[] = [];
    const service: PrivacyGuardService = {
      internToolResultV4: async () => ({ digestText: '', datasetId: 'ds' }),
      recordBypassedTool: async () => undefined,
      runV4Tool: async () => ({ resultText: '' }),
      subAgentResultV4: async () => ({ resultText: '' }),
      takeRenderedAnswerV4: async () => undefined,
      v4ToolSpecs: () => [],
      finalizeTurn: async () => undefined,
      maskUserPrompt: async (request) =>
        request.text.includes('HINT-VALUE-4711')
          ? { outcome: 'blocked', reason: 'test' }
          : { outcome: 'disabled' },
    };
    const orch = buildOrch({ service, provider: echoingProvider(requests) });

    const result = await orch.runTurn({
      userMessage: 'Wie ist der Stand?',
      sessionScope: 'sess-hint-blocked',
      extraSystemHint: 'Behauptet: "HINT-VALUE-4711"',
    });

    assert.equal(requests.length, 0, 'the model was called with an unmaskable hint');
    assert.match(result.answer, /privacy protection for your text/);
  });

  it('a turn that throws drops its privacy state and keeps its receipt', async () => {
    const { service, finalizeCalls } = countingService();
    const recorded: TurnReceiptRecordInput[] = [];
    const orch = buildOrch({ service, provider: failingProvider(), recorded });

    await assert.rejects(
      orch.runTurn({ userMessage: `Bitte schreibe an ${RAW_EMAIL} heute`, sessionScope: 'sess-throw' }),
    );
    assert.equal(finalizeCalls(), 1);
    // The prompt was masked and sent before the provider failed: the receipt
    // says so, and it is persisted like a delivered turn's.
    assert.equal(recorded.length, 1);
    assert.ok((recorded[0]!.receipt.maskedPromptSpans ?? []).some((s) => s.type === 'email'));
  });

  it('under a request ledger, a first run that throws owns the request’s row', async () => {
    const { service } = countingService();
    const recorded: TurnReceiptRecordInput[] = [];
    const orch = buildOrch({ service, provider: failingProvider(), recorded });
    const input = { userMessage: `Bitte schreibe an ${RAW_EMAIL} heute`, sessionScope: 'sess-throw-bound' };
    const ledger = new ToolReplayLedger();
    const release = orch.bindToolReplayLedger(input, ledger);

    await assert.rejects(orch.runTurn(input));
    release();

    assert.equal(recorded.length, 0, 'the binder writes the request’s row, not the pass');
    assert.ok(ledger.receipts.rowId, 'the first run offered to own the row');
    await ledger.receipts.commit();
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.turnId, ledger.receipts.rowId);
    assert.ok((recorded[0]!.receipt.maskedPromptSpans ?? []).some((s) => s.type === 'email'));
  });

  it('a re-entry that throws joins the request’s receipt without taking its row', async () => {
    const recorded: TurnReceiptRecordInput[] = [];
    const orch = buildOrch({ service: passTaggingService(), provider: failingProvider(1), recorded });
    const input = { userMessage: `Bitte schreibe an ${RAW_EMAIL} heute`, sessionScope: 'sess-reentry-throw' };
    const ledger = new ToolReplayLedger();
    const release = orch.bindToolReplayLedger(input, ledger);

    // Held like under `enforce`: the first run's receipt joins the request's
    // only when its verifier finalizes it — after the re-entry.
    orch.markPrivacyFinalizeHeld(input);
    await orch.runTurn(input);
    const first = orch.takePrivacyEgress(input);
    assert.ok(first);
    ledger.beginReentry();
    await assert.rejects(orch.runTurn(input));
    // No earlier pass's receipt yet: the re-entry holds the row for now.
    const heldByReentry = ledger.receipts.rowId;
    assert.ok(heldByReentry, 'the re-entry that threw did not offer to own the row');
    assert.notEqual(heldByReentry, first.receiptId);
    await first.finalize();
    release();

    assert.equal(ledger.receipts.rowId, first.receiptId, 'the first run takes the row over');
    assert.equal(ledger.receipts.merged()?.verbsExecuted.length, 2, 'both passes are in the receipt');
    await ledger.receipts.commit();
    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0]!.receipt, ledger.receipts.merged());
  });
});

describe('orchestrator — privacy hand-over for the verifier (chatStream)', () => {
  it('a held stream emits done without a receipt and hands the wire view over', async () => {
    const { service, finalizeCalls } = countingService();
    const recorded: TurnReceiptRecordInput[] = [];
    const orch = buildOrch({ service, provider: echoingProvider(), recorded });
    const input = { userMessage: `Bitte schreibe an ${RAW_EMAIL} heute`, sessionScope: 'sess-stream' };

    orch.markPrivacyFinalizeHeld(input);
    const done = doneOf(await drain(orch.chatStream(input)));

    assert.ok(done);
    assert.equal(done.privacyReceipt, undefined);
    assert.equal(done.receiptId, undefined);
    assert.ok(done.answer.includes(RAW_EMAIL));
    assert.equal(finalizeCalls(), 0);
    const egress = orch.takePrivacyEgress(input);
    assert.ok(egress?.verifierPrivacy);
    assert.deepEqual(findIdentityLeaks(egress.verifierPrivacy.wireAnswer, [RAW_EMAIL]), []);

    await egress.finalize();
    assert.equal(finalizeCalls(), 1);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.turnId, egress.receiptId);
  });

  it('the Direct Line site hands over too — with no view for the verifier', async () => {
    const { service, finalizeCalls } = countingService();
    const recorded: TurnReceiptRecordInput[] = [];
    const tool = createDomainTool({
      name: 'ask_strategist',
      description: 'Strategy sparring partner',
      domain: 'strategy',
      agentId: 'de.byte5.agent.strategist',
      agent: { ask: async (question: string) => `Antwort auf: ${question}` },
    });
    const orch = buildOrch({ service, provider: echoingProvider(), recorded, domainTools: [tool] });
    const input = {
      userMessage: `#strategist Schreib an ${RAW_EMAIL} bitte`,
      sessionScope: 'sess-direct',
    };

    orch.markPrivacyFinalizeHeld(input);
    const done = doneOf(await drain(orch.chatStream(input)));

    assert.ok(done?.delegatedAnswer, 'not a Direct Line turn');
    assert.equal(done.privacyReceipt, undefined);
    const egress = orch.takePrivacyEgress(input);
    assert.ok(egress, 'the Direct Line site did not hand over');
    assert.equal(egress.verifierPrivacy, undefined, 'a restored relay must not reach the verifier');
    assert.equal(finalizeCalls(), 0);
    await egress.finalize();
    assert.equal(finalizeCalls(), 1);
    assert.equal(recorded.length, 1);
  });

  it('a stream abandoned before done drops its privacy state and keeps its receipt', async () => {
    const { service, finalizeCalls } = countingService();
    const recorded: TurnReceiptRecordInput[] = [];
    const orch = buildOrch({ service, provider: echoingProvider(), recorded });

    for await (const event of orch.chatStream({
      userMessage: `Bitte schreibe an ${RAW_EMAIL} heute`,
      sessionScope: 'sess-abandon',
    })) {
      if (event.type === 'text_delta') break;
    }

    assert.equal(finalizeCalls(), 1);
    assert.equal(recorded.length, 1, 'the masked prompt went out: the receipt is persisted');
    assert.ok((recorded[0]!.receipt.maskedPromptSpans ?? []).some((s) => s.type === 'email'));
  });

  it('a stream re-entry the client leaves joins the request’s receipt without taking its row', async () => {
    const recorded: TurnReceiptRecordInput[] = [];
    const orch = buildOrch({ service: passTaggingService(), provider: echoingProvider(), recorded });
    const input = { userMessage: `Bitte schreibe an ${RAW_EMAIL} heute`, sessionScope: 'sess-abandon-bound' };
    const ledger = new ToolReplayLedger();
    const release = orch.bindToolReplayLedger(input, ledger);

    orch.markPrivacyFinalizeHeld(input);
    await drain(orch.chatStream(input));
    const first = orch.takePrivacyEgress(input);
    assert.ok(first);
    ledger.beginReentry();
    for await (const event of orch.chatStream(input)) {
      if (event.type === 'text_delta') break;
    }
    // No earlier pass's receipt yet: the re-entry holds the row for now.
    const heldByReentry = ledger.receipts.rowId;
    assert.ok(heldByReentry, 'the abandoned re-entry did not offer to own the row');
    assert.notEqual(heldByReentry, first.receiptId);
    await first.finalize();
    release();

    assert.equal(ledger.receipts.rowId, first.receiptId, 'the first run takes the row over');
    await ledger.receipts.commit();
    assert.equal(recorded.length, 1, 'one row for the request');
    assert.equal(recorded[0]!.turnId, first.receiptId);
    assert.equal(recorded[0]!.receipt.verbsExecuted.length, 2, 'both passes are in the row');
  });
});
