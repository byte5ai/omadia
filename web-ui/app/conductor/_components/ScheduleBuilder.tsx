'use client';

/**
 * ScheduleBuilder — turn the raw 5-field cron string into a guided picker with a
 * plain-language preview, so nobody has to remember `0 9 * * 1`. Presets cover the
 * common cases (hourly / daily / weekly / monthly); an "advanced" mode keeps the
 * raw cron field for power users. The control round-trips the SAME cron string the
 * trigger already stores.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { gcInput, gcLbl } from './GuidedControls';

type Mode = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'advanced';

interface CronParts {
  mode: Mode;
  minute: number;
  hour: number;
  dom: number; // day of month 1-31
  dow: number; // day of week 0-6 (Sun..Sat)
  raw: string;
}

const DEFAULTS: CronParts = { mode: 'daily', minute: 0, hour: 9, dom: 1, dow: 1, raw: '0 9 * * *' };

function clampInt(v: string, lo: number, hi: number, fallback: number): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** Best-effort parse of a cron string into a known preset; unrecognised → advanced. */
export function parseCron(cron: string): CronParts {
  const s = (cron ?? '').trim();
  if (!s) return { ...DEFAULTS };
  const f = s.split(/\s+/);
  if (f.length !== 5) return { ...DEFAULTS, mode: 'advanced', raw: s };
  const [min = '', hr = '', dom = '', mon = '', dow = ''] = f;
  const numeric = (x: string): number | null => (/^\d+$/.test(x) ? Number(x) : null);
  const m = numeric(min);
  const h = numeric(hr);
  // hourly: `0 * * * *`
  if (min === '0' && hr === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { ...DEFAULTS, mode: 'hourly', minute: 0, raw: s };
  }
  if (m !== null && h !== null && mon === '*') {
    // daily: `M H * * *`
    if (dom === '*' && dow === '*') return { ...DEFAULTS, mode: 'daily', minute: m, hour: h, raw: s };
    // weekly: `M H * * D`
    const d = numeric(dow);
    if (dom === '*' && d !== null) return { ...DEFAULTS, mode: 'weekly', minute: m, hour: h, dow: d, raw: s };
  }
  // monthly: `M H D * *`
  const dnum = numeric(dom);
  if (m !== null && h !== null && dnum !== null && mon === '*' && dow === '*') {
    return { ...DEFAULTS, mode: 'monthly', minute: m, hour: h, dom: dnum, raw: s };
  }
  return { ...DEFAULTS, mode: 'advanced', raw: s };
}

function buildCron(p: CronParts): string {
  const hh = String(p.hour);
  const mm = String(p.minute);
  switch (p.mode) {
    case 'hourly':
      return '0 * * * *';
    case 'daily':
      return `${mm} ${hh} * * *`;
    case 'weekly':
      return `${mm} ${hh} * * ${String(p.dow)}`;
    case 'monthly':
      return `${mm} ${hh} ${String(p.dom)} * *`;
    case 'advanced':
      return p.raw;
  }
}

const hhmm = (p: CronParts): string =>
  `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;

export function ScheduleBuilder(props: {
  label: string;
  value: string;
  onChange: (cron: string) => void;
}): React.JSX.Element {
  const t = useTranslations('conductor');
  const [parts, setParts] = useState<CronParts>(() => parseCron(props.value));

  // Re-seed when the cron changes from outside (e.g. a workflow loads) and no
  // longer matches what we last emitted.
  useEffect(() => {
    // Controlled-component resync: adopt an externally-changed cron (e.g. a workflow loads). Compare
    // TRIMMED so a self-emitted value with incidental whitespace (advanced raw box) doesn't yank the
    // user back into a preset mode mid-edit (review M2).
    if (buildCron(parts).trim() !== (props.value ?? '').trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setParts(parseCron(props.value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);

  const update = (next: CronParts): void => {
    setParts(next);
    props.onChange(buildCron(next));
  };

  // Mode switch must not lose structured edits: entering advanced seeds `raw` from the current preset
  // (else buildCron would emit the stale loaded raw); leaving advanced re-derives the fields from the
  // raw cron so a hand-edited expression carries its time/day into the preset (review H2).
  const changeMode = (nextMode: Mode): void => {
    if (nextMode === 'advanced') {
      update({ ...parts, mode: 'advanced', raw: buildCron({ ...parts, mode: parts.mode }) });
    } else if (parts.mode === 'advanced') {
      update({ ...parseCron(parts.raw), mode: nextMode });
    } else {
      update({ ...parts, mode: nextMode });
    }
  };

  const dows = [0, 1, 2, 3, 4, 5, 6];
  const preview =
    parts.mode === 'hourly'
      ? t('cronPreviewHourly')
      : parts.mode === 'daily'
        ? t('cronPreviewDaily', { time: hhmm(parts) })
        : parts.mode === 'weekly'
          ? t('cronPreviewWeekly', { day: t(`weekday_${String(parts.dow)}`), time: hhmm(parts) })
          : parts.mode === 'monthly'
            ? t('cronPreviewMonthly', { dom: String(parts.dom), time: hhmm(parts) })
            : t('cronPreviewAdvanced');

  return (
    <div className="grid gap-2">
      <label className={gcLbl}>
        {props.label}
        <select className={gcInput} value={parts.mode} onChange={(e) => changeMode(e.target.value as Mode)}>
          <option value="hourly">{t('cronModeHourly')}</option>
          <option value="daily">{t('cronModeDaily')}</option>
          <option value="weekly">{t('cronModeWeekly')}</option>
          <option value="monthly">{t('cronModeMonthly')}</option>
          <option value="advanced">{t('cronModeAdvanced')}</option>
        </select>
      </label>

      {parts.mode === 'weekly' && (
        <label className={gcLbl}>
          {t('cronWeekday')}
          <select className={gcInput} value={parts.dow} onChange={(e) => update({ ...parts, dow: Number(e.target.value) })}>
            {dows.map((d) => (
              <option key={d} value={d}>
                {t(`weekday_${String(d)}`)}
              </option>
            ))}
          </select>
        </label>
      )}

      {parts.mode === 'monthly' && (
        <label className={gcLbl}>
          {t('cronDayOfMonth')}
          <input
            type="number"
            min={1}
            max={31}
            className={gcInput}
            value={parts.dom}
            onChange={(e) => update({ ...parts, dom: clampInt(e.target.value, 1, 31, 1) })}
          />
        </label>
      )}

      {(parts.mode === 'daily' || parts.mode === 'weekly' || parts.mode === 'monthly') && (
        <label className={gcLbl}>
          {t('cronTime')}
          <input
            type="time"
            className={gcInput}
            value={hhmm(parts)}
            onChange={(e) => {
              const [h, m] = e.target.value.split(':');
              update({ ...parts, hour: clampInt(h ?? '', 0, 23, parts.hour), minute: clampInt(m ?? '', 0, 59, parts.minute) });
            }}
          />
        </label>
      )}

      {parts.mode === 'advanced' && (
        <label className={gcLbl}>
          {t('cronRaw')}
          <input
            className={`${gcInput} font-mono`}
            value={parts.raw}
            placeholder="0 9 * * 1"
            onChange={(e) => update({ ...parts, raw: e.target.value })}
          />
        </label>
      )}

      <p className="text-[11px] text-[color:var(--accent)]">🕒 {preview}</p>
    </div>
  );
}
