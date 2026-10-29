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
  it('hands the canvas-table snapshot to the side channel, not the tool_result (#1402)', async () => {
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
        columns: [{ field: 'employee', label: 'Mitarbeiter' }, 'days'],
        format: 'table',
      },
    });

    // The LLM-bound tool_result: shape only — never a real cell value.
    for (const value of [...REAL_NAMES, '4471', '5582', '6693']) {
      assert.ok(
        !rendered.resultText.includes(value),
        `tool_result leaked real value "${value}"`,
      );
    }
    assert.ok(!rendered.resultText.includes('_pending'), 'tool_result carries a canvas sentinel');
    assert.ok(rendered.resultText.includes('3 rows'), rendered.resultText);
    assert.ok(rendered.resultText.includes('"Mitarbeiter"'), rendered.resultText);

    // The canvas side channel still carries the full snapshot.
    assert.ok(rendered.canvasSentinel, 'a table render returns its canvas snapshot');
    const payload = JSON.parse(rendered.canvasSentinel) as {
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

    // The user-facing render is unchanged.
    const answer = await svc.takeRenderedAnswerV4(turnId);
    assert.ok(answer?.text.includes('Marvin Vomberg'));
  });

  it('a non-table render returns the note and no canvas snapshot', async () => {
    const svc = createPrivacyGuardService();
    const turnId = 't-list-note';
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
      input: { datasetId: datasetIdOf(interned.digestText), columns: ['employee'], format: 'list' },
    });
    assert.equal(rendered.canvasSentinel, undefined);
    for (const name of REAL_NAMES) assert.ok(!rendered.resultText.includes(name));
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

  it('takeRenderedAnswerV4 surfaces the model prose apart from the rows — and none for blank prose', async () => {
    const svc = createPrivacyGuardService();
    const render = async (turnId: string, prose: string | undefined) => {
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
          columns: ['employee', 'days'],
          format: 'table',
          ...(prose !== undefined ? { prose } : {}),
        },
      });
      return svc.takeRenderedAnswerV4(turnId);
    };

    const withProse = await render('t-prose', 'Urlaub nach Tagen:');
    assert.equal(withProse?.prose, 'Urlaub nach Tagen:');
    assert.ok(withProse?.text.startsWith('Urlaub nach Tagen:'));
    assert.ok(withProse?.text.includes('Anna Rüsche'));

    // Always reported: '' says "no prose" — absent would read as a provider
    // that predates the field, which the kernel fails closed on.
    assert.equal((await render('t-blank', '   '))?.prose, '');
    assert.equal((await render('t-none', undefined))?.prose, '');
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

describe('PrivacyGuardService.runV4Tool — render ack (#1542, #1543, #1559)', () => {
  const PAGE = {
    id: 98765,
    title: 'Kontaktliste Testteam',
    raw: { a: { b: { c: { d: 'Jonas Weber' } } }, e: { f: { g: 'jonas.weber@example.com' } } },
  };
  const PAGE_VALUES = ['Jonas', 'Weber', 'jonas.weber@example.com', 'Kontaktliste'];

  it('names the unrenderable columns and the provenance — and no value', async () => {
    const svc = createPrivacyGuardService();
    const turnId = 't-ack-1542';
    const interned = await svc.internToolResultV4({
      sessionId: 's',
      turnId,
      toolName: 'confluence_get_page',
      rawResult: JSON.stringify([PAGE]),
    });
    const rendered = await svc.runV4Tool({
      sessionId: 's',
      turnId,
      toolName: 'v4_render_answer',
      input: {
        datasetId: datasetIdOf(interned.digestText),
        columns: [{ field: 'title', label: 'Titel' }, { field: 'raw', label: 'Inhalt (wörtlich)' }],
        format: 'table',
      },
    });
    assert.ok(rendered.resultText.includes('Could not be rendered: ["Inhalt (wörtlich)"]'), rendered.resultText);
    assert.ok(rendered.renderProvenance?.includes('source tool `confluence_get_page`'));
    assert.ok(rendered.resultText.includes(rendered.renderProvenance ?? '\u0000'));
    for (const value of PAGE_VALUES) {
      assert.ok(!rendered.resultText.includes(value), `ack leaked "${value}"`);
      assert.ok(!rendered.renderProvenance?.includes(value), `provenance leaked "${value}"`);
    }
    // The user's answer says the content could not be shown, and how to get it.
    const answer = await svc.takeRenderedAnswerV4(turnId);
    assert.ok(answer?.text.includes('lässt sich in dieser geschützten Ansicht nicht darstellen'));
  });

  it('a list render carries the provenance too; the export flag reaches the footer', async () => {
    const svc = createPrivacyGuardService();
    const rows = Array.from({ length: 60 }, (_, i) => ({ employee: `Quentin Zabrowski ${String(i)}`, days: i }));
    for (const fileExportAvailable of [false, true]) {
      const turnId = `t-list-1559-${String(fileExportAvailable)}`;
      const interned = await svc.internToolResultV4({
        sessionId: 's',
        turnId,
        toolName: 'hr.leave',
        rawResult: JSON.stringify(rows),
      });
      const rendered = await svc.runV4Tool({
        sessionId: 's',
        turnId,
        toolName: 'v4_render_answer',
        input: { datasetId: datasetIdOf(interned.digestText), columns: ['employee'], format: 'list' },
        fileExportAvailable,
      });
      assert.ok(rendered.resultText.includes('Table provenance'), rendered.resultText);
      assert.ok(!rendered.resultText.includes('Zabrowski'));
      const answer = await svc.takeRenderedAnswerV4(turnId);
      assert.equal(answer?.text.includes('Excel-Datei') === true, fileExportAvailable, answer?.text ?? '');
    }
  });
});
