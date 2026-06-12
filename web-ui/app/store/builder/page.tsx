import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
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

export default async function BuilderDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}): Promise<React.ReactElement> {
  const t = await getTranslations('builder.drafts.list');
  const params = await searchParams;
  const scope = parseScope(params.scope);

  const scopeLabel: Record<ScopeFilter, string> = {
    draft: t('scope.draft'),
    published: t('scope.published'),
    deleted: t('scope.deleted'),
  };

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
    activeError = err instanceof Error ? err.message : t('error.loadFailed');
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
    <main className="mx-auto max-w-[1280px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="b5-hero-bg relative -mx-6 rounded-lg border border-[color:var(--divider)] px-6 py-8 lg:-mx-8 lg:px-8 lg:py-12">
        <div className="flex items-baseline gap-3 text-[12px] font-semibold uppercase tracking-[0.24em] text-[color:var(--accent)]">
          <span className="font-mono-num text-[color:var(--fg-subtle)]">02</span>
          <span className="h-px flex-1 bg-[color:var(--border)]" />
          <span>{t('eyebrow')}</span>
        </div>

        <div className="mt-6 flex items-start justify-between gap-6">
          <div className="max-w-2xl">
            <h1 className="font-display text-[clamp(2.25rem,4.5vw,3.75rem)] leading-[1.05] text-[color:var(--fg-strong)]">
              {t('headline')}
            </h1>
            <p className="mt-6 text-[18px] font-semibold leading-[1.55] text-[color:var(--fg)]">
                            {t('lede')}
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

        <dl className="mt-8 grid max-w-2xl grid-cols-4 gap-6 border-t border-[color:var(--divider)] pt-4 text-sm">
          <Stat label={t('stats.drafts')} value={counts.draft} />
          <Stat label={t('stats.published')} value={counts.published} />
          <Stat label={t('stats.deleted')} value={counts.deleted} />
          <Stat label={t('stats.limit')} value={quota.cap} />
        </dl>
      </header>

      <nav
        className="mt-8 flex flex-wrap items-center gap-2"
        aria-label={t('scopeFilterLabel')}
      >
        {(['draft', 'published', 'deleted'] as ScopeFilter[]).map((s) => {
          const active = s === scope;
          const count = counts[s];
          return (
            <Link
              key={s}
              href={s === 'draft' ? '/store/builder' : `/store/builder?scope=${s}`}
              className={cn(
                'inline-flex items-center gap-2 rounded-full px-4 py-2',
                'text-[12px] font-semibold transition-colors duration-[140ms]',
                'ease-[cubic-bezier(0.22,0.61,0.36,1)]',
                active
                  ? 'bg-[color:var(--accent)] text-[color:var(--fg-on-dark)] shadow-[var(--shadow-cta)]'
                  : 'bg-[color:var(--bg-soft)] text-[color:var(--fg-muted)] hover:bg-[color:var(--gray-100)] hover:text-[color:var(--fg-strong)]',
              )}
              aria-current={active ? 'page' : undefined}
            >
              <span>{scopeLabel[s]}</span>
              <span
                className={cn(
                  'font-mono-num tabular-nums rounded-full px-2 text-[10px]',
                  active
                    ? 'text-[color:var(--accent-fg)]'
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

      <footer className="mt-20 flex items-center justify-between border-t border-[color:var(--divider)] pt-4 text-[11px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
        <span>
          {t('footer.phaseLabel')}{' '}
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

async function EmptyState({ scope }: { scope: ScopeFilter }): Promise<React.ReactElement> {
  const t = await getTranslations('builder.drafts.list');
  const headline =
    scope === 'draft'
      ? t('empty.draft.headline')
      : scope === 'published'
        ? t('empty.published.headline')
        : t('empty.deleted.headline');
  const hint =
    scope === 'draft'
      ? t('empty.draft.hint')
      : scope === 'published'
        ? t('empty.published.hint')
        : t('empty.deleted.hint');
  return (
    <div className="rounded-lg border border-dashed border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] p-12 text-center">
      <p className="font-display text-[22px] text-[color:var(--fg-strong)]">{headline}</p>
      <p className="mt-3 text-sm leading-relaxed text-[color:var(--fg-muted)]">{hint}</p>
    </div>
  );
}

async function LoadErrorState({ message }: { message: string }): Promise<React.ReactElement> {
  const t = await getTranslations('builder.drafts.list');
  return (
    <div className="rounded-lg border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/6 p-8">
      <div className="flex items-baseline gap-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[color:var(--danger)]">
        <span>{t('error.label')}</span>
        <span className="h-px flex-1 bg-[color:var(--danger)]/30" />
      </div>
      <p className="font-display mt-4 text-[26px] text-[color:var(--danger)]">
        {t('error.loadFailed')}
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
