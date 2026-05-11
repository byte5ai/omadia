import type { VaultStatusResponse } from '../../_lib/api';

interface Props {
  status: VaultStatusResponse;
}

export function VaultStatusCard({ status }: Props): React.ReactElement {
  const { vault, backup } = status;
  const keySourceLabel = formatKeySource(vault.master_key_source);
  const keyTone = vault.production_ready ? 'ok' : 'warn';
  const backupTone: Tone = backup.enabled
    ? backup.last_error
      ? 'danger'
      : backup.last_success_at
        ? 'ok'
        : 'warn'
    : 'muted';

  return (
    <article className="rounded-[22px] border border-[color:var(--divider)] bg-[color:var(--surface)] p-6 shadow-sm">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-[color:var(--fg-subtle)]">
            Encrypted Secret Vault
          </div>
          <h2 className="font-display mt-1 text-2xl text-[color:var(--fg-strong)]">
            Vault
          </h2>
        </div>
        <StatusDot tone={keyTone} />
      </header>

      <dl className="mt-6 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Row label="Master-Key" value={keySourceLabel} tone={keyTone} />
        <Row
          label="Persistenz"
          value={vault.data_dir}
          mono
        />
        <Row
          label="Vault-Datei"
          value={vault.exists ? shorten(vault.path) : 'noch nicht geschrieben'}
          mono={vault.exists}
        />
        <Row
          label="Größe"
          value={vault.size_bytes !== null ? `${vault.size_bytes} B` : '—'}
        />
        <Row
          label="Zuletzt geändert"
          value={formatDate(vault.last_modified)}
        />
        <Row
          label="Agenten mit Secrets"
          value={String(vault.agent_count)}
        />
      </dl>

      <hr className="my-6 border-[color:var(--border)]" />

      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-[color:var(--fg-subtle)]">
            Off-Site-Backup (Tigris)
          </div>
          <h3 className="font-display mt-1 text-lg text-[color:var(--fg-strong)]">
            {backup.enabled ? 'Aktiv' : 'Deaktiviert'}
          </h3>
        </div>
        <StatusDot tone={backupTone} />
      </div>

      {backup.enabled ? (
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Row label="Bucket" value={backup.bucket} mono />
          <Row label="Prefix" value={backup.prefix} mono />
          <Row
            label="Intervall"
            value={`${backup.interval_hours}h · max ${backup.retention} Snapshots`}
          />
          <Row
            label="Letzter Lauf"
            value={formatDate(backup.last_run_at)}
          />
          <Row
            label="Letzter Erfolg"
            value={formatDate(backup.last_success_at)}
            tone={backup.last_success_at ? 'ok' : 'warn'}
          />
          <Row
            label="Nächster Lauf"
            value={formatDate(backup.next_run_at)}
          />
          <Row
            label="Gespeicherte Snapshots"
            value={backup.objects_kept !== null ? String(backup.objects_kept) : '—'}
          />
          {backup.last_error ? (
            <Row
              label="Letzter Fehler"
              value={backup.last_error}
              tone="danger"
              mono
            />
          ) : null}
        </dl>
      ) : (
        <p className="mt-3 text-sm text-[color:var(--fg-muted)]">
          {backup.last_error ?? 'Kein Grund bekannt.'}
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

function StatusDot({ tone }: { tone: Tone }): React.ReactElement {
  const color =
    tone === 'ok'
      ? 'bg-emerald-500'
      : tone === 'warn'
        ? 'bg-amber-500'
        : tone === 'danger'
          ? 'bg-rose-500'
          : 'bg-slate-400';
  return (
    <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-[color:var(--fg-subtle)]">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {tone === 'ok'
        ? 'OK'
        : tone === 'warn'
          ? 'Warnung'
          : tone === 'danger'
            ? 'Fehler'
            : 'Inaktiv'}
    </span>
  );
}

function toneClass(tone: Tone): string {
  switch (tone) {
    case 'ok':
      return 'text-[color:var(--fg-strong)]';
    case 'warn':
      return 'text-amber-600';
    case 'danger':
      return 'text-rose-600';
    default:
      return 'text-[color:var(--fg-strong)]';
  }
}

function formatKeySource(
  source: VaultStatusResponse['vault']['master_key_source'],
): string {
  switch (source) {
    case 'env':
      return 'VAULT_KEY (env) — production';
    case 'dev-file-existed':
      return 'dev-file (nicht für Produktion)';
    case 'dev-file-created':
      return 'dev-file (neu generiert — DEV ONLY)';
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
