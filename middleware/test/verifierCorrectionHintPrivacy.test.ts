/**
 * The verifier's correction hint reaches the model like the user's own
 * prompt: masked through the pass's prompt map, and without the verifier's
 * evidence.
 *
 * A correction retry re-enters the turn with a hint in the system prompt
 * that quotes each contradicted claim. Claims are cut from the answer AFTER
 * the #361 restore, so they hold the real values the prompt mask kept from
 * the model; and the hint used to quote what the verifier measured as well —
 * Odoo values, knowledge-graph snippets, lookup details, fetched with the
 * verifier's own access, not the user's. The hint went into `system` unmasked,
 * on `chat()` and — since the stream retries too — on every streamed turn.
 *
 * Now the hint carries the claims only (`buildCorrectionPrompt`) and goes
 * through the same prompt mask as the message (`maskPromptForWire`): its
 * masked spans land on the request's receipt, and a re-entry whose prompt
 * cannot be masked is abandoned — the first answer's verdict stands.
 *
 * Drives the REAL `Orchestrator` under the REAL `VerifierService`; only the
 * model, the pipeline, the verdict store and the privacy service are
 * scripted. All values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmRequest } from '@omadia/llm-provider';
import type { ClaimVerdict, VerifierVerdict } from '@omadia/verifier';

import type { ChatTurnInput } from '../packages/harness-channel-sdk/src/chatAgent.js';
import { promptMaskingPrivacy, surrogate } from './_helpers/promptMaskingPrivacy.js';
import { REQUEST, doneOf, drain, text, verifiedTurn } from './_helpers/replayTurnFixture.js';
import { approved } from './_helpers/verifierVerdictFixtures.js';

const ADDRESS = 'max@kunde.example';
const WITH_ADDRESS: ChatTurnInput = {
  ...REQUEST,
  userMessage: `Lege die Rechnung über 1.200 EUR für ${ADDRESS} an.`,
};
/** The first answer as the model writes it (the address as its surrogate)… */
const FIRST_WIRE = `Die Rechnung für ${surrogate(1)} über 1.250 EUR ist angelegt.`;
/** …and the claim the verifier cut from the restored answer. */
const CLAIM = `Rechnung für ${ADDRESS} über 1.250 EUR`;
const CORRECTED_WIRE = `Die Rechnung für ${surrogate(1)} über 1.200 EUR ist angelegt.`;
/** What the verifier measured, with its own access. Never for the model. */
const TRUTH = 'Quelle: 1.200 EUR, Ansprechpartnerin Erika Beispiel';
const DETAIL = 'no res.partner with name="Interne Notiz 4411"';
const HINT_HEADER = 'Verifier hat Widersprüche';

function blockedWithEvidence(claimText: string = CLAIM): VerifierVerdict {
  const contradiction: ClaimVerdict = {
    status: 'contradicted',
    claim: {
      id: 'c_amount',
      text: claimText,
      type: 'amount',
      expectedSource: 'odoo',
      relatedEntities: [],
    },
    truth: TRUTH,
    source: 'odoo',
    detail: DETAIL,
  };
  return {
    status: 'blocked',
    claims: [contradiction],
    contradictions: [contradiction],
    latencyMs: 3,
  };
}

/** The `system` argument of one provider request, as text. */
function systemOf(request: LlmRequest | undefined): string {
  const system = (request as { system?: unknown } | undefined)?.system;
  return typeof system === 'string' ? system : JSON.stringify(system ?? '');
}

function setup(options: {
  responses: Parameters<typeof verifiedTurn>[0]['responses'];
  verdicts: Parameters<typeof verifiedTurn>[0]['verdicts'];
  blockHint?: boolean;
}) {
  const privacy = promptMaskingPrivacy(
    options.blockHint === true ? { blockWhen: (t) => t.includes(HINT_HEADER) } : {},
  );
  const t = verifiedTurn({
    responses: options.responses,
    verdicts: options.verdicts,
    orchestrator: { privacyGuard: () => privacy.service },
  });
  return { t, privacy };
}

/** The retry's system prompt as the stream path sends it. */
async function streamRetrySystem(): Promise<{ system: string; t: ReturnType<typeof setup>['t'] }> {
  const { t } = setup({
    responses: [text(FIRST_WIRE), text(CORRECTED_WIRE)],
    verdicts: [blockedWithEvidence(), approved()],
  });
  const events = await drain(t.service.chatStream(WITH_ADDRESS));
  assert.equal(t.model.requests.length, 2, 'the stream ran its correction retry');
  assert.equal(doneOf(events)?.answer.includes(ADDRESS), true, 'the delivered answer is restored');
  return { system: systemOf(t.model.requests[1]), t };
}

describe('the correction hint crosses the wire masked', () => {
  it('MUTATION CHECK stream: the retry’s system prompt carries no restored value', async () => {
    const { system } = await streamRetrySystem();
    assert.ok(system.includes(HINT_HEADER), 'the retry got the correction hint');
    assert.equal(system.includes(ADDRESS), false, 'the restored address went to the provider');
    assert.ok(system.includes(surrogate(1)), 'the claim is quoted with the turn’s own surrogate');
  });

  it('MUTATION CHECK chat(): the retry’s system prompt carries no restored value', async () => {
    const { t } = setup({
      responses: [text(FIRST_WIRE), text(CORRECTED_WIRE)],
      verdicts: [blockedWithEvidence(), approved()],
    });

    const sa = await t.service.chat(WITH_ADDRESS);

    assert.equal(t.model.requests.length, 2);
    const system = systemOf(t.model.requests[1]);
    assert.ok(system.includes(HINT_HEADER));
    assert.equal(system.includes(ADDRESS), false, 'the restored address went to the provider');
    assert.ok(system.includes(surrogate(1)));
    assert.equal(sa.text.includes(ADDRESS), true, 'the delivered answer is restored');
  });

  it('the masked spans of the hint are on the request’s receipt', async () => {
    // The user named no address; only the first answer did, so only the
    // hint that quotes it can put one on the wire.
    const { t } = setup({
      responses: [text(`Die Rechnung für ${ADDRESS} über 1.250 EUR ist angelegt.`), text('Die Rechnung über 1.200 EUR ist angelegt.')],
      verdicts: [blockedWithEvidence(), approved()],
    });

    const events = await drain(t.service.chatStream({ ...REQUEST, userMessage: 'Lege die Rechnung über 1.200 EUR an.' }));

    assert.equal(systemOf(t.model.requests[1]).includes(ADDRESS), false);
    assert.deepEqual(doneOf(events)?.privacyReceipt?.maskedPromptSpans, [{ type: 'email', detector: 'c0' }]);
  });

  it('a retry whose hint cannot be masked is abandoned; the first verdict stands (stream)', async () => {
    const { t } = setup({
      responses: [text(FIRST_WIRE)],
      verdicts: [blockedWithEvidence()],
      blockHint: true,
    });

    const events = await drain(t.service.chatStream(WITH_ADDRESS));

    assert.equal(t.model.requests.length, 1, 'the unmasked hint never reached the provider');
    const terminal = doneOf(events);
    assert.equal(terminal?.answerSource, 'verifier-blocked');
    assert.equal(terminal?.verifier?.badge, 'failed');
    assert.equal(JSON.stringify(events).includes('privacy protection for your text'), false);
    assert.deepEqual(t.persisted, [{ status: 'blocked', retryCount: 0 }]);
    assert.ok(t.logs.some((l) => /retry abandoned/.test(l)), t.logs.join(' | '));
  });

  it('a retry whose hint cannot be masked is abandoned; the first verdict stands (chat)', async () => {
    const { t } = setup({
      responses: [text(FIRST_WIRE)],
      verdicts: [blockedWithEvidence()],
      blockHint: true,
    });

    const sa = await t.service.chat(WITH_ADDRESS);

    assert.equal(t.model.requests.length, 1, 'the unmasked hint never reached the provider');
    assert.equal(sa.text.includes('privacy protection for your text'), false);
    assert.deepEqual(t.persisted, [{ status: 'blocked', retryCount: 0 }]);
    assert.ok(t.logs.some((l) => /retry abandoned/.test(l)), t.logs.join(' | '));
  });
});

describe('the correction hint carries no verifier evidence', () => {
  it('MUTATION CHECK: neither the measured value nor the check’s detail reach the retry', async () => {
    const { system } = await streamRetrySystem();
    assert.equal(system.includes('Erika Beispiel'), false, 'the measured truth reached the model');
    assert.equal(system.includes('Interne Notiz 4411'), false, 'the check’s detail reached the model');
    assert.equal(system.includes('1.200 EUR'), false, 'the verifier’s figure reached the model');
  });
});
