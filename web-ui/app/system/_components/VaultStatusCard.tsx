import { getFormatter, getTranslations } from 'next-intl/server';

import type { VaultStatusResponse } from '../../_lib/api';
import { Row, StatusDot, dotLabel, type TFn, type Tone } from './statusParts';

interface Props {
  status: VaultStatusResponse;
}

type Formatter = Awaited<ReturnType<typeof getFormatter>>;

export async function VaultStatusCard({
  status,
}: Props): Promise<React.ReactElement> {
  const t = await getTranslations('system.vaultStatus');
  const format = await getFormatter();
  const { vault, backup } = status;
  // #1387 — two master keys, two rows. The header dot follows
  // `production_ready`, which the middleware now sets only when BOTH keys
  // come from env; each row carries its own key's tone.
  const keyTone: Tone = vault.master_key_source === 'env' ? 'ok' : 'warn';
  const keychainTone: Tone =
    vault.keychain_key_source === undefined
      ? 'muted'
      : vault.keychain_key_source === 'env'
        ? 'ok'
        : 'warn';
  const statusTone: Tone = vault.production_ready ? 'ok' : 'warn';
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
            {t('eyebrow')}
          </div>
          <h2 className="font-display mt-1 text-2xl text-[color:var(--fg-strong)]">
            {t('heading')}
          </h2>
        </div>
        <StatusDot tone={statusTone} label={dotLabel(statusTone, t)} />
      </header>

      <dl className="mt-6 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Row
          label={t('masterKey')}
          value={formatKeySource(vault.master_key_source, 'VAULT_KEY', t)}
          tone={keyTone}
        />
        <Row
          label={t('keychainKey')}
          value={
            vault.keychain_key_source === undefined
              ? t('keySourceUnknown')
              : formatKeySource(vault.keychain_key_source, 'CREDENTIAL_KEYCHAIN_KEY', t)
          }
          tone={keychainTone}
        />
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
          value={formatDate(vault.last_modified, format)}
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
          <Row label={t('bucket')} value={backup.bucket} mono />
          <Row label={t('prefix')} value={backup.prefix} mono />
          <Row
            label={t('interval')}
            value={t('intervalValue', {
              hours: backup.interval_hours,
              retention: backup.retention,
            })}
          />
          <Row
            label={t('lastRun')}
            value={formatDate(backup.last_run_at, format)}
          />
          <Row
            label={t('lastSuccess')}
            value={formatDate(backup.last_success_at, format)}
            tone={backup.last_success_at ? 'ok' : 'warn'}
          />
          <Row
            label={t('nextRun')}
            value={formatDate(backup.next_run_at, format)}
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

/**
 * #1387 — names the env var on every branch. The env case used to be a
 * hard-coded "VAULT_KEY (env) — production", which claimed production for the
 * whole card from one of its two keys (and bypassed the catalog).
 */
function formatKeySource(
  source: VaultStatusResponse['vault']['master_key_source'],
  envVar: string,
  t: TFn,
): string {
  switch (source) {
    case 'env':
      return t('keySourceEnv', { envVar });
    case 'dev-file-existed':
      return t('keySourceDevFile', { envVar });
    case 'dev-file-created':
      return t('keySourceDevFileCreated', { envVar });
    default:
      return source;
  }
}

function formatDate(iso: string | null, format: Formatter): string {
  if (!iso) return '—';
  try {
    return format.dateTime(new Date(iso));
  } catch {
    return iso;
  }
}

function shorten(p: string): string {
  if (p.length <= 48) return p;
  return `…${p.slice(-45)}`;
}
