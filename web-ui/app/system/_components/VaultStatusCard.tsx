import { getTranslations } from 'next-intl/server';

import type { VaultStatusResponse } from '../../_lib/api';

interface Props {
  status: VaultStatusResponse;
}

type TFn = (key: string, values?: Record<string, string | number>) => string;

export async function VaultStatusCard({
  status,
}: Props): Promise<React.ReactElement> {
  const t = await getTranslations('system.vaultStatus');
  const { vault, backup } = status;
  const keySourceLabel = formatKeySource(vault.master_key_source, t);
  const keyTone = vault.production_ready ? 'ok' : 'warn';
  const backupTone: Tone = backup.enabled
    ? backup.last_error
      ? 'danger'
      : backup.last_success_at
        ? 'ok'
        : 'warn'
    : 'muted';

  return (
    <article className="rounded-lg border border-[color:var(--divider)] bg-[color:var(--surface)] p-6 shadow-sm">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-[color:var(--fg-subtle)]">
            Encrypted Secret Vault
          </div>
          <h2 className="font-display mt-1 text-2xl text-[color:var(--fg-strong)]">
            Vault
          </h2>
        </div>
        <StatusDot tone={keyTone} label={dotLabel(keyTone, t)} />
      </header>

      <dl className="mt-6 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Row label={t('masterKey')} value={keySourceLabel} tone={keyTone} />
        <Row
          label={t('persistence')}
          value={vault.data_dir}
          mono
        />
        <Row
          label={t('vaultFile')}
          value={vault.exists ? shorten(vault.path) : t('notWrittenYet')}
          mono={vault.exists}
        />
        <Row
          label={t('size')}
          value={vault.size_bytes !== null ? `${vault.size_bytes} B` : '—'}
        />
        <Row
          label={t('lastModified')}
          value={formatDate(vault.last_modified)}
        />
        <Row
          label={t('agentsWithSecrets')}
          value={String(vault.agent_count)}
        />
      </dl>

      <hr className="my-6 border-[color:var(--border)]" />

      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-[color:var(--fg-subtle)]">
            {t('backupHeading')}
          </div>
          <h3 className="font-display mt-1 text-lg text-[color:var(--fg-strong)]">
            {backup.enabled ? t('backupActive') : t('backupDisabled')}
          </h3>
        </div>
        <StatusDot tone={backupTone} label={dotLabel(backupTone, t)} />
      </div>

      {backup.enabled ? (
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Row label="Bucket" value={backup.bucket} mono />
          <Row label="Prefix" value={backup.prefix} mono />
          <Row
            label={t('interval')}
            value={t('intervalValue', {
              hours: backup.interval_hours,
              retention: backup.retention,
            })}
          />
          <Row
            label={t('lastRun')}
            value={formatDate(backup.last_run_at)}
          />
          <Row
            label={t('lastSuccess')}
            value={formatDate(backup.last_success_at)}
            tone={backup.last_success_at ? 'ok' : 'warn'}
          />
          <Row
            label={t('nextRun')}
            value={formatDate(backup.next_run_at)}
          />
          <Row
            label={t('storedSnapshots')}
            value={backup.objects_kept !== null ? String(backup.objects_kept) : '—'}
          />
          {backup.last_error ? (
            <Row
              label={t('lastError')}
              value={backup.last_error}
              tone="danger"
              mono
            />
          ) : null}
        </dl>
      ) : (
        <p className="mt-3 text-sm text-[color:var(--fg-muted)]">
          {backup.last_error ?? t('noReasonKnown')}
        </p>
      )}
    </article>
  );
}

type Tone = 'ok' | 'warn' | 'danger' | 'muted';

interface RowProps {
  label: string;
  value: string;
  mono?: boolean;
  tone?: Tone;
}

function Row({ label, value, mono, tone = 'muted' }: RowProps): React.ReactElement {
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

function StatusDot({
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

function dotLabel(tone: Tone, t: TFn): string {
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

function formatKeySource(
  source: VaultStatusResponse['vault']['master_key_source'],
  t: TFn,
): string {
  switch (source) {
    case 'env':
      return 'VAULT_KEY (env) — production';
    case 'dev-file-existed':
      return t('keySourceDevFile');
    case 'dev-file-created':
      return t('keySourceDevFileCreated');
    default:
      return source;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('de-DE');
  } catch {
    return iso;
  }
}

function shorten(p: string): string {
  if (p.length <= 48) return p;
  return `…${p.slice(-45)}`;
}
