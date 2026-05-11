import type { Metadata } from 'next';
import Link from 'next/link';

import { listBuilderDrafts } from '../../_lib/api';
import type {
  DraftListScope,
  DraftSummary,
  ListDraftsResponse,
} from '../../_lib/builderTypes';
import { cn } from '../../_lib/cn';
import { CreateDraftButton } from './_components/CreateDraftButton';
import { DraftRow } from './_components/DraftRow';
import { ImportBundleButton } from './_components/ImportBundleButton';
import { QuotaBadge } from './_components/QuotaBadge';

export const metadata: Metadata = {
  title: 'Agent-Builder · Omadia',
};

export const dynamic = 'force-dynamic';

type ScopeFilter = 'active' | 'installed' | 'deleted';

const SCOPE_LABEL: Record<ScopeFilter, string> = {
  active: 'Aktiv',
  installed: 'Installiert',
  deleted: 'Papierkorb',
};

export default async function BuilderDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}): Promise<React.ReactElement> {
  const params = await searchParams;
  const scope = parseScope(params.scope);

  let response: ListDraftsResponse | null = null;
  let loadError: string | null = null;

  try {
    response = await listBuilderDrafts({ scope: apiScopeFor(scope) });
  } catch (err) {
    loadError = err instanceof Error ? err.message : 'Drafts konnten nicht geladen werden.';
  }

  const items = response?.items ?? [];
  const quota =
    response?.quota ?? {
      used: 0,
      cap: 50,
      warnAt: 40,
      remaining: 50,
      warning: false,
      exceeded: false,
    };

  const visible = filterByScope(items, scope);
  const counts = countByScope(items);

  return (
    <main className="mx-auto max-w-[1280px] px-6 py-12 lg:px-10 lg:py-16">
      <header className="b5-hero-bg relative -mx-6 rounded-[22px] border border-[color:var(--divider)] px-6 py-10 lg:-mx-10 lg:px-10 lg:py-14">
        <div className="flex items-baseline gap-3 text-[12px] font-semibold uppercase tracking-[0.24em] text-[color:var(--accent)]">
          <span className="font-mono-num text-[color:var(--fg-subtle)]">02</span>
          <span className="h-px flex-1 bg-[color:var(--border)]" />
          <span>Agent-Builder</span>
        </div>

        <div className="mt-6 flex items-start justify-between gap-6">
          <div className="max-w-2xl">
            <h1 className="font-display text-[clamp(2.25rem,4.5vw,3.75rem)] leading-[1.05] text-[color:var(--fg-strong)]">
              Neue Agents zusammenstecken.
            </h1>
            <p className="mt-6 text-[18px] font-semibold leading-[1.55] text-[color:var(--fg)]">
              <span className="b5-colon">:</span>
              Lege Drafts an, iteriere parallel an mehreren Agents und
              installiere sie per Klick in die Plattform. Jeder Draft lebt in
              deinem persönlichen Arbeitsbereich — keiner sieht deine
              Entwürfe außer dir.
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-3">
            <QuotaBadge quota={quota} />
            <div className="flex items-center gap-2">
              <ImportBundleButton />
              <CreateDraftButton quota={quota} />
            </div>
          </div>
        </div>

        <dl className="mt-10 grid max-w-2xl grid-cols-4 gap-6 border-t border-[color:var(--divider)] pt-5 text-sm">
          <Stat label="Drafts aktiv" value={counts.active} />
          <Stat label="Installiert" value={counts.installed} />
          <Stat label="Papierkorb" value={counts.deleted} />
          <Stat label="Limit" value={quota.cap} />
        </dl>
      </header>

      <nav
        className="mt-10 flex flex-wrap items-center gap-2"
        aria-label="Scope filter"
      >
        {(['active', 'installed', 'deleted'] as ScopeFilter[]).map((s) => {
          const active = s === scope;
          const count = counts[s];
          return (
            <Link
              key={s}
              href={s === 'active' ? '/store/builder' : `/store/builder?scope=${s}`}
              className={cn(
                'inline-flex items-center gap-2 rounded-full px-4 py-1.5',
                'text-[12px] font-semibold transition-colors duration-[140ms]',
                'ease-[cubic-bezier(0.22,0.61,0.36,1)]',
                active
                  ? 'bg-[color:var(--accent)] text-white shadow-[var(--shadow-cta)]'
                  : 'bg-[color:var(--bg-soft)] text-[color:var(--fg-muted)] hover:bg-[color:var(--gray-100)] hover:text-[color:var(--fg-strong)]',
              )}
              aria-current={active ? 'page' : undefined}
            >
              <span>{SCOPE_LABEL[s]}</span>
              <span
                className={cn(
                  'font-mono-num tabular-nums rounded-full px-1.5 text-[10px]',
                  active
                    ? 'bg-white/25 text-white'
                    : 'bg-[color:var(--bg)] text-[color:var(--fg-subtle)]',
                )}
              >
                {count}
              </span>
            </Link>
          );
        })}
      </nav>

      <section className="mt-8">
        {loadError ? (
          <LoadErrorState message={loadError} />
        ) : visible.length === 0 ? (
          <EmptyState scope={scope} />
        ) : (
          <div className="flex flex-col gap-3">
            {visible.map((draft) => (
              <DraftRow
                key={draft.id}
                draft={draft}
                deleted={scope === 'deleted'}
              />
            ))}
          </div>
        )}
      </section>

      <footer className="mt-20 flex items-center justify-between border-t border-[color:var(--divider)] pt-5 text-[11px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
        <span>
          Phase{' '}
          <span className="font-mono-num normal-case tracking-normal text-[color:var(--fg-muted)]">
            B.0 Draft-Store
          </span>
        </span>
        <span className="font-mono-num text-[color:var(--fg-muted)]">
          Omadia · Agent-Builder
        </span>
      </footer>
    </main>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: number;
}): React.ReactElement {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[color:var(--fg-subtle)]">
        {label}
      </dt>
      <dd className="font-display mt-1 text-[32px] leading-none text-[color:var(--fg-strong)]">
        {String(value).padStart(2, '0')}
      </dd>
    </div>
  );
}

function EmptyState({ scope }: { scope: ScopeFilter }): React.ReactElement {
  const headline =
    scope === 'active'
      ? 'Noch keine Drafts.'
      : scope === 'installed'
        ? 'Noch nichts installiert.'
        : 'Papierkorb ist leer.';
  const hint =
    scope === 'active'
      ? 'Klicke rechts oben auf „Neuer Agent" um deinen ersten Draft anzulegen.'
      : scope === 'installed'
        ? 'Installierte Agents erscheinen hier, sobald du einen Draft über den Workspace ausgeliefert hast.'
        : 'Gelöschte Drafts tauchen hier auf und können wiederhergestellt werden, bis du sie endgültig löschst.';
  return (
    <div className="rounded-[14px] border border-dashed border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] p-12 text-center">
      <p className="font-display text-[22px] text-[color:var(--fg-strong)]">{headline}</p>
      <p className="mt-3 text-sm leading-relaxed text-[color:var(--fg-muted)]">{hint}</p>
    </div>
  );
}

function LoadErrorState({ message }: { message: string }): React.ReactElement {
  return (
    <div className="rounded-[14px] border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/6 p-8">
      <div className="flex items-baseline gap-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[color:var(--danger)]">
        <span>Fehler</span>
        <span className="h-px flex-1 bg-[color:var(--danger)]/30" />
      </div>
      <p className="font-display mt-4 text-[26px] text-[color:var(--danger)]">
        Drafts konnten nicht geladen werden.
      </p>
      <p className="mt-3 font-mono-num text-sm text-[color:var(--fg-muted)]">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseScope(raw: string | undefined): ScopeFilter {
  if (raw === 'installed' || raw === 'deleted') return raw;
  return 'active';
}

/**
 * The API has three scopes (`active`, `all`, `deleted`); we fan that out in
 * the UI to four filter buttons. `installed` is a status-filter applied on
 * top of the `active` scope, so the API request for both `active` and
 * `installed` is the same — the UI does the post-filter.
 */
function apiScopeFor(uiScope: ScopeFilter): DraftListScope {
  return uiScope === 'deleted' ? 'deleted' : 'active';
}

function filterByScope(
  items: DraftSummary[],
  scope: ScopeFilter,
): DraftSummary[] {
  if (scope === 'installed') {
    return items.filter((i) => i.status === 'installed');
  }
  if (scope === 'active') {
    // Hide installed drafts from the "Aktiv" tab — they live under their own
    // tab and would otherwise compete visually with in-flight work.
    return items.filter((i) => i.status !== 'installed');
  }
  return items;
}

function countByScope(items: DraftSummary[]): Record<ScopeFilter, number> {
  // `items` is already scope-scoped on the server; the counts shown in the
  // filter buttons reflect what the user *would* see if they switched tabs.
  // For B.0 we approximate: the `installed` count is drawn from the active-
  // list (installed drafts live under scope=active but filtered out). The
  // `deleted` tab gets a best-effort count of 0 unless we're already on it.
  // Precise counts land in B.5 when we fetch `scope=all` once.
  const installed = items.filter((i) => i.status === 'installed').length;
  const activeNotInstalled = items.filter((i) => i.status !== 'installed').length;
  const deleted = items.length > 0 && items[0]?.status === 'archived' ? items.length : 0;
  return {
    active: activeNotInstalled,
    installed,
    deleted,
  };
}
