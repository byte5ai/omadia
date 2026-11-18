/**
 * Presentational pieces shared by the `/system` cards (vault, platform health).
 * Extracted from `VaultStatusCard` when the platform health card joined it
 * (#1385), so both render rows and status dots the same way.
 */

/** Translator for a namespace that carries `dotOk`/`dotWarn`/`dotDanger`/`dotInactive`. */
export type TFn = (key: string, values?: Record<string, string | number>) => string;

export type Tone = 'ok' | 'warn' | 'danger' | 'muted';

interface RowProps {
  label: string;
  value: string;
  mono?: boolean;
  tone?: Tone;
}

export function Row({ label, value, mono, tone = 'muted' }: RowProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
        {label}
      </dt>
      <dd
        className={[
          mono ? 'font-mono text-xs' : 'text-sm',
          toneClass(tone),
        ].join(' ')}
      >
        {value}
      </dd>
    </div>
  );
}

export function StatusDot({
  tone,
  label,
}: {
  tone: Tone;
  label: string;
}): React.ReactElement {
  const color =
    tone === 'ok'
      ? 'bg-[color:var(--success)]/100'
      : tone === 'warn'
        ? 'bg-[color:var(--warning)]/100'
        : tone === 'danger'
          ? 'bg-[color:var(--danger)]/80'
          : 'bg-[color:var(--fg-subtle)]';
  return (
    <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-[color:var(--fg-subtle)]">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}

export function dotLabel(tone: Tone, t: TFn): string {
  switch (tone) {
    case 'ok':
      return t('dotOk');
    case 'warn':
      return t('dotWarn');
    case 'danger':
      return t('dotDanger');
    default:
      return t('dotInactive');
  }
}

function toneClass(tone: Tone): string {
  switch (tone) {
    case 'ok':
      return 'text-[color:var(--fg-strong)]';
    case 'warn':
      return 'text-[color:var(--warning)]';
    case 'danger':
      return 'text-[color:var(--danger)]';
    default:
      return 'text-[color:var(--fg-strong)]';
  }
}
