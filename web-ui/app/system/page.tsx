import type { Metadata } from 'next';

import { getVaultStatus } from '../_lib/api';
import { redirectIfUnauthorized } from '../_lib/authRedirect';
import { VaultStatusCard } from './_components/VaultStatusCard';

export const metadata: Metadata = {
  title: 'System · Omadia',
};

export const dynamic = 'force-dynamic';

export default async function SystemPage(): Promise<React.ReactElement> {
  let status = null;
  let loadError: string | null = null;
  try {
    status = await getVaultStatus();
  } catch (err) {
    await redirectIfUnauthorized(err);
    loadError =
      err instanceof Error
        ? err.message
        : 'Unbekannter Fehler beim Laden des Vault-Status.';
  }

  return (
    <main className="mx-auto max-w-[1280px] px-6 py-12 lg:px-10 lg:py-16">
      <header className="b5-hero-bg relative -mx-6 rounded-[22px] border border-[color:var(--divider)] px-6 py-10 lg:-mx-10 lg:px-10 lg:py-14">
        <div className="flex items-baseline gap-3 text-[12px] font-semibold uppercase tracking-[0.24em] text-[color:var(--accent)]">
          <span className="font-mono-num text-[color:var(--fg-subtle)]">
            03
          </span>
          <span className="h-px flex-1 bg-[color:var(--border)]" />
          <span>System</span>
        </div>

        <h1 className="font-display mt-6 text-[clamp(2.25rem,4.5vw,3.75rem)] leading-[1.05] text-[color:var(--fg-strong)]">
          Plattform-Zustand.
        </h1>

        <p className="mt-6 max-w-2xl text-[18px] font-semibold leading-[1.55] text-[color:var(--fg-muted)]">
          <span className="text-[color:var(--highlight)] font-[900]">:</span>{' '}
          Laufzeit, Persistenz, Backup. Nur Metadaten &mdash; keine Secrets.
        </p>
      </header>

      <section className="mt-10 grid gap-6 lg:grid-cols-2">
        {loadError ? (
          <div className="rounded-[18px] border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/5 p-6 text-sm text-[color:var(--danger)]">
            <div className="font-semibold">Vault-Status nicht erreichbar</div>
            <div className="mt-2 font-mono text-xs">{loadError}</div>
          </div>
        ) : status ? (
          <VaultStatusCard status={status} />
        ) : null}
      </section>
    </main>
  );
}
