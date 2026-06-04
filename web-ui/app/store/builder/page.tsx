import type { Metadata } from 'next';
import Link from 'next/link';

import { listBuilderDrafts } from '../../_lib/api';
import { redirectIfUnauthorized } from '../../_lib/authRedirect';
import type {
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

type ScopeFilter = 'draft' | 'published' | 'deleted';

const SCOPE_LABEL: Record<ScopeFilter, string> = {
  draft: 'Entwurf',
  published: 'Bereitgestellt',
  deleted: 'Gelöscht',
};

export default async function BuilderDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}): Promise<React.ReactElement> {
  const params = await searchParams;
  const scope = parseScope(params.scope);

  // Two parallel calls: the active list (drives draft+published counts and
  // most-of-the-time the visible rows) plus the deleted list (drives the
  // Gelöscht-tab badge — without this second call the trash count is
  // always 0 because soft-deleted rows never appear under scope=active).
  // Each call is awaited independently so a deleted-fetch failure does not
  // mask the main view.
  let activeResponse: ListDraftsResponse | null = null;
  let activeError: string | null = null;
  try {
    activeResponse = await listBuilderDrafts({ scope: 'active' });
  } catch (err) {
    await redirectIfUnauthorized(err);
    activeError = err instanceof Error ? err.message : 'Drafts konnten nicht geladen werden.';
  }

  let deletedResponse: ListDraftsResponse | null = null;
  try {
    deletedResponse = await listBuilderDrafts({ scope: 'deleted' });
  } catch (err) {
    await redirectIfUnauthorized(err);
    // Silent: a failed deleted-fetch only blanks the trash-count badge; we
    // log and let the user keep working with the rest of the dashboard.
    console.warn(
      '[builder] deleted-scope fetch failed (trash count will read 0):',
      err instanceof Error ? err.message : err,
    );
  }

  const activeItems = activeResponse?.items ?? [];
  const deletedItems = deletedResponse?.items ?? [];
  const loadError = activeError;

  const quota =
    activeResponse?.quota ?? {
      used: 0,
      cap: 50,
      warnAt: 40,
      remaining: 50,
      warning: false,
      exceeded: false,
    };

  const visible = filterByScope(activeItems, deletedItems, scope);
  const counts = countByScope(activeItems, deletedItems);

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
              Neue Agents bauen.
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
          <Stat label="Entwürfe" value={counts.draft} />
          <Stat label="Bereitgestellt" value={counts.published} />
          <Stat label="Gelöscht" value={counts.deleted} />
          <Stat label="Limit" value={quota.cap} />
        </dl>
      </header>

      <nav
        className="mt-10 flex flex-wrap items-center gap-2"
        aria-label="Scope filter"
      >
        {(['draft', 'published', 'deleted'] as ScopeFilter[]).map((s) => {
          const active = s === scope;
          const count = counts[s];
          return (
            <Link
              key={s}
              href={s === 'draft' ? '/store/builder' : `/store/builder?scope=${s}`}
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
    scope === 'draft'
      ? 'Noch keine Entwürfe.'
      : scope === 'published'
        ? 'Noch nichts bereitgestellt.'
        : 'Papierkorb ist leer.';
  const hint =
    scope === 'draft'
      ? 'Klicke rechts oben auf „Neuer Agent" um deinen ersten Entwurf anzulegen.'
      : scope === 'published'
        ? 'Bereitgestellte Agents erscheinen hier, sobald du einen Entwurf in die Plattform-Registry deiner Instanz übernommen hast.'
        : 'Gelöschte Entwürfe tauchen hier auf und können wiederhergestellt werden, bis du sie endgültig löschst.';
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
  if (raw === 'published' || raw === 'deleted' || raw === 'draft') return raw;
  // Legacy aliases — bookmarks from the pre-rename URL scheme still
  // resolve to the new tabs.
  if (raw === 'installed') return 'published';
  if (raw === 'active') return 'draft';
  return 'draft';
}

function filterByScope(
  activeItems: DraftSummary[],
  deletedItems: DraftSummary[],
  scope: ScopeFilter,
): DraftSummary[] {
  if (scope === 'deleted') {
    return deletedItems;
  }
  if (scope === 'published') {
    return activeItems.filter((i) => i.status === 'published');
  }
  // 'draft' — anything in the active scope that isn't yet published.
  return activeItems.filter((i) => i.status !== 'published');
}

function countByScope(
  activeItems: DraftSummary[],
  deletedItems: DraftSummary[],
): Record<ScopeFilter, number> {
  // activeItems carries everything not in the trash; we partition by status.
  // deletedItems is the authoritative source for the "Gelöscht" count —
  // there is no other way to get it because the active scope filters out
  // soft-deleted rows server-side.
  const published = activeItems.filter((i) => i.status === 'published').length;
  const draft = activeItems.filter((i) => i.status !== 'published').length;
  return {
    draft,
    published,
    deleted: deletedItems.length,
  };
}
