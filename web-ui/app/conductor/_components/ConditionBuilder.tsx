'use client';

/**
 * ConditionBuilder — edit a Conductor predicate (postcondition / transition guard)
 * as field/operator/value ROWS instead of hand-written JSON AST. Rows combine via
 * AND/OR. Anything the rows can't represent (nested and/or/not, const) falls back
 * to an "advanced" raw-JSON editor, so no expressiveness is lost. The control
 * round-trips the SAME JSON string the canvas stores (empty = no condition).
 */
import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';

import { gcInput, gcLbl } from './GuidedControls';
import { Button } from '@/app/_components/ui/Button';

type LeafOp = 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'exists' | 'in' | 'matches';
const LEAF_OPS: LeafOp[] = ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'exists', 'in', 'matches'];

// Stable per-row id so React keys survive a mid-list delete (avoids focus/IME glitches — review L2).
let rowSeq = 0;
const nextRowId = (): string => `row-${String((rowSeq += 1))}`;

interface Row {
  id: string;
  path: string;
  op: LeafOp;
  value: string; // user-facing; coerced to JSON on build
}

interface BuilderState {
  mode: 'rows' | 'advanced';
  combiner: 'and' | 'or';
  rows: Row[];
  raw: string;
}

/** Try JSON, fall back to the raw string literal (so `true`/`42`/`"x"` and bare text both work). */
function coerce(v: string): unknown {
  const s = v.trim();
  if (s === '') return '';
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return v;
  }
}

function rowToPredicate(r: Row): Record<string, unknown> {
  if (r.op === 'exists') return { op: 'exists', path: r.path };
  if (r.op === 'in') {
    const value = r.value
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map(coerce);
    return { op: 'in', path: r.path, value };
  }
  if (r.op === 'matches') return { op: 'matches', path: r.path, value: r.value };
  return { op: r.op, path: r.path, value: coerce(r.value) };
}

function predicateToRow(p: Record<string, unknown>): Row | null {
  const op = p['op'];
  if (typeof op !== 'string' || !LEAF_OPS.includes(op as LeafOp)) return null;
  const path = typeof p['path'] === 'string' ? p['path'] : '';
  if (op === 'exists') return { id: nextRowId(), path, op: 'exists', value: '' };
  if (op === 'in') {
    const arr = Array.isArray(p['value']) ? p['value'] : [];
    // A comma-joined text row can only safely represent comma-free scalars. Anything else (an element
    // containing a comma, or a nested object/array) would corrupt on the next split → keep it in the
    // advanced JSON editor instead (review M1).
    const representable = arr.every((x) =>
      typeof x === 'string' ? !x.includes(',') : typeof x === 'number' || typeof x === 'boolean',
    );
    if (!representable) return null;
    return { id: nextRowId(), path, op: 'in', value: arr.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ') };
  }
  if (op === 'matches') return { id: nextRowId(), path, op: 'matches', value: typeof p['value'] === 'string' ? p['value'] : '' };
  const raw = p['value'];
  return { id: nextRowId(), path, op: op as LeafOp, value: typeof raw === 'string' ? JSON.stringify(raw) : JSON.stringify(raw ?? null) };
}

function parseValue(json: string): BuilderState {
  const base: BuilderState = { mode: 'rows', combiner: 'and', rows: [], raw: '' };
  const s = (json ?? '').trim();
  if (!s) return base;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return { ...base, mode: 'advanced', raw: json };
  }
  if (!parsed || typeof parsed !== 'object') return { ...base, mode: 'advanced', raw: s };
  const obj = parsed as Record<string, unknown>;
  if ((obj['op'] === 'and' || obj['op'] === 'or') && Array.isArray(obj['args'])) {
    const rows = obj['args'].map((a) => (a && typeof a === 'object' ? predicateToRow(a as Record<string, unknown>) : null));
    if (rows.every((r): r is Row => r !== null)) {
      return { ...base, combiner: obj['op'] as 'and' | 'or', rows };
    }
    return { ...base, mode: 'advanced', raw: JSON.stringify(parsed, null, 2) };
  }
  const single = predicateToRow(obj);
  if (single) return { ...base, rows: [single] };
  return { ...base, mode: 'advanced', raw: JSON.stringify(parsed, null, 2) };
}

function build(state: BuilderState): string {
  if (state.mode === 'advanced') return state.raw.trim();
  const usable = state.rows.filter((r) => r.path.trim().length > 0);
  const [first] = usable;
  if (!first) return '';
  if (usable.length === 1) return JSON.stringify(rowToPredicate(first));
  return JSON.stringify({ op: state.combiner, args: usable.map(rowToPredicate) });
}

export function ConditionBuilder(props: {
  label: string;
  value: string;
  onChange: (json: string) => void;
  /** dot-path suggestions, e.g. stepResult.approved */
  pathOptions?: readonly string[];
}): React.JSX.Element {
  const t = useTranslations('conductor');
  const pathListId = useId();
  const [state, setState] = useState<BuilderState>(() => parseValue(props.value));

  useEffect(() => {
    // Controlled-component resync: adopt an externally-changed predicate (e.g. a node loads).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (build(state) !== (props.value ?? '').trim()) setState(parseValue(props.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);

  const commit = (next: BuilderState): void => {
    setState(next);
    props.onChange(build(next));
  };

  const setRow = (i: number, patch: Partial<Row>): void =>
    commit({ ...state, rows: state.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const addRow = (): void => commit({ ...state, rows: [...state.rows, { id: nextRowId(), path: '', op: 'eq', value: '' }] });
  const removeRow = (i: number): void => commit({ ...state, rows: state.rows.filter((_, j) => j !== i) });

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-[color:var(--fg-muted)]">{props.label}</span>
        <button
          type="button"
          className="text-[11px] text-[color:var(--accent)] hover:underline"
          onClick={() =>
            commit(state.mode === 'rows' ? { ...state, mode: 'advanced', raw: build({ ...state, mode: 'rows' }) } : parseValue(state.raw))
          }
        >
          {state.mode === 'rows' ? t('conditionAdvanced') : t('conditionSimple')}
        </button>
      </div>

      {state.mode === 'advanced' ? (
        <textarea
          className={`${gcInput} min-h-[60px] font-mono`}
          value={state.raw}
          placeholder='{"op":"and","args":[{"op":"eq","path":"stepResult.approved","value":true}]}'
          onChange={(e) => commit({ ...state, raw: e.target.value })}
        />
      ) : (
        <>
          {state.rows.length > 1 && (
            <label className={gcLbl}>
              {t('conditionCombiner')}
              <select className={gcInput} value={state.combiner} onChange={(e) => commit({ ...state, combiner: e.target.value as 'and' | 'or' })}>
                <option value="and">{t('conditionAnd')}</option>
                <option value="or">{t('conditionOr')}</option>
              </select>
            </label>
          )}
          {state.rows.map((row, i) => (
            <div key={row.id} className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1">
              <input
                className={gcInput}
                list={pathListId}
                value={row.path}
                placeholder="stepResult.approved"
                onChange={(e) => setRow(i, { path: e.target.value })}
              />
              <select className={gcInput} value={row.op} onChange={(e) => setRow(i, { op: e.target.value as LeafOp })}>
                {LEAF_OPS.map((o) => (
                  <option key={o} value={o}>
                    {t(`conditionOp_${o}`)}
                  </option>
                ))}
              </select>
              {row.op === 'exists' ? (
                <span className="text-[11px] text-[color:var(--fg-muted)]">—</span>
              ) : (
                <input
                  className={gcInput}
                  value={row.value}
                  placeholder={row.op === 'in' ? 'a, b, c' : row.op === 'matches' ? '^ok$' : 'true'}
                  onChange={(e) => setRow(i, { value: e.target.value })}
                />
              )}
              <button
                type="button"
                className="px-1 text-[13px] text-[color:var(--danger)] hover:opacity-80"
                aria-label={t('conditionRemove')}
                onClick={() => removeRow(i)}
              >
                ✕
              </button>
            </div>
          ))}
          <datalist id={pathListId}>
            {(props.pathOptions ?? ['stepResult.approved', 'stepResult.text', 'ctx']).map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <div>
            <Button variant="ghost" onClick={addRow}>
              {t('conditionAddRow')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
