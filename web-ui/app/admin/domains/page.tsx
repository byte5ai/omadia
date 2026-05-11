'use client';

import { useEffect, useState } from 'react';

/**
 * Admin → Plugin-Domains overview (Palaia Phase 8 / OB-77 Slice 3c).
 *
 * Read-only operator surface. Lists every plugin currently in the
 * `PluginCatalog` grouped by its declared `identity.domain`, with a
 * dedicated "fallback" bucket at the bottom for anything that
 * auto-fallbacked to `unknown.<id>` because the manifest lacks a domain.
 *
 * Backed by `/bot-api/admin/domains` (GET → grouped buckets). Curation
 * (rename / merge / hierarchy management) is intentionally **not** here —
 * that ships with OB-78 (Phase 9 Agent-Profile + Default-Process-Set).
 * For now, the operator's path to "fix" a fallback is: open the plugin's
 * manifest.yaml and add `identity.domain`, OR re-upload via the Builder
 * (Slice 3d) which captures the field at agent-creation time.
 */

type DomainPlugin = {
  id: string;
  name: string;
  kind: 'agent' | 'tool' | 'integration' | 'channel' | 'extension';
  domain: string;
  version: string;
  installState: string;
};

type DomainBucket = {
  domain: string;
  isFallback: boolean;
  plugins: DomainPlugin[];
};

type DomainsResponse = {
  totals: {
    plugins: number;
    domains: number;
    fallbackDomains: number;
  };
  buckets: DomainBucket[];
};

const ENDPOINT = '/bot-api/admin/domains';

export default function AdminDomainsPage(): React.ReactElement {
  const [data, setData] = useState<DomainsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch(ENDPOINT, { credentials: 'include' });
        if (!res.ok) {
          throw new Error(`HTTP ${String(res.status)} ${res.statusText}`);
        }
        const body = (await res.json()) as DomainsResponse;
        if (!cancelled) setData(body);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-10 lg:py-16">
      <header className="mb-10">
        <h1 className="font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          Plugin-Domains
        </h1>
        <p className="mt-3 max-w-2xl text-[16px] leading-[1.55] text-[color:var(--fg-muted)]">
          Übersicht aller registrierten Plugins, gruppiert nach ihrer in
          der <code>manifest.yaml</code> deklarierten <code>domain</code>.
          Domains werden vom Phase-8 Nudge-Pipeline-Multi-Domain-Trigger
          gelesen und vom Operator-UI für Cross-Agent-Gruppierung
          verwendet. Curation (Umbenennen / Mergen / Hierarchien) folgt
          mit OB-78 (Phase 9 Agent-Profile).
        </p>
      </header>

      {loading ? (
        <p className="text-[color:var(--fg-muted)]">Lade …</p>
      ) : error ? (
        <p className="rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          Fehler beim Laden: {error}
        </p>
      ) : data ? (
        <Content data={data} />
      ) : (
        <p className="text-[color:var(--fg-muted)]">Keine Daten.</p>
      )}
    </main>
  );
}

function Content({ data }: { data: DomainsResponse }): React.ReactElement {
  return (
    <>
      <section className="mb-8 grid grid-cols-3 gap-3">
        <Stat label="Plugins" value={data.totals.plugins} />
        <Stat label="Domains" value={data.totals.domains} />
        <Stat
          label="Fallbacks"
          value={data.totals.fallbackDomains}
          warn={data.totals.fallbackDomains > 0}
        />
      </section>

      {data.buckets.length === 0 ? (
        <p className="text-[color:var(--fg-muted)]">
          Keine Plugins im Katalog.
        </p>
      ) : (
        <ul className="space-y-6">
          {data.buckets.map((b) => (
            <DomainSection key={b.domain} bucket={b} />
          ))}
        </ul>
      )}

      {data.totals.fallbackDomains > 0 ? (
        <p className="mt-8 rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
          {data.totals.fallbackDomains} Plugin
          {data.totals.fallbackDomains === 1 ? '' : 's'} ohne deklarierte
          Domain — auto-fallback auf{' '}
          <code className="text-amber-100">unknown.&lt;id&gt;</code>. Füge
          dem Manifest eine <code>identity.domain</code>-Zeile hinzu (z.B.
          <code> &quot;confluence&quot;</code>,{' '}
          <code>&quot;odoo.hr&quot;</code>) oder lade den Agent über den
          Builder neu hoch.
        </p>
      ) : null}
    </>
  );
}

function DomainSection({
  bucket,
}: {
  bucket: DomainBucket;
}): React.ReactElement {
  return (
    <li
      className={
        bucket.isFallback
          ? 'rounded-[14px] border border-amber-500/40 bg-amber-500/5 p-5'
          : 'rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5'
      }
    >
      <header className="mb-4 flex items-baseline justify-between gap-3">
        <h2
          className={
            bucket.isFallback
              ? 'font-mono text-[15px] text-amber-200'
              : 'font-mono text-[15px] text-[color:var(--fg-strong)]'
          }
        >
          {bucket.domain}
        </h2>
        <span className="text-[13px] text-[color:var(--fg-muted)]">
          {bucket.plugins.length} Plugin
          {bucket.plugins.length === 1 ? '' : 's'}
        </span>
      </header>
      <ul className="divide-y divide-[color:var(--border)]/40">
        {bucket.plugins.map((p) => (
          <li
            key={p.id}
            className="flex items-baseline justify-between gap-4 py-2 text-[14px]"
          >
            <div className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[color:var(--fg-strong)]">
                {p.id}
              </span>
              <span className="block truncate text-[12px] text-[color:var(--fg-muted)]">
                {p.name} · {p.kind}
              </span>
            </div>
            <span className="font-mono text-[12px] text-[color:var(--fg-muted)]">
              v{p.version}
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}

function Stat({
  label,
  value,
  warn,
}: {
  label: string;
  value: number;
  warn?: boolean;
}): React.ReactElement {
  return (
    <div
      className={
        warn
          ? 'rounded-[12px] border border-amber-500/40 bg-amber-500/5 p-4'
          : 'rounded-[12px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4'
      }
    >
      <div className="text-[12px] uppercase tracking-wider text-[color:var(--fg-muted)]">
        {label}
      </div>
      <div
        className={
          warn
            ? 'mt-1 font-display text-[28px] text-amber-200'
            : 'mt-1 font-display text-[28px] text-[color:var(--fg-strong)]'
        }
      >
        {value}
      </div>
    </div>
  );
}
