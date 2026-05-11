import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Admin · Omadia',
};

export default function AdminIndexPage(): React.ReactElement {
  return (
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-10 lg:py-16">
      <header className="mb-10">
        <h1 className="font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          Admin
        </h1>
        <p className="mt-3 max-w-2xl text-[16px] leading-[1.55] text-[color:var(--fg-muted)]">
          Verwaltung der Authentifizierungs-Provider und der lokalen
          Benutzerkonten.
        </p>
      </header>

      <ul className="grid gap-4 lg:grid-cols-2">
        <AdminCard
          href="/admin/auth"
          title="Authentifizierungs-Provider"
          description="Lokale Anmeldung und Entra-ID aktivieren oder deaktivieren. Änderungen wirken ohne Neustart."
        />
        <AdminCard
          href="/admin/users"
          title="Benutzer"
          description="Lokale Konten anlegen, deaktivieren, Passwort zurücksetzen oder löschen."
        />
        <AdminCard
          href="/admin/kg-lifecycle"
          title="Knowledge-Graph Lifecycle"
          description="Tier-Histogram (HOT/WARM/COLD), Decay-Verteilung, Top-Scopes. Decay- und GC-Sweeps manuell ausführen."
        />
        <AdminCard
          href="/admin/kg-priorities"
          title="Knowledge-Graph Priorities"
          description="Per-Agent Block/Boost-Liste für den Token-Budget-Assembler. Operator-Override für Recall-Hits pro Agent."
        />
        <AdminCard
          href="/admin/domains"
          title="Plugin-Domains"
          description="Übersicht aller registrierten Plugins gruppiert nach Domain (z.B. odoo, m365.calendar, core.knowledge-graph). Read-only — Curation kommt mit Phase 9."
        />
      </ul>
    </main>
  );
}

function AdminCard({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}): React.ReactElement {
  return (
    <li>
      <Link
        href={href}
        className="block rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5 transition-colors hover:border-[color:var(--accent)]"
      >
        <div className="text-[15px] font-semibold text-[color:var(--fg-strong)]">
          {title}
        </div>
        <p className="mt-1.5 text-sm text-[color:var(--fg-muted)]">
          {description}
        </p>
      </Link>
    </li>
  );
}
