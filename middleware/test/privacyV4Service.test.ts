/**
 * Privacy Shield v4 — service-wiring integration tests.
 *
 * Verifies the `PrivacyGuardService` v4 seam: the Dataset Store is minted
 * per turn, `internToolResultV4` returns an identity-free digest text,
 * `runV4Tool` runs verbs + the render directive, `finalizeTurn` drops the
 * store and emits the user-facing receipt.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

const HR_LEAVE = [
  { employee: 'Marvin Vomberg', employee_id: '4471', days: 24 },
  { employee: 'Anna Rüsche', employee_id: '5582', days: 30 },
  { employee: 'Thomas Görres', employee_id: '6693', days: 18 },
];
const REAL_NAMES = ['Vomberg', 'Rüsche', 'Görres', 'Marvin', 'Anna', 'Thomas'];

describe('PrivacyGuardService.internToolResultV4', () => {
  it('returns an identity-free digest text', async () => {
    const svc = createPrivacyGuardService();
    const r = await svc.internToolResultV4({
      sessionId: 's',
      turnId: 't-on',
      toolName: 'hr.leave',
      rawResult: JSON.stringify(HR_LEAVE),
    });
    assert.ok(r.digestText.includes('[privacy-shield-v4]'));
    assert.ok(/ds_[0-9a-f-]+/.test(r.digestText), 'carries a datasetId');
    for (const name of REAL_NAMES) {
      assert.ok(
        !r.digestText.includes(name),
        `digest text leaked identity value "${name}"`,
      );
    }
  });

  it('drops the turn store on finalizeTurn without throwing', async () => {
    const svc = createPrivacyGuardService();
    await svc.internToolResultV4({
      sessionId: 's',
      turnId: 't-fin',
      toolName: 'hr.leave',
      rawResult: JSON.stringify(HR_LEAVE),
    });
    await svc.finalizeTurn('t-fin');
    // A fresh intern on the same turnId after finalize still works (new store).
    const again = await svc.internToolResultV4({
      sessionId: 's',
      turnId: 't-fin',
      toolName: 'hr.leave',
      rawResult: JSON.stringify(HR_LEAVE),
    });
    assert.ok(again.digestText);
  });
});

/** Extract the datasetId embedded in a v4 digest / verb-result text. */
function datasetIdOf(text: string): string {
  const json = text.slice(text.indexOf('{'));
  const parsed = JSON.parse(json) as { datasetId: string };
  return parsed.datasetId;
}

describe('PrivacyGuardService.v4ToolSpecs', () => {
  it('returns the 10 verb tools + the render tool', () => {
    const svc = createPrivacyGuardService();
    const specs = svc.v4ToolSpecs();
    assert.equal(specs.length, 11);
    for (const s of specs) {
      assert.ok(s.name.startsWith('v4_'));
      assert.equal((s.input_schema as { type: string }).type, 'object');
    }
  });
});

describe('PrivacyGuardService.runV4Tool — end-to-end data path', () => {
  it('returns a canvas-table sentinel envelope for table renders', async () => {
    const svc = createPrivacyGuardService();
    const turnId = 't-table-envelope';
    const interned = await svc.internToolResultV4({
      sessionId: 's',
      turnId,
      toolName: 'hr.leave',
      rawResult: JSON.stringify(HR_LEAVE),
    });

    const rendered = await svc.runV4Tool({
      sessionId: 's',
      turnId,
      toolName: 'v4_render_answer',
      input: {
        datasetId: datasetIdOf(interned.digestText),
        columns: ['employee', 'days'],
        format: 'table',
      },
    });

    const payload = JSON.parse(rendered.resultText) as {
      _pendingCanvasTree: {
        tree: {
          children: Array<{
            type: string;
            columns: Array<{ fieldKey: string; privacy?: string }>;
            rows: Array<{ rowKey: string; cells: Record<string, unknown> }>;
          }>;
        };
      };
    };
    const table = payload._pendingCanvasTree.tree.children[0];
    assert.equal(table?.type, 'table');
    assert.equal(
      table?.columns.find((column) => column.fieldKey === 'employee')?.privacy,
      'guard-protected',
    );
    assert.equal(table?.rows[0]?.cells.employee, 'Marvin Vomberg');
  });

  it('intern → verb → render → takeRenderedAnswer yields a real answer', async () => {
    const svc = createPrivacyGuardService();
    const turnId = 't-e2e';
    const interned = await svc.internToolResultV4({
      sessionId: 's',
      turnId,
      toolName: 'hr.leave',
      rawResult: JSON.stringify(HR_LEAVE),
    });
    const srcId = datasetIdOf(interned.digestText);

    const sorted = await svc.runV4Tool({
      sessionId: 's',
      turnId,
      toolName: 'v4_sort',
      input: { datasetId: srcId, by: 'days', direction: 'desc' },
    });
    const sortedId = datasetIdOf(sorted.resultText);

    const rendered = await svc.runV4Tool({
      sessionId: 's',
      turnId,
      toolName: 'v4_render_answer',
      input: {
        datasetId: sortedId,
        columns: ['employee', 'days'],
        format: 'table',
      },
    });
    assert.ok(rendered.resultText.includes('[privacy-shield-v4]'));

    const answer = await svc.takeRenderedAnswerV4(turnId);
    assert.ok(answer);
    // Real, complete names in correct rank order: 30 > 24 > 18.
    assert.ok(
      answer.text.indexOf('Anna Rüsche') < answer.text.indexOf('Marvin Vomberg'),
    );
    assert.ok(
      answer.text.indexOf('Marvin Vomberg') <
        answer.text.indexOf('Thomas Görres'),
    );
    // The masked employee names — what the LLM never saw — are reported so
    // channels can highlight them.
    assert.deepEqual(
      [...answer.maskedValues].sort(),
      ['Anna Rüsche', 'Marvin Vomberg', 'Thomas Görres'],
    );

    // The turn receipt reports what the data-plane boundary did.
    const receipt = await svc.finalizeTurn(turnId);
    assert.ok(receipt, 'a receipt is emitted for a turn that interned data');
    assert.equal(receipt.datasetsInterned, 1);
    assert.ok(receipt.fieldsMasked >= 1, 'the employee name field is masked');
    assert.ok(receipt.verbsExecuted.includes('sort'));
    assert.equal(receipt.pseudonymProjectionUsed, false);
  });

  /**
   * #1097 — a render of a dataset that is one control-flow cell (a tool error,
   * an MCP auth prompt) is a rendered FAILURE. The stashed answer says so, so the
   * orchestrator can put `answerIsError` on the wire and channels can present
   * it as an error instead of success prose wrapped around an error string.
   *
   * Reaching the store at all takes the `internToolResultV4` path directly:
   * the dispatch seams keep such results out of the shield entirely (the
   * primary fix); a masked thrown exception is one route that still lands
   * here.
   */
  it('flags a rendered tool error as isError', async () => {
    const svc = createPrivacyGuardService();
    const turnId = 't-err';
    const interned = await svc.internToolResultV4({
      sessionId: 's',
      turnId,
      toolName: 'manage_routine',
      rawResult: 'Error: routines are unavailable in this session.',
    });
    const srcId = datasetIdOf(interned.digestText);

    await svc.runV4Tool({
      sessionId: 's',
      turnId,
      toolName: 'v4_render_answer',
      input: { datasetId: srcId, columns: ['value'], format: 'scalar' },
    });

    const answer = await svc.takeRenderedAnswerV4(turnId);
    assert.ok(answer);
    assert.ok(
      answer.text.includes('Error: routines are unavailable'),
      'the render still materializes what the model asked for',
    );
    assert.equal(answer.isError, true, 'a rendered error must be flagged as one');
  });

  it('flags a list render wrapped in success prose as isError (#1097 repro 2)', async () => {
    // The issue's own reproduction: the model rendered the interned error as a
    // one-item list under "ein Treffer gefunden". The flag is decided on the
    // source cell, so neither the prose nor the list framing hides it.
    const svc = createPrivacyGuardService();
    const turnId = 't-err-list';
    const interned = await svc.internToolResultV4({
      sessionId: 's',
      turnId,
      toolName: 'query_knowledge_graph',
      rawResult:
        'Error: embeddings not configured — use `search_turns` for keyword-based search instead.',
    });
    const srcId = datasetIdOf(interned.digestText);

    await svc.runV4Tool({
      sessionId: 's',
      turnId,
      toolName: 'v4_render_answer',
      input: {
        datasetId: srcId,
        columns: [{ field: 'value', label: 'Treffer' }],
        format: 'list',
        prose: 'Semantische Suche nach "Nordwind" — ein Treffer gefunden.',
      },
    });

    const answer = await svc.takeRenderedAnswerV4(turnId);
    assert.ok(answer);
    assert.ok(answer.text.startsWith('Semantische Suche'), 'the prose leads the render');
    assert.equal(answer.isError, true, 'a list render of an error must be flagged as one');
  });

  it('leaves isError unset for an ordinary rendered answer', async () => {
    const svc = createPrivacyGuardService();
    const turnId = 't-ok';
    const interned = await svc.internToolResultV4({
      sessionId: 's',
      turnId,
      toolName: 'hr.leave',
      rawResult: JSON.stringify(HR_LEAVE),
    });
    const srcId = datasetIdOf(interned.digestText);

    await svc.runV4Tool({
      sessionId: 's',
      turnId,
      toolName: 'v4_render_answer',
      input: { datasetId: srcId, columns: ['employee', 'days'], format: 'table' },
    });

    const answer = await svc.takeRenderedAnswerV4(turnId);
    assert.ok(answer);
    assert.equal(answer.isError, undefined, 'an ordinary answer carries no error flag');
  });

  it('takeRenderedAnswerV4 clears the stash after taking', async () => {
    const svc = createPrivacyGuardService();
    const turnId = 't-clear';
    const interned = await svc.internToolResultV4({
      sessionId: 's',
      turnId,
      toolName: 'hr.leave',
      rawResult: JSON.stringify(HR_LEAVE),
    });
    await svc.runV4Tool({
      sessionId: 's',
      turnId,
      toolName: 'v4_render_answer',
      input: {
        datasetId: datasetIdOf(interned.digestText),
        columns: ['employee'],
        format: 'list',
      },
    });
    const first = await svc.takeRenderedAnswerV4(turnId);
    const second = await svc.takeRenderedAnswerV4(turnId);
    assert.ok(first);
    assert.equal(second, undefined);
  });

  it('finalizeTurn returns undefined for a turn that interned nothing', async () => {
    const svc = createPrivacyGuardService();
    const receipt = await svc.finalizeTurn('t-empty');
    assert.equal(receipt, undefined);
  });
});

describe('PrivacyGuardService — identityValuesOnWire (Slice 2B)', () => {
  it('counts identity values the requester named in their own message', async () => {
    // Fake Haiku schema classifier: marks the `employee` field as PII.
    const svc = createPrivacyGuardService({
      llmComplete: async () => ({ text: '["employee"]' }),
    });
    const turnId = 't-iow';
    await svc.internToolResultV4({
      sessionId: 's',
      turnId,
      toolName: 'hr.leave',
      rawResult: JSON.stringify(HR_LEAVE),
    });
    // The user named Marvin Vomberg themselves → 1 identity value on the
    // wire (the other two employees were not named, so they don't count).
    const receipt = await svc.finalizeTurn(
      turnId,
      'Wie viel Urlaub hat Marvin Vomberg?',
    );
    assert.ok(receipt);
    assert.equal(receipt.identityValuesOnWire, 1);
  });

  it('reports 0 identity values when the requester named no one', async () => {
    const svc = createPrivacyGuardService({
      llmComplete: async () => ({ text: '["employee"]' }),
    });
    const turnId = 't-iow-none';
    await svc.internToolResultV4({
      sessionId: 's',
      turnId,
      toolName: 'hr.leave',
      rawResult: JSON.stringify(HR_LEAVE),
    });
    const receipt = await svc.finalizeTurn(turnId, 'Wer hat den meisten Urlaub?');
    assert.ok(receipt);
    assert.equal(receipt.identityValuesOnWire, 0);
  });
});

/**
 * #1097 — a control-flow-looking cell is never a cleartext channel. The shape
 * classifier masks every free-text string (only S1–S5 yield cleartext), and a
 * verb re-classifies its derived dataset with that same classifier. An
 * exemption for "a 1×1 `Error:` scalar" was tried and removed: filter + select
 * narrow any helpdesk dataset to exactly such a scalar, and the name behind the
 * prefix then went to the model in the digest.
 */
describe('PrivacyGuardService — control-flow text is never a cleartext channel (#1097)', () => {
  it('keeps a verb-derived 1x1 `Error:` cell masked', async () => {
    const svc = createPrivacyGuardService();
    const turnId = 't-launder';
    const interned = await svc.internToolResultV4({
      sessionId: 's',
      turnId,
      toolName: 'helpdesk.tickets',
      rawResult: JSON.stringify([
        { id: 'T-1001', description: 'Error: Login fuer Max Mustermann' },
        { id: 'T-1002', description: 'x' },
      ]),
    });

    const filtered = await svc.runV4Tool({
      sessionId: 's',
      turnId,
      toolName: 'v4_filter',
      input: {
        datasetId: datasetIdOf(interned.digestText),
        predicate: { op: 'eq', field: 'id', value: 'T-1001' },
      },
    });
    const selected = await svc.runV4Tool({
      sessionId: 's',
      turnId,
      toolName: 'v4_select',
      input: { datasetId: datasetIdOf(filtered.resultText), columns: ['description'] },
    });

    const digest = JSON.parse(
      selected.resultText.slice(selected.resultText.indexOf('{')),
    ) as { rowCount: number; fields: Array<{ path: string; classification: string }> };
    assert.equal(digest.rowCount, 1, 'the verbs narrowed the dataset to one cell');
    assert.equal(
      digest.fields.find((f) => f.path === 'description')?.classification,
      'sensitive-masked',
      'narrowing a masked column to a 1x1 `Error:` scalar must not unmask it',
    );
    assert.equal(
      selected.resultText.includes('Max Mustermann'),
      false,
      'the name behind the `Error:` prefix leaked into the digest',
    );
  });
});

// ---------------------------------------------------------------------------
// Tool-error redaction — the `Error:` text a dispatch seam hands the model.
// All values are synthetic.
// ---------------------------------------------------------------------------

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
      rawResult: JSON.stringify(HR_LEAVE),
    });
    const receipt = await svc.finalizeTurn('t-te-data');
    assert.ok(receipt);
    assert.equal('toolErrors' in receipt, false, 'no empty toolErrors array on the wire');
  });
});
