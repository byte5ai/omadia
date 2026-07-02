'use client';

/**
 * Guided form controls for the Conductor designer — replace the raw text inputs
 * (ISO-8601 durations, free-text role/channel ids, hidden quorum) with self-
 * explanatory pickers. All controls round-trip the SAME serialized shapes the
 * canvas already stores (ISO-8601 strings, channel slug, 'any'|'all'), so the
 * publish path is unchanged. i18n lives under the `conductor` namespace.
 */
import { useId } from 'react';
import { useTranslations } from 'next-intl';

export const gcInput =
  'w-full rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1 text-[13px] text-[color:var(--fg-strong)]';
export const gcLbl = 'grid gap-1 text-[12px] text-[color:var(--fg-muted)]';
const gcHint = 'text-[11px] text-[color:var(--fg-muted)]';

// --- ISO-8601 duration <-> { amount, unit } -------------------------------
// The designer only ever emits single-unit durations, so we parse/serialize the
// common forms: PT{n}M (minutes), PT{n}H (hours), P{n}D (days), P{n}W (weeks).
export type DurationUnit = 'minutes' | 'hours' | 'days' | 'weeks';

export function parseDuration(iso: string): { amount: number; unit: DurationUnit } | null {
  const s = (iso ?? '').trim();
  if (!s) return null;
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(s);
  if (!m) return null;
  const [, w, d, h, min] = m;
  let result: { amount: number; unit: DurationUnit } | null = null;
  if (w) result = { amount: Number(w), unit: 'weeks' };
  else if (d) result = { amount: Number(d), unit: 'days' };
  else if (h) result = { amount: Number(h), unit: 'hours' };
  else if (min) result = { amount: Number(min), unit: 'minutes' };
  // Strict: only a SINGLE-unit duration that re-serializes byte-identically is representable as
  // value+unit. Multi-unit forms (PT1H30M, P1DT12H) and units we don't model (PT30S, P1Y) return
  // null so the control can fall back to a raw editor and never silently truncate the stored value.
  if (!result) return null;
  return serializeDuration(result.amount, result.unit) === s ? result : null;
}

export function serializeDuration(amount: number, unit: DurationUnit): string {
  const n = Math.floor(amount);
  if (!Number.isFinite(n) || n <= 0) return '';
  switch (unit) {
    case 'minutes':
      return `PT${String(n)}M`;
    case 'hours':
      return `PT${String(n)}H`;
    case 'days':
      return `P${String(n)}D`;
    case 'weeks':
      return `P${String(n)}W`;
  }
}

/** Value (number) + unit picker that serializes to an ISO-8601 duration. Empty = "no value". */
export function DurationInput(props: {
  label: string;
  value: string;
  onChange: (iso: string) => void;
  hint?: string;
}): React.JSX.Element {
  const t = useTranslations('conductor');
  const parsed = parseDuration(props.value);
  const amount = parsed?.amount ?? '';
  const unit: DurationUnit = parsed?.unit ?? 'hours';
  const units: DurationUnit[] = ['minutes', 'hours', 'days', 'weeks'];
  // A non-empty value the picker can't represent as a single unit (e.g. PT1H30M, P1Y) must stay
  // editable as raw ISO so we never truncate or wipe a value the engine accepts (review H1).
  const isRaw = props.value.trim().length > 0 && !parsed;

  const emit = (nextAmount: number | '', nextUnit: DurationUnit): void => {
    if (nextAmount === '' || Number(nextAmount) <= 0) {
      props.onChange('');
      return;
    }
    props.onChange(serializeDuration(Number(nextAmount), nextUnit));
  };

  if (isRaw) {
    return (
      <label className={gcLbl}>
        {props.label}
        <input
          className={`${gcInput} font-mono`}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <span className={gcHint}>{t('durationRawHint')}</span>
      </label>
    );
  }

  return (
    <label className={gcLbl}>
      {props.label}
      <div className="flex gap-2">
        <input
          type="number"
          min={1}
          step={1}
          className={`${gcInput} w-20`}
          value={amount}
          placeholder="—"
          onChange={(e) => emit(e.target.value === '' ? '' : Number(e.target.value), unit)}
        />
        <select
          className={gcInput}
          value={unit}
          onChange={(e) => emit(amount === '' ? '' : Number(amount), e.target.value as DurationUnit)}
        >
          {units.map((u) => (
            <option key={u} value={u}>
              {t(`durationUnit_${u}`)}
            </option>
          ))}
        </select>
      </div>
      {props.hint ? <span className={gcHint}>{props.hint}</span> : null}
    </label>
  );
}

/** Quorum: 'any' (first response wins) vs 'all' (every holder must respond). */
export function QuorumSelect(props: {
  label: string;
  value: 'any' | 'all';
  onChange: (q: 'any' | 'all') => void;
}): React.JSX.Element {
  const t = useTranslations('conductor');
  const value = props.value || 'any'; // defensive: an older graph could carry undefined → controlled 'any'
  return (
    <label className={gcLbl}>
      {props.label}
      <select className={gcInput} value={value} onChange={(e) => props.onChange(e.target.value as 'any' | 'all')}>
        <option value="any">{t('quorumAny')}</option>
        <option value="all">{t('quorumAll')}</option>
      </select>
      <span className={gcHint}>{value === 'all' ? t('quorumAllHint') : t('quorumAnyHint')}</span>
    </label>
  );
}

/** Channel picker — a select over the known delivery channels (free value preserved if unknown). */
export function ChannelSelect(props: {
  label: string;
  value: string;
  onChange: (channel: string) => void;
}): React.JSX.Element {
  const known = ['teams', 'telegram', 'discord', 'whatsapp'];
  const options = known.includes(props.value) || !props.value ? known : [props.value, ...known];
  return (
    <label className={gcLbl}>
      {props.label}
      <select className={gcInput} value={props.value || 'teams'} onChange={(e) => props.onChange(e.target.value)}>
        {options.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Combobox: a free-text input backed by a <datalist> of known ids (roles, agents,
 * actions, events). Suggests existing refs while still allowing a not-yet-created
 * one — the proven W5 event-catalog pattern, generalised.
 */
export function RefPicker(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  placeholder?: string;
  hint?: string;
}): React.JSX.Element {
  const listId = useId();
  return (
    <label className={gcLbl}>
      {props.label}
      <input
        className={gcInput}
        list={listId}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <datalist id={listId}>
        {props.options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      {props.hint ? <span className={gcHint}>{props.hint}</span> : null}
    </label>
  );
}

/**
 * SelectPicker — a real <select> dropdown over a known catalog (agents, actions).
 * Preserves a stored value that isn't in the catalog (e.g. a disabled agent) as its
 * own option so loading never silently drops it, and offers an empty option.
 */
export function SelectPicker(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  emptyLabel?: string;
  hint?: string;
}): React.JSX.Element {
  const present = props.value === '' || props.options.some((o) => o.value === props.value);
  return (
    <label className={gcLbl}>
      {props.label}
      <select className={gcInput} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        <option value="">{props.emptyLabel ?? '—'}</option>
        {!present ? <option value={props.value}>{props.value}</option> : null}
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {props.hint ? <span className={gcHint}>{props.hint}</span> : null}
    </label>
  );
}
