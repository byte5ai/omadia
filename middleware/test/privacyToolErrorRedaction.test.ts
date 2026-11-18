/**
 * Privacy-guard provider — tool-error redaction (`redactToolErrorText`) and
 * tool-error receipt accounting (`recordToolError` + `finalizeTurn`).
 *
 * A returned `Error:` string is control flow, so the dispatch seams never
 * intern it; they run the text behind the prefix through this redactor
 * instead. The contract under test: every identity span is replaced
 * irreversibly by `[masked:<type>]`, PII-free hints (dates, amounts, dataset
 * and object ids, the withheld notice) survive byte-identical, and a turn
 * whose only shield activity was a tool error still produces a receipt.
 *
 * All values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

/** A small personnel dataset for the "field omitted otherwise" control. */
const LEAVE_ROWS = [
  { employee: 'Erika Mustermann', employee_id: '1001', days: 24 },
  { employee: 'Max Mustermann', employee_id: '1002', days: 30 },
];

const TE_EMAIL = 'erika.mustermann@example.com';
const TE_IBAN = 'DE89370400440532013000';
const TE_PHONE = '+49 30 1234567';
const TE_ADDRESS = 'Bahnhofstraße 5, 60311 Frankfurt';
const TE_VAT = 'DE123456789';

describe('PrivacyGuardService.redactToolErrorText', () => {
  it('masks every C0 identity type irreversibly and reports only span types', async () => {
    const svc = createPrivacyGuardService();
    const text =
      ` delivery failed for ${TE_EMAIL}; iban ${TE_IBAN}; phone ${TE_PHONE}; ` +
      `ship to ${TE_ADDRESS}; vat ${TE_VAT}`;
    const r = await svc.redactToolErrorText!({ turnId: 't-te-1', toolName: 'crm', text });
    assert.equal(r.outcome, 'redacted');
    if (r.outcome !== 'redacted') return;
    for (const raw of [TE_EMAIL, TE_IBAN, TE_PHONE, TE_ADDRESS, TE_VAT]) {
      assert.equal(r.text.includes(raw), false, `${raw} survived redaction: ${r.text}`);
    }
    for (const type of ['email', 'iban', 'phone', 'address', 'idnum']) {
      assert.ok(r.text.includes(`[masked:${type}]`), `no [masked:${type}] in ${r.text}`);
      assert.ok(
        r.spans.some((s) => s.type === type),
        `span type ${type} missing from ${JSON.stringify(r.spans)}`,
      );
    }
    assert.ok(r.text.startsWith(' delivery failed for '), 'the hint around the values stays');
    assert.equal(JSON.stringify(r.spans).includes('@'), false, 'span records carry no value');
  });

  it('applies the operator deny-list even while prompt masking is off', async () => {
    const svc = createPrivacyGuardService({
      readConfig: (key) =>
        key === 'custom_terms' ? 'Projekt Nordwind' : key === 'mask_user_prompt' ? 'off' : undefined,
    });
    const r = await svc.redactToolErrorText!({
      turnId: 't-te-2',
      toolName: 'crm',
      text: ' access denied for Projekt Nordwind',
    });
    assert.equal(r.outcome, 'redacted');
    if (r.outcome !== 'redacted') return;
    assert.equal(r.text, ' access denied for [masked:custom]');
    assert.deepEqual(
      r.spans.map((s) => s.type),
      ['custom'],
    );
  });

  it('leaves PII-free hints byte-identical — dates and amounts are not identity', async () => {
    const svc = createPrivacyGuardService();
    const hints = [
      ' session_summary requires `scope`.',
      ' embeddings not configured — use `search_turns` for keyword-based search instead.',
      ' get_schema requires `dataset_id`.',
      ' privacy_shield_dataset_id — that id names a turn-scoped Privacy-Shield dataset ' +
        '(the `datasetId` from a digest), which lives in a different id space than the ' +
        'uploaded datasets `query_dataset` reads. Work on it with the `v4_*` verbs (or ' +
        'pass it to a file-export tool such as `create_xlsx`). `query_dataset` accepts ' +
        'only the uuid ids returned by `list_datasets` — call that first.',
      ' link_key_filter — column "__k_name" is a link key; link keys can be join/distinct ' +
        'keys in v4 verbs but never filter targets.',
      " unknown_filter_column — filter references unknown column 'Umsatz'. Call " +
        '`get_schema` to see the real column names/types.',
      ' no free slot on 2026-10-01 between 09:00 and 17:00; the budget of € 1.200,00 is exhausted.',
      ' tool `odoo_search_partner` failed with DatabaseError (code 22P02) [ref err_0a1b2c3d4e5f]. ' +
        'The error text was withheld from the model.',
      ' record 5b1e0c2a-0123-4567-89ab-0123456789ab is locked by another transaction',
    ];
    for (const text of hints) {
      const r = await svc.redactToolErrorText!({ turnId: 't-te-3', toolName: 'kernel', text });
      assert.equal(r.outcome, 'redacted', text);
      if (r.outcome !== 'redacted') continue;
      assert.equal(r.text, text, 'a PII-free hint must survive byte-identical');
      assert.deepEqual(r.spans, []);
    }
  });

  it('never throws on empty or odd input', async () => {
    const svc = createPrivacyGuardService();
    for (const text of ['', ' ', '\u0000', `${'x'.repeat(20_000)} ${TE_EMAIL}`, '\uD800 lone']) {
      const r = await svc.redactToolErrorText!({ turnId: 't-te-4', toolName: 't', text });
      assert.equal(r.outcome, 'redacted');
      if (r.outcome === 'redacted') assert.equal(r.text.includes(TE_EMAIL), false);
    }
  });

  it('runs the C1 detector for names, and degrades to the baseline when it fails', async () => {
    const withC1 = createPrivacyGuardService({
      c1Detector: {
        id: 'c1-test',
        async detect(text: string) {
          const at = text.indexOf('Jane Doe');
          return at < 0 ? [] : [{ start: at, end: at + 8, type: 'person', confidence: 0.9 }];
        },
      },
    });
    const named = await withC1.redactToolErrorText!({
      turnId: 't-te-5',
      toolName: 'crm',
      text: ' no partner Jane Doe with mail jane.doe@example.org',
    });
    assert.equal(named.outcome, 'redacted');
    if (named.outcome === 'redacted') {
      assert.equal(named.text, ' no partner [masked:person] with mail [masked:email]');
      assert.equal(named.degraded, false);
    }

    const failing = createPrivacyGuardService({
      c1Detector: {
        id: 'c1-down',
        async detect() {
          throw new Error('sidecar unreachable');
        },
      },
    });
    const degraded = await failing.redactToolErrorText!({
      turnId: 't-te-6',
      toolName: 'crm',
      text: ` no partner Jane Doe with mail ${TE_EMAIL}`,
    });
    assert.equal(degraded.outcome, 'redacted');
    if (degraded.outcome === 'redacted') {
      assert.equal(degraded.degraded, true, 'a failed C1 is reported, not hidden');
      assert.equal(degraded.text.includes(TE_EMAIL), false, 'the baseline still ran');
    }
  });

  it('sweeps values the turn already masked in the prompt, and never re-hydrates error text', async () => {
    const svc = createPrivacyGuardService({
      readConfig: (key) => (key === 'mask_user_prompt' ? 'on' : undefined),
      c1Detector: {
        id: 'c1-test',
        async detect(text: string) {
          // Finds the name in the PROMPT only, so the sweep is what must catch
          // it in the error text below.
          const at = text.indexOf('Jane Doe');
          return text.startsWith('Finde') && at >= 0
            ? [{ start: at, end: at + 8, type: 'person', confidence: 0.9 }]
            : [];
        },
      },
    });
    const masked = await svc.maskUserPrompt!({
      sessionId: 's',
      turnId: 't-te-7',
      text: 'Finde Jane Doe im CRM',
    });
    assert.equal(masked.outcome, 'masked');

    const r = await svc.redactToolErrorText!({
      turnId: 't-te-7',
      toolName: 'crm',
      text: ` lookup for Jane Doe failed, contact ${TE_EMAIL}`,
    });
    assert.equal(r.outcome, 'redacted');
    if (r.outcome !== 'redacted') return;
    assert.equal(r.text.includes('Jane Doe'), false, 'the known prompt value was swept');
    assert.equal(r.text.includes(TE_EMAIL), false);

    // The error's own values never join the answer-side restore map.
    const restored = await svc.restorePromptPseudonyms!('t-te-7', r.text);
    assert.equal(restored.includes(TE_EMAIL), false, 'an error value was re-hydrated');
  });
});

describe('PrivacyGuardService.recordToolError + finalizeTurn', () => {
  it('emits a receipt for a turn whose only shield activity was a tool error', async () => {
    const svc = createPrivacyGuardService();
    await svc.recordToolError!({
      turnId: 't-te-rec',
      toolName: 'odoo_search_partner',
      carrier: 'thrown',
      outcome: 'withheld',
      bytes: 120,
    });
    await svc.recordToolError!({
      turnId: 't-te-rec',
      toolName: 'crm_lookup',
      carrier: 'returned',
      outcome: 'redacted',
      bytes: 64,
      redactedSpans: [{ type: 'email', detector: 'c0-regex' }],
    });
    const receipt = await svc.finalizeTurn('t-te-rec');
    assert.ok(receipt, 'a tool error alone is shield activity worth a receipt');
    assert.equal(receipt.datasetsInterned, 0);
    assert.deepEqual(receipt.toolErrors, [
      { toolName: 'odoo_search_partner', carrier: 'thrown', outcome: 'withheld', bytes: 120 },
      {
        toolName: 'crm_lookup',
        carrier: 'returned',
        outcome: 'redacted',
        bytes: 64,
        redactedSpans: [{ type: 'email', detector: 'c0-regex' }],
      },
    ]);
    assert.equal(await svc.finalizeTurn('t-te-rec'), undefined, 'drained on finalize');
  });

  it('still returns undefined for a turn with no activity, and omits the field otherwise', async () => {
    const svc = createPrivacyGuardService();
    assert.equal(await svc.finalizeTurn('t-te-none'), undefined);
    await svc.internToolResultV4({
      sessionId: 's',
      turnId: 't-te-data',
      toolName: 'hr.leave',
      rawResult: JSON.stringify(LEAVE_ROWS),
    });
    const receipt = await svc.finalizeTurn('t-te-data');
    assert.ok(receipt);
    assert.equal('toolErrors' in receipt, false, 'no empty toolErrors array on the wire');
  });
});
