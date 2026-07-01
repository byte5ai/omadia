'use client';

/**
 * KeyValueEditor — edit an action's input object as key/value ROWS instead of a
 * hand-written JSON blob. Values are coerced (JSON-first, string fallback) so
 * `true`/`42`/`"text"` all work. Anything the rows can't model (a nested object/
 * array value, or a non-object top level) falls back to an "advanced" raw-JSON
 * editor so no shape is lost. Round-trips the SAME JSON string the canvas stores
 * (empty = no input).
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { gcInput } from './GuidedControls';
import { Button } from '@/app/_components/ui/Button';

let kvSeq = 0;
const nextKvId = (): string => `kv-${String((kvSeq += 1))}`;

interface KvRow {
  id: string;
  key: string;
  value: string;
}

interface KvState {
  mode: 'rows' | 'advanced';
  rows: KvRow[];
  raw: string;
}

function coerce(v: string): unknown {
  const s = v.trim();
  if (s === '') return '';
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return v;
  }
}

/** A value is row-representable only if it's a scalar (string/number/boolean/null). */
function isScalar(x: unknown): boolean {
  return x === null || ['string', 'number', 'boolean'].includes(typeof x);
}

function parseValue(json: string): KvState {
  const base: KvState = { mode: 'rows', rows: [], raw: '' };
  const s = (json ?? '').trim();
  if (!s) return base;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return { ...base, mode: 'advanced', raw: json };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...base, mode: 'advanced', raw: JSON.stringify(parsed, null, 2) };
  }
  const obj = parsed as Record<string, unknown>;
  const entries = Object.entries(obj);
  if (!entries.every(([, val]) => isScalar(val))) {
    return { ...base, mode: 'advanced', raw: JSON.stringify(parsed, null, 2) };
  }
  return {
    ...base,
    rows: entries.map(([key, val]) => ({
      id: nextKvId(),
      key,
      value: JSON.stringify(val),
    })),
  };
}

function build(state: KvState): string {
  if (state.mode === 'advanced') return state.raw.trim();
  const usable = state.rows.filter((r) => r.key.trim().length > 0);
  if (usable.length === 0) return '';
  const obj: Record<string, unknown> = {};
  for (const r of usable) obj[r.key.trim()] = coerce(r.value);
  return JSON.stringify(obj);
}

export function KeyValueEditor(props: {
  label: string;
  value: string;
  onChange: (json: string) => void;
}): React.JSX.Element {
  const t = useTranslations('conductor');
  const [state, setState] = useState<KvState>(() => parseValue(props.value));

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (build(state) !== (props.value ?? '').trim()) setState(parseValue(props.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);

  const commit = (next: KvState): void => {
    setState(next);
    props.onChange(build(next));
  };
  const setRow = (i: number, patch: Partial<KvRow>): void =>
    commit({ ...state, rows: state.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const addRow = (): void => commit({ ...state, rows: [...state.rows, { id: nextKvId(), key: '', value: '' }] });
  const removeRow = (i: number): void => commit({ ...state, rows: state.rows.filter((_, j) => j !== i) });

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-[color:var(--fg-muted)]">{props.label}</span>
        <button
          type="button"
          className="text-[11px] text-[color:var(--accent)] hover:underline"
          onClick={() =>
            commit(state.mode === 'rows' ? { ...state, mode: 'advanced', raw: build({ ...state, mode: 'rows' }) || '{}' } : parseValue(state.raw))
          }
        >
          {state.mode === 'rows' ? t('conditionAdvanced') : t('conditionSimple')}
        </button>
      </div>

      {state.mode === 'advanced' ? (
        <textarea
          className={`${gcInput} min-h-[60px] font-mono`}
          value={state.raw}
          placeholder="{}"
          onChange={(e) => commit({ ...state, raw: e.target.value })}
        />
      ) : (
        <>
          {state.rows.map((row, i) => (
            <div key={row.id} className="grid grid-cols-[1fr_1fr_auto] items-center gap-1">
              <input className={gcInput} value={row.key} placeholder={t('kvKey')} onChange={(e) => setRow(i, { key: e.target.value })} />
              <input className={gcInput} value={row.value} placeholder={t('kvValue')} onChange={(e) => setRow(i, { value: e.target.value })} />
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
          <div>
            <Button variant="ghost" onClick={addRow}>
              {t('kvAddRow')}
            </Button>
          </div>
          {state.rows.length > 0 ? (
            <span className="text-[11px] text-[color:var(--fg-muted)]">{t('kvHint')}</span>
          ) : null}
        </>
      )}
    </div>
  );
}
