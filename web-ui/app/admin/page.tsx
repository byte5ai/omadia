import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Admin · Omadia',
};

export default function AdminIndexPage(): React.ReactElement {
  return (
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
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
          href="/admin/builder"
          title="Agent-Builder"
          description="Visuelle Node-Graph-Leinwand: Kanäle, Sub-Agenten, Skills, Tools/MCP und Zeitpläne verdrahten. Verbindung ziehen schreibt die Verdrahtung, Kante löschen entfernt sie."
        />
        <AdminCard
          href="/admin/settings"
          title="Konfiguration"
          description="Alle .env-basierten Werte (Modelle & Routing, Verifier, Embeddings, Integrationen), die in Config-Store/Vault landen — direkt editierbar. Auto-Save, wirkt sofort ohne Neustart."
        />
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
        <AdminCard
          href="/admin/registries"
          title="Plugin-Registries"
          description="Store-Quellen verwalten (Standard: hub.omadia.ai). Private Registries mit Token. Änderungen wirken ohne Neustart."
        />
        <AdminCard
          href="/admin/bulk-promote"
          title="Memory · Bulk-Promotion"
          description="Historische Turns nachträglich auf Significance scoren und bei hoher Bewertung als MemorableKnowledge promoten. Idempotent."
        />
        <AdminCard
          href="/admin/inconsistencies"
          title="Memory · Widersprüche"
          description="Semantisch ähnliche Memories mit widersprüchlichen Aussagen — Operator entscheidet welche korrekt ist (oder ob beide gelten)."
        />
        <AdminCard
          href="/admin/memory-backend"
          title="Memory · Speicher-Backend"
          description="Memory-Storage zwischen Dateisystem und Postgres umschalten. Postgres benötigt DATABASE_URL (Neon-KG/graphPool). Der Wechsel greift erst nach einem Neustart."
        />
        <AdminCard
          href="/admin/danger-zone"
          title="Danger Zone · Memory-Purge"
          description="Memory unwiderruflich entlang einer Achse löschen (Alles / Agent / User / Team / Channel). Vorschau-gated, mit Confirm-Phrase. Kein Undo."
          danger
        />
        <AdminCard
          href="/admin/usage"
          title="Kosten"
          description="LLM-Token-Verbrauch und Kosten pro Modell, Quelle und Zeit. Cache-Hit-Rate und Gesamtkosten über jeden Anthropic-Call (Orchestrator, Sub-Agents, Background-Tasks)."
        />
      </ul>
    </main>
  );
}

function AdminCard({
  href,
  title,
  description,
  danger = false,
}: {
  href: string;
  title: string;
  description: string;
  danger?: boolean;
}): React.ReactElement {
  return (
    <li>
      <Link
        href={href}
        className={
          danger
            ? 'block rounded-lg border border-[color:var(--danger-edge)]/40 bg-[color:var(--danger)]/5 p-4 transition-colors hover:border-[color:var(--danger-edge)]'
            : 'block rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4 transition-colors hover:border-[color:var(--accent)]'
        }
      >
        <div
          className={
            danger
              ? 'text-[15px] font-semibold text-[color:var(--danger)]'
              : 'text-[15px] font-semibold text-[color:var(--fg-strong)]'
          }
        >
          {title}
        </div>
        <p className="mt-2 text-sm text-[color:var(--fg-muted)]">
          {description}
        </p>
      </Link>
    </li>
  );
}
