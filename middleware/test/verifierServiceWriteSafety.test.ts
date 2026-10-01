/**
 * A verifier re-entry never runs a tool handler twice for one user request.
 *
 * In `enforce` mode `VerifierService.chat` re-enters the turn: a borderline
 * verdict draws a second sample, a contradiction a correction retry, and a
 * resample that turns up a contradiction both. Each re-entry used to be a
 * complete fresh `runTurn` that executed whatever the model called again, so a
 * declared write ran two or three times for one request. A re-entry now
 * re-generates the answer over the first run's tool results: every call the
 * first run made is replayed from a per-request ledger, a call it did not make
 * runs only when the tool is read-only, and a re-entry that needs any other
 * call is abandoned before it runs.
 *
 * Drives the REAL `Orchestrator` under the REAL `VerifierService`; only the
 * model, the verifier pipeline and the verdict store are scripted. The
 * assertions are MUTATION CHECKS on the handler's execution log and on the
 * tool results the model was handed, never on internal state. All values are
 * synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { OrchestratorOptions } from '../packages/harness-orchestrator/src/orchestrator.js';
import {
  EMAIL,
  REQUEST,
  maskingPrivacy,
  registerWriteTool,
  text,
  toolCalls,
  toolResultContents,
  verifiedTurn,
} from './_helpers/replayTurnFixture.js';
import {
  approved,
  blocked,
  borderline,
} from './_helpers/verifierVerdictFixtures.js';

const INVOICE = { customer: 'K-1001', amount: 1200, currency: 'EUR' };
/** The same invoice with its keys in another order — the same call. */
const INVOICE_SHUFFLED = { currency: 'EUR', amount: 1200, customer: 'K-1001' };
const OTHER_INVOICE = { customer: 'K-1001', amount: 1250, currency: 'EUR' };
const CREATED = 'Rechnung INV/2026/0042 über 1.200 EUR angelegt.';
const ANSWER = 'Die Rechnung INV/2026/0042 über 1.200 EUR ist angelegt.';

function invoiceRegistry(): { registry: NativeToolRegistry; invoice: ReturnType<typeof registerWriteTool> } {
  const registry = new NativeToolRegistry();
  const invoice = registerWriteTool(registry, 'create_invoice', () => Promise.resolve(CREATED));
  return { registry, invoice };
}

/** One run of the scripted model: call the write tool, then answer. */
const run = (input: unknown = INVOICE) => [toolCalls(['create_invoice', input]), text(ANSWER)];

describe('VerifierService.chat — a re-entry replays the first run, it never re-runs a write', () => {
  it('MUTATION CHECK: a borderline resample runs a declared write handler exactly once', async () => {
    const { registry, invoice } = invoiceRegistry();
    const t = verifiedTurn({
      registry,
      responses: [...run(), ...run()],
      verdicts: [borderline(), approved()],
    });

    await t.service.chat(REQUEST);

    assert.equal(t.model.requests.length, 4, 'the resample ran: two model passes per run');
    assert.deepEqual(invoice.inputs, [INVOICE], 'the write ran once for one user request');
    // Replayed, not skipped: the resample's model still got the result.
    assert.ok(
      toolResultContents(t.model.requests[3]).includes(CREATED),
      'the second sample sees the first run’s tool result',
    );
  });

  it('a resample that turns up a contradiction, and its correction retry, replay the first run twice', async () => {
    const { registry, invoice } = invoiceRegistry();
    const t = verifiedTurn({
      registry,
      responses: [...run(), ...run(), ...run()],
      verdicts: [borderline(), blocked(), approved()],
    });

    const sa = await t.service.chat(REQUEST);

    assert.equal(t.model.requests.length, 6, 'three runs: first, resample, correction');
    assert.deepEqual(invoice.inputs, [INVOICE], 'one execution across three runs');
    assert.ok(toolResultContents(t.model.requests[3]).includes(CREATED), 'resample replays run 1');
    assert.ok(toolResultContents(t.model.requests[5]).includes(CREATED), 'retry replays run 1');
    assert.deepEqual(sa.verifier, { status: 'corrected' });
    assert.deepEqual(t.persisted, [{ status: 'approved', retryCount: 1 }]);
  });

  it('a correction retry replays the write, key order of the input aside, and is badged corrected', async () => {
    const { registry, invoice } = invoiceRegistry();
    const t = verifiedTurn({
      registry,
      responses: [...run(INVOICE), ...run(INVOICE_SHUFFLED)],
      verdicts: [blocked(), approved()],
    });

    const sa = await t.service.chat(REQUEST);

    assert.deepEqual(invoice.inputs, [INVOICE]);
    assert.ok(toolResultContents(t.model.requests[3]).includes(CREATED));
    assert.deepEqual(sa.verifier, { status: 'corrected' });
  });

  it('a resample that needs a write the first run did not make is abandoned before the write runs', async () => {
    const { registry, invoice } = invoiceRegistry();
    const t = verifiedTurn({
      registry,
      // The second sample asks for a different invoice. A spare answer keeps a
      // run that executes it from failing for an unrelated reason.
      responses: [...run(), ...run(OTHER_INVOICE)],
      verdicts: [borderline(), approved()],
    });

    const sa = await t.service.chat(REQUEST);

    assert.deepEqual(invoice.inputs, [INVOICE], 'the second invoice was never created');
    assert.ok(
      t.logs.some((l) => /resample abandoned/.test(l) && l.includes('create_invoice')),
      `a log line names the tool: ${t.logs.join(' | ')}`,
    );
    // The first verdict stands (no second verdict was taken) and is withheld.
    assert.equal(t.verifyInputs.length, 1);
    assert.deepEqual(t.persisted, [{ status: 'approved_with_disclaimer', retryCount: 0 }]);
    assert.equal(sa.answerSource, 'verifier-blocked');
  });

  it('an abandoned correction retry withholds the first answer with the failed badge', async () => {
    const { registry, invoice } = invoiceRegistry();
    const t = verifiedTurn({
      registry,
      responses: [...run(), ...run(OTHER_INVOICE)],
      verdicts: [blocked(), approved()],
    });

    const sa = await t.service.chat(REQUEST);

    assert.deepEqual(invoice.inputs, [INVOICE]);
    assert.ok(t.logs.some((l) => /retry abandoned/.test(l) && l.includes('create_invoice')));
    assert.equal(sa.answerSource, 'verifier-blocked');
    assert.equal(sa.text.includes('1.200'), false, 'the contradicted answer stays withheld');
    assert.deepEqual(sa.verifier, { status: 'failed' });
    assert.deepEqual(t.persisted, [{ status: 'blocked', retryCount: 0 }]);
  });

  it('a re-entry may run a read-only call the first run did not make', async () => {
    const { registry, invoice } = invoiceRegistry();
    const memoryReads: unknown[] = [];
    const VIEW = { command: 'view', path: '/memories/kunden.md' };
    const t = verifiedTurn({
      registry,
      responses: [
        ...run(),
        toolCalls(['create_invoice', INVOICE], ['memory', VIEW]),
        text(ANSWER),
      ],
      verdicts: [blocked(), approved()],
      orchestrator: {
        memoryToolHandler: {
          handle: (input: unknown) => {
            memoryReads.push(input);
            return Promise.resolve('K-1001: Zahlungsziel 14 Tage');
          },
        },
      } as unknown as Partial<OrchestratorOptions>,
    });

    const sa = await t.service.chat(REQUEST);

    assert.deepEqual(invoice.inputs, [INVOICE], 'the write replayed');
    assert.deepEqual(memoryReads, [VIEW], 'the new read ran in the retry');
    assert.deepEqual(sa.verifier, { status: 'corrected' }, 'the retry completed');
  });

  it('a replayed memory read still counts for the Fresh-Check signal', async () => {
    const memoryReads: unknown[] = [];
    const VIEW = { command: 'view', path: '/memories/kunden.md' };
    const once = () => [toolCalls(['memory', VIEW]), text(ANSWER)];
    const t = verifiedTurn({
      responses: [...once(), ...once()],
      verdicts: [blocked(), approved()],
      orchestrator: {
        memoryToolHandler: {
          handle: (input: unknown) => {
            memoryReads.push(input);
            return Promise.resolve("Here's the content of /memories/kunden.md: Zahlungsziel 14 Tage");
          },
        },
      } as unknown as Partial<OrchestratorOptions>,
    });

    const sa = await t.service.chat(REQUEST);

    assert.deepEqual(memoryReads, [VIEW], 'the memory was read once');
    assert.deepEqual(sa.verifier, { status: 'corrected' }, 'the retry was delivered');
    assert.equal(sa.memoryUsed, true, 'the delivered answer still says memory fed it');
  });

  it('a thrown handler replays as a rejection: the retry sees the withheld notice, never the message', async () => {
    const registry = new NativeToolRegistry();
    const invoice = registerWriteTool(registry, 'create_invoice', () =>
      Promise.reject(new Error(`Fault: duplicate key on record {"email":"${EMAIL}"}`)),
    );
    const lookup = registerWriteTool(registry, 'lookup_partner', () =>
      Promise.resolve(`Error: no partner with the address ${EMAIL}`),
    );
    const privacy = maskingPrivacy();
    const both = () => [
      toolCalls(['create_invoice', INVOICE], ['lookup_partner', { email: EMAIL }]),
      text(ANSWER),
    ];
    const t = verifiedTurn({
      registry,
      responses: [...both(), ...both()],
      verdicts: [blocked(), approved()],
      orchestrator: { privacyGuard: () => privacy.service },
    });

    await t.service.chat(REQUEST);

    assert.equal(invoice.inputs.length, 1, 'the throwing write ran once');
    assert.equal(lookup.inputs.length, 1, 'the failing lookup ran once');
    const retrySaw = toolResultContents(t.model.requests[3]);
    assert.equal(retrySaw.length, 2, 'both calls replayed into the retry');
    assert.ok(retrySaw[0]?.startsWith('Error:'), 'the replayed rejection is a tool error');
    for (const result of t.model.requests.flatMap((r) => toolResultContents(r))) {
      assert.equal(result.includes(EMAIL), false, `no raw error text on the wire: ${result}`);
      assert.equal(result.includes('duplicate key'), false, 'the thrown message stays withheld');
    }
    assert.ok(
      retrySaw.some((r) => r.includes('[masked:email]')),
      'the returned error is replayed in its redacted form',
    );
  });
});

describe('VerifierService.chat — the ledger lives as long as the request', () => {
  it('the same input object sent again is a new request, and its write runs', async () => {
    const { registry, invoice } = invoiceRegistry();
    const t = verifiedTurn({
      registry,
      responses: [...run(), ...run(), ...run()],
      verdicts: [blocked(), approved()],
    });

    await t.service.chat(REQUEST);
    await t.orchestrator.runTurn(REQUEST);

    assert.equal(invoice.inputs.length, 2, 'one write per request');
  });
});

describe('VerifierService.chat — when no re-entry happens', () => {
  it('shadow mode runs the turn once', async () => {
    const { registry, invoice } = invoiceRegistry();
    const t = verifiedTurn({
      registry,
      mode: 'shadow',
      responses: [...run(), ...run()],
      verdicts: [blocked()],
    });

    await t.service.chat(REQUEST);

    assert.equal(t.model.requests.length, 2);
    assert.deepEqual(invoice.inputs, [INVOICE]);
  });

  it('control: with resampling switched off a borderline verdict runs the turn once', async () => {
    const { registry, invoice } = invoiceRegistry();
    const t = verifiedTurn({
      registry,
      resampleOnBorderline: false,
      responses: [...run(), ...run()],
      verdicts: [borderline()],
    });

    const sa = await t.service.chat(REQUEST);

    assert.equal(t.model.requests.length, 2, 'no second sample');
    assert.deepEqual(invoice.inputs, [INVOICE]);
    assert.deepEqual(t.persisted, [{ status: 'approved_with_disclaimer', retryCount: 0 }]);
    assert.equal(sa.answerSource, 'verifier-blocked');
  });
});
