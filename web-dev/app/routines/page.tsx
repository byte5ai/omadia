import type { Metadata } from 'next';

import { listRoutines, type RoutineDto } from '../_lib/api';
import { RoutineRow } from './_components/RoutineRow';

export const metadata: Metadata = {
  title: 'Routines · Omadia',
};

export const dynamic = 'force-dynamic';

export default async function RoutinesPage(): Promise<React.ReactElement> {
  let routines: RoutineDto[] = [];
  let count = 0;
  let loadError: string | null = null;
  try {
    const resp = await listRoutines();
    routines = resp.routines;
    count = resp.count;
  } catch (err) {
    loadError =
      err instanceof Error
        ? err.message
        : 'Unbekannter Fehler beim Laden der Routinen.';
  }

  const activeCount = routines.filter((r) => r.status === 'active').length;
  const pausedCount = routines.filter((r) => r.status === 'paused').length;

  return (
    <main className="mx-auto w-full max-w-[1600px] px-6 py-12 lg:px-10 lg:py-16">
      <header className="b5-hero-bg relative -mx-6 rounded-[22px] border border-[color:var(--divider)] px-6 py-10 lg:-mx-10 lg:px-10 lg:py-14">
        <div className="flex items-baseline gap-3 text-[12px] font-semibold uppercase tracking-[0.24em] text-[color:var(--accent)]">
          <span className="font-mono-num text-[color:var(--fg-subtle)]">
            04
          </span>
          <span className="h-px flex-1 bg-[color:var(--border)]" />
          <span>Routinen</span>
        </div>

        <h1 className="font-display mt-6 text-[clamp(2.25rem,4.5vw,3.75rem)] leading-[1.05] text-[color:var(--fg-strong)]">
          Cronjobs &amp; Routinen.
        </h1>

        <p className="mt-6 max-w-2xl text-[18px] font-semibold leading-[1.55] text-[color:var(--fg-muted)]">
          <span className="text-[color:var(--highlight)] font-[900]">:</span>{' '}
          User-eigene wiederkehrende Agent-Aufrufe. Anlegen passiert im Chat
          (manage_routine Tool); hier siehst du alles auf einen Blick und
          kannst pausieren oder löschen.
        </p>

        <div className="mt-8 flex flex-wrap gap-3 text-xs uppercase tracking-[0.2em] text-[color:var(--fg-subtle)]">
          <SummaryPill label="Total" value={count} tone="muted" />
          <SummaryPill label="Aktiv" value={activeCount} tone="ok" />
          <SummaryPill label="Pausiert" value={pausedCount} tone="warn" />
        </div>
      </header>

      <section className="mt-10">
        {loadError ? (
          <div className="rounded-[18px] border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/5 p-6 text-sm text-[color:var(--danger)]">
            <div className="font-semibold">Routinen nicht erreichbar</div>
            <div className="mt-2 font-mono text-xs">{loadError}</div>
          </div>
        ) : routines.length === 0 ? (
          <EmptyState />
        ) : (
          <RoutinesTable routines={routines} />
        )}
      </section>
    </main>
  );
}

function RoutinesTable({
  routines,
}: {
  routines: RoutineDto[];
}): React.ReactElement {
  return (
    <div className="overflow-x-auto rounded-[22px] border border-[color:var(--divider)] bg-[color:var(--surface)] shadow-sm">
      <table className="w-full table-fixed text-sm">
        <colgroup>
          <col className="w-[28%]" />
          <col className="w-[14%]" />
          <col className="w-[12%]" />
          <col className="w-[7%]" />
          <col className="w-[8%]" />
          <col className="w-[16%]" />
          <col className="w-[15%]" />
        </colgroup>
        <thead className="bg-[color:var(--surface-muted)] text-left text-[11px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
          <tr>
            <th className="px-4 py-3">Name</th>
            <th className="px-4 py-3">User · Tenant</th>
            <th className="px-4 py-3">Cron</th>
            <th className="px-4 py-3">Channel</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Letzter Lauf</th>
            <th className="px-4 py-3 text-right">Aktionen</th>
          </tr>
        </thead>
        <tbody>
          {routines.map((r) => (
            <RoutineRow key={r.id} routine={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'ok' | 'warn' | 'muted';
}): React.ReactElement {
  const colorVar =
    tone === 'ok' ? '--ok' : tone === 'warn' ? '--warn' : '--fg-subtle';
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border px-3 py-1"
      style={{
        borderColor: `color-mix(in oklab, var(${colorVar}) 30%, transparent)`,
        color: `var(${colorVar})`,
      }}
    >
      <span className="font-mono-num text-sm font-semibold">{value}</span>
      <span>{label}</span>
    </span>
  );
}

function EmptyState(): React.ReactElement {
  return (
    <div className="rounded-[22px] border border-dashed border-[color:var(--border)] bg-[color:var(--surface)] p-12 text-center">
      <div className="text-base font-semibold text-[color:var(--fg-strong)]">
        Noch keine Routinen.
      </div>
      <p className="mx-auto mt-2 max-w-md text-sm text-[color:var(--fg-muted)]">
        Routinen entstehen, wenn ein User im Chat etwas wie &bdquo;erinnere
        mich jeden Montag um 9 Uhr an X&ldquo; sagt &mdash; der Agent ruft
        das{' '}
        <code className="rounded bg-[color:var(--surface-muted)] px-1.5 py-0.5 font-mono text-xs">
          manage_routine
        </code>{' '}
        Tool und legt sie an.
      </p>
    </div>
  );
}

