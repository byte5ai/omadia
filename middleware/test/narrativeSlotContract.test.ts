import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildSlotDirective,
  collectRequiredSlotIds,
  parseSlotResponse,
} from '../src/plugins/routines/narrativeSlotContract.js';
import type { RoutineOutputTemplate } from '../src/plugins/routines/routineOutputTemplate.js';

const HR_TEMPLATE: RoutineOutputTemplate = {
  format: 'markdown',
  sections: [
    { kind: 'narrative-slot', id: 'intro', hint: 'Ein Satz Einleitung mit Datum.' },
    {
      kind: 'data-table',
      sourceTool: 'query_odoo_hr',
      sourcePath: 'absences',
      titleSlot: 'section_title_paid_time_off',
      columns: [{ label: 'Mitarbeiter', field: 'name' }],
    },
    { kind: 'narrative-slot', id: 'summary', hint: '2-3 Bulletpoints.' },
    { kind: 'static-markdown', text: '_Quelle: Odoo HR_' },
  ],
};

const DATA_ONLY_TEMPLATE: RoutineOutputTemplate = {
  format: 'markdown',
  sections: [
    {
      kind: 'data-table',
      sourceTool: 'query_odoo_hr',
      columns: [{ label: 'X', field: 'x' }],
    },
    { kind: 'static-markdown', text: 'footer' },
  ],
};

describe('narrativeSlotContract — collectRequiredSlotIds', () => {
  it('returns narrative-slot ids and data-section titleSlots in render order', () => {
    assert.deepEqual(collectRequiredSlotIds(HR_TEMPLATE), [
      'intro',
      'section_title_paid_time_off',
      'summary',
    ]);
  });

  it('returns empty array when template has no narrative slots and no titleSlots', () => {
    assert.deepEqual(collectRequiredSlotIds(DATA_ONLY_TEMPLATE), []);
  });

  it('deduplicates repeated slot ids (first occurrence wins)', () => {
    const tpl: RoutineOutputTemplate = {
      format: 'markdown',
      sections: [
        { kind: 'narrative-slot', id: 'shared' },
        {
          kind: 'data-table',
          sourceTool: 't',
          titleSlot: 'shared',
          columns: [{ label: 'X', field: 'x' }],
        },
        { kind: 'narrative-slot', id: 'extra' },
      ],
    };
    assert.deepEqual(collectRequiredSlotIds(tpl), ['shared', 'extra']);
  });

  it('ignores empty / whitespace-only ids defensively', () => {
    const tpl: RoutineOutputTemplate = {
      format: 'markdown',
      sections: [
        { kind: 'narrative-slot', id: '' },
        { kind: 'narrative-slot', id: 'real' },
      ],
    };
    assert.deepEqual(collectRequiredSlotIds(tpl), ['real']);
  });
});

describe('narrativeSlotContract — buildSlotDirective', () => {
  it('returns empty string for a template with no required slots', () => {
    assert.equal(buildSlotDirective(DATA_ONLY_TEMPLATE), '');
  });

  it('includes every required slot id in a JSON skeleton', () => {
    const directive = buildSlotDirective(HR_TEMPLATE);
    assert.match(directive, /"intro": "\.\.\."/);
    assert.match(directive, /"section_title_paid_time_off": "\.\.\."/);
    assert.match(directive, /"summary": "\.\.\."/);
  });

  it('emits each slot id alongside its hint', () => {
    const directive = buildSlotDirective(HR_TEMPLATE);
    assert.match(directive, /- intro: Ein Satz Einleitung mit Datum\./);
    assert.match(directive, /- summary: 2-3 Bulletpoints\./);
    // titleSlot has no hint source → fallback "(frei formulieren)"
    assert.match(directive, /- section_title_paid_time_off: \(frei formulieren\)/);
  });

  it('forbids data sections in the slot text', () => {
    const directive = buildSlotDirective(HR_TEMPLATE);
    assert.match(directive, /keine Tabellen, keine Aufzählungen/);
  });

  it('lists slots in template render order, not alphabetical', () => {
    const directive = buildSlotDirective(HR_TEMPLATE);
    const introIdx = directive.indexOf('"intro"');
    const titleIdx = directive.indexOf('"section_title_paid_time_off"');
    const summaryIdx = directive.indexOf('"summary"');
    assert.ok(introIdx >= 0 && titleIdx > introIdx && summaryIdx > titleIdx);
  });

  it('produces valid JSON when filled with non-quote string values', () => {
    // The skeleton itself is not valid JSON (it has "..." placeholders
    // which are valid string content) — confirm parse-ability by
    // extracting the json block and parsing it.
    const directive = buildSlotDirective(HR_TEMPLATE);
    const m = /```json\n([\s\S]*?)\n```/.exec(directive);
    assert.ok(m, 'expected a ```json block in the directive');
    const parsed = JSON.parse(m![1]!);
    assert.ok(parsed && typeof parsed === 'object');
    assert.deepEqual(Object.keys(parsed.slots), [
      'intro',
      'section_title_paid_time_off',
      'summary',
    ]);
  });
});

describe('narrativeSlotContract — parseSlotResponse', () => {
  it('accepts plain JSON with all required slots', () => {
    const text = JSON.stringify({
      slots: {
        intro: 'Heute, 15. Mai 2026, sind 3 Mitarbeiter abwesend.',
        section_title_paid_time_off: 'Bezahlter Urlaub',
        summary: '- Alle aus ExtSvc\n- 2 kehren am 15.05. zurück',
      },
    });
    const r = parseSlotResponse(text, HR_TEMPLATE);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.slots['intro'], 'Heute, 15. Mai 2026, sind 3 Mitarbeiter abwesend.');
      assert.equal(r.value.slots['section_title_paid_time_off'], 'Bezahlter Urlaub');
      assert.equal(r.value.slots['summary'], '- Alle aus ExtSvc\n- 2 kehren am 15.05. zurück');
    }
  });

  it('strips ```json …``` fences', () => {
    const text = '```json\n{"slots":{"intro":"a","section_title_paid_time_off":"b","summary":"c"}}\n```';
    const r = parseSlotResponse(text, HR_TEMPLATE);
    assert.equal(r.ok, true);
  });

  it('strips bare ``` fences without language tag', () => {
    const text = '```\n{"slots":{"intro":"a","section_title_paid_time_off":"b","summary":"c"}}\n```';
    const r = parseSlotResponse(text, HR_TEMPLATE);
    assert.equal(r.ok, true);
  });

  it('extracts JSON object from surrounding chatter', () => {
    const text =
      'Hier mein Ergebnis:\n{"slots":{"intro":"a","section_title_paid_time_off":"b","summary":"c"}}\nFertig.';
    const r = parseSlotResponse(text, HR_TEMPLATE);
    assert.equal(r.ok, true);
  });

  it('tolerates a quoted "}" inside string values without ending object early', () => {
    const text = '{"slots":{"intro":"contains } brace","section_title_paid_time_off":"b","summary":"c"}}';
    const r = parseSlotResponse(text, HR_TEMPLATE);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.slots['intro'], 'contains } brace');
  });

  it('preserves extra slots the LLM emitted but were not required', () => {
    const text = JSON.stringify({
      slots: {
        intro: 'a',
        section_title_paid_time_off: 'b',
        summary: 'c',
        extra_unused: 'd',
      },
    });
    const r = parseSlotResponse(text, HR_TEMPLATE);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.slots['extra_unused'], 'd');
  });

  it('rejects missing required slot', () => {
    const text = JSON.stringify({
      slots: { intro: 'a', section_title_paid_time_off: 'b' /* summary missing */ },
    });
    const r = parseSlotResponse(text, HR_TEMPLATE);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /missing required slot 'summary'/);
  });

  it('rejects non-string slot value', () => {
    const text = JSON.stringify({
      slots: {
        intro: 42,
        section_title_paid_time_off: 'b',
        summary: 'c',
      },
    });
    const r = parseSlotResponse(text, HR_TEMPLATE);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /slot 'intro' must be a string, got number/);
  });

  it('rejects null slot value', () => {
    const text = JSON.stringify({
      slots: {
        intro: null,
        section_title_paid_time_off: 'b',
        summary: 'c',
      },
    });
    const r = parseSlotResponse(text, HR_TEMPLATE);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /got null/);
  });

  it('rejects array slot value', () => {
    const text = JSON.stringify({
      slots: {
        intro: ['a'],
        section_title_paid_time_off: 'b',
        summary: 'c',
      },
    });
    const r = parseSlotResponse(text, HR_TEMPLATE);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /got array/);
  });

  it('rejects slots that is not an object', () => {
    const text = JSON.stringify({ slots: 'oops' });
    const r = parseSlotResponse(text, HR_TEMPLATE);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /`slots` must be an object/);
  });

  it('rejects slots that is an array', () => {
    const text = JSON.stringify({ slots: [] });
    const r = parseSlotResponse(text, HR_TEMPLATE);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /`slots` must be an object/);
  });

  it('rejects empty response', () => {
    const r = parseSlotResponse('', HR_TEMPLATE);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /no JSON object/);
  });

  it('rejects response without any JSON', () => {
    const r = parseSlotResponse('Sorry, kann ich nicht.', HR_TEMPLATE);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /no JSON object/);
  });

  it('rejects malformed JSON with a parse-error reason', () => {
    const r = parseSlotResponse('{slots: nope}', HR_TEMPLATE);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /JSON parse failed/);
  });

  it('returns empty slots for a data-only template (no LLM call expected)', () => {
    const r = parseSlotResponse('whatever the LLM said', DATA_ONLY_TEMPLATE);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value.slots, {});
  });

  it('accepts empty string slot value (renderer decides what to do)', () => {
    const text = JSON.stringify({
      slots: { intro: '', section_title_paid_time_off: '', summary: '' },
    });
    const r = parseSlotResponse(text, HR_TEMPLATE);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.slots['intro'], '');
      assert.equal(r.value.slots['summary'], '');
    }
  });
});
