/**
 * omadia-canvas-protocol/1.1 — build a data-bound Lumen from REAL rows.
 *
 * The L5 "loadData" pattern, privacy-safe: with the Privacy Shield active the
 * agent only ever sees MASKED values, so it cannot bake real data into LX. The
 * producer instead resolves a privacy-shield `datasetId` SERVER-SIDE (the real
 * rows never pass through the LLM) and constructs the Lumen here, deterministically.
 *
 * The result is an interactive list-chart: one tappable row per record (label +
 * value), tapping a row highlights it (state-driven selection). All declarative
 * LX — the shipped interpreter runs it Tier-1 with no per-frame round-trip.
 */
type Row = Record<string, unknown>;

const MAX_ROWS = 20;
const ROW_H = 24;
const TOP = 28;

/** Pick a sensible label/value field when the agent didn't name one. */
function firstStringField(rows: Row[]): string | undefined {
  const r = rows[0] ?? {};
  return Object.keys(r).find((k) => typeof r[k] === 'string');
}
function firstNumberField(rows: Row[]): string | undefined {
  const r = rows[0] ?? {};
  return Object.keys(r).find((k) => typeof r[k] === 'number' || (typeof r[k] === 'string' && r[k] !== '' && !Number.isNaN(Number(r[k]))));
}

export interface DatasetLumenOptions {
  labelField?: string;
  valueField?: string;
}

/** Construct a tappable list-chart Lumen from resolved rows. */
export function buildDatasetLumen(rows: Row[], opts: DatasetLumenOptions = {}): Record<string, unknown> {
  const labelField =
    opts.labelField && rows.some((r) => opts.labelField! in r) ? opts.labelField : firstStringField(rows);
  const valueField =
    opts.valueField && rows.some((r) => opts.valueField! in r) ? opts.valueField : firstNumberField(rows);

  const data = rows.slice(0, MAX_ROWS).map((r) => ({
    label: labelField ? String(r[labelField] ?? '—').slice(0, 48) : '—',
    value: valueField !== undefined ? Number(r[valueField]) || 0 : 0,
  }));
  const height = TOP + Math.max(1, data.length) * ROW_H + 12;

  // one tappable text row per record; highlighted when its index == sel.
  const rowExpr = {
    record: {
      kind: { lit: 'text' },
      x: { lit: 14 },
      y: { '+': [{ lit: TOP }, { '*': [{ var: 'idx' }, { lit: ROW_H }] }] },
      text: {
        call: 'concat',
        args: [
          { get: { var: 'it' }, key: { lit: 'label' } },
          { lit: '   ·   ' },
          { call: 'fmt', args: [{ get: { var: 'it' }, key: { lit: 'value' } }] },
        ],
      },
      register: { lit: 'mono' },
      fill: {
        if: { '==': [{ call: 'fmt', args: [{ var: 'idx' }] }, { state: 'sel' }] },
        then: { lit: 'success' },
        else: { lit: 'text' },
      },
      id: { call: 'fmt', args: [{ var: 'idx' }] },
    },
  };

  return {
    type: 'lumen',
    id: 'dataset-lumen',
    state: {
      rows: {
        type: 'list',
        of: { type: 'record', fields: { label: { type: 'string', maxLength: 64, init: '' }, value: { type: 'number', init: 0 } }, init: {} },
        maxLen: 64,
        init: data,
      },
      sel: { type: 'string', maxLength: 8, init: '' },
    },
    transitions: { select: { set: { sel: { event: 'id' } } } },
    view: {
      record: {
        type: { lit: 'scene' },
        width: { lit: 360 },
        height: { lit: height },
        draw: {
          call: 'concat',
          args: [
            { list: [{ record: { kind: { lit: 'rect' }, x: { lit: 0 }, y: { lit: 0 }, w: { lit: 360 }, h: { lit: height }, fill: { lit: 'surface-sunken' } } }] },
            { call: 'map', args: [{ state: 'rows' }, rowExpr] },
          ],
        },
      },
    },
    events: [{ on: 'tap', run: 'select' }],
    cadence: 'reactive',
  };
}
