import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseRoutineOutputTemplate } from '../src/plugins/routines/routineOutputTemplate.js';

describe('parseRoutineOutputTemplate (Phase C.1)', () => {
  it('accepts a minimal narrative-only template', () => {
    const r = parseRoutineOutputTemplate({
      format: 'markdown',
      sections: [
        { kind: 'narrative-slot', id: 'intro', hint: 'one sentence' },
      ],
    });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.value.format, 'markdown');
      assert.equal(r.value.sections.length, 1);
    }
  });

  it('accepts the full HR routine template shape', () => {
    const r = parseRoutineOutputTemplate({
      format: 'markdown',
      sections: [
        { kind: 'narrative-slot', id: 'intro' },
        {
          kind: 'data-table',
          sourceTool: 'query_odoo_hr',
          sourcePath: 'absences',
          groupBy: 'type',
          columns: [
            { label: 'Mitarbeiter', field: 'name' },
            { label: 'Abteilung', field: 'department' },
            { label: 'Abwesend bis', field: 'absent_until', format: 'date' },
          ],
        },
        { kind: 'narrative-slot', id: 'summary' },
        { kind: 'static-markdown', text: 'Cron: 30 5 * * 1-5' },
      ],
    });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.value.sections.length, 4);
      const table = r.value.sections[1];
      assert.equal(table?.kind, 'data-table');
      if (table?.kind === 'data-table') {
        assert.equal(table.columns.length, 3);
        assert.equal(table.columns[2]?.format, 'date');
      }
    }
  });

  it('accepts a data-list section', () => {
    const r = parseRoutineOutputTemplate({
      format: 'markdown',
      sections: [
        {
          kind: 'data-list',
          sourceTool: 'query_calendar',
          itemTemplate: '- {{time}} — {{title}} ({{location}})',
        },
      ],
    });
    assert.ok(r.ok);
  });

  it('rejects an unknown format', () => {
    const r = parseRoutineOutputTemplate({
      format: 'docx',
      sections: [],
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /format/);
    }
  });

  it('rejects a section with unknown kind', () => {
    const r = parseRoutineOutputTemplate({
      format: 'markdown',
      sections: [{ kind: 'mystery', id: 'foo' }],
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /kind/);
    }
  });

  it('rejects data-table without columns', () => {
    const r = parseRoutineOutputTemplate({
      format: 'markdown',
      sections: [
        { kind: 'data-table', sourceTool: 'foo', columns: [] },
      ],
    });
    assert.equal(r.ok, false);
  });

  it('rejects data-table column missing field', () => {
    const r = parseRoutineOutputTemplate({
      format: 'markdown',
      sections: [
        {
          kind: 'data-table',
          sourceTool: 'foo',
          columns: [{ label: 'X' }],
        },
      ],
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /columns\[0\]/);
    }
  });

  it('rejects narrative-slot without id', () => {
    const r = parseRoutineOutputTemplate({
      format: 'markdown',
      sections: [{ kind: 'narrative-slot' }],
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /id/);
    }
  });

  it('rejects non-object input', () => {
    assert.equal(parseRoutineOutputTemplate(null).ok, false);
    assert.equal(parseRoutineOutputTemplate('string').ok, false);
    assert.equal(parseRoutineOutputTemplate(42).ok, false);
  });

  it('handles missing optional fields gracefully', () => {
    const r = parseRoutineOutputTemplate({
      format: 'markdown',
      sections: [
        {
          kind: 'data-table',
          sourceTool: 'foo',
          columns: [{ label: 'X', field: 'x' }],
        },
      ],
    });
    assert.ok(r.ok);
    if (r.ok) {
      const t = r.value.sections[0];
      if (t?.kind === 'data-table') {
        assert.equal(t.sourcePath, undefined);
        assert.equal(t.title, undefined);
        assert.equal(t.groupBy, undefined);
      }
    }
  });
});
