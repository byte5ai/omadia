'use client';

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  ApiError,
  approveConductorTemplate,
  deleteConductorTemplate,
  rejectConductorTemplate,
  resolveConductorText,
  submitConductorTemplate,
} from '@/app/_lib/api';
import type { ConductorTemplate, ConductorTemplateSlots } from '@/app/_lib/api';

/**
 * Workflow-template gallery (#429, extended for #478): the composite catalog
 * (bundled + user + plugin templates) rendered as a card grid on /conductor.
 *
 * v2 additions (#478 F2):
 *  - provenance facets (All / Bundled / My templates / Shared / Plugins /
 *    Pending review) — client-side filtering over the catalog's `source` /
 *    `status` / `createdBy` fields; "Pending review" is the reviewer queue,
 *    populated for EVERY operator because the backend's visibility rule makes
 *    pending templates install-wide (the review gate must be reachable by
 *    non-author reviewers).
 *  - text search + use-case chips (substring over the locale-resolved
 *    name/description/useCase — no search infra below ~50 templates).
 *  - per-card provenance badge, `v{n}` tag, instantiation count, and manage
 *    actions: author-only Submit for review (private) / Delete (confirm),
 *    plus Approve/Reject on pending cards for ALL operators — directly on the
 *    card, never buried in an own-templates-only menu.
 *
 * Mutations call the API here and then signal `onCatalogChanged` so the page
 * refetches the catalog (the card moves facets on refresh). Errors surface
 * inline as text (this operator UI has no toast plumbing — same pattern as the
 * instantiate form), with the server error message. Lume: state colors are
 * text/edge only — every badge is bordered text, never a filled pill; busy
 * buttons are verb + animated dots.
 */

/** Render order + per-kind plural i18n key for the "you will map" summary. */
const SLOT_SUMMARY_KINDS: ReadonlyArray<readonly [keyof ConductorTemplateSlots, string]> = [
  ['roles', 'templateSlotRoles'],
  ['agents', 'templateSlotAgents'],
  ['actions', 'templateSlotActions'],
  ['events', 'templateSlotEvents'],
  ['channels', 'templateSlotChannels'],
];

type Facet = 'all' | 'bundled' | 'mine' | 'shared' | 'plugins' | 'pending';

const FACETS: ReadonlyArray<readonly [Facet, string]> = [
  ['all', 'templateFacetAll'],
  ['bundled', 'templateFacetBundled'],
  ['mine', 'templateFacetMine'],
  ['shared', 'templateFacetShared'],
  ['plugins', 'templateFacetPlugins'],
  ['pending', 'templateFacetPending'],
];

/** Missing `source` = a v1-era bundled manifest (the composite catalog always
 *  stamps one; only pre-#478 fixtures/payloads omit it). */
function sourceOf(tpl: ConductorTemplate): 'bundled' | 'user' | 'plugin' {
  return tpl.source ?? 'bundled';
}

/** Ownership: `createdBy === viewer` when both sides are known; a visible
 *  PRIVATE template is the viewer's own by the backend visibility rule
 *  (shared OR own OR pending), which covers the viewer-identity-unknown case. */
function isOwn(tpl: ConductorTemplate, viewer: string | null): boolean {
  if (sourceOf(tpl) !== 'user') return false;
  if (viewer !== null && tpl.createdBy !== undefined) return tpl.createdBy === viewer;
  return tpl.status === 'private';
}

function matchesFacet(tpl: ConductorTemplate, facet: Facet, viewer: string | null): boolean {
  const source = sourceOf(tpl);
  switch (facet) {
    case 'all':
      return true;
    case 'bundled':
      return source === 'bundled';
    case 'mine':
      return isOwn(tpl, viewer);
    case 'shared':
      return source === 'user' && tpl.status === 'shared';
    case 'plugins':
      return source === 'plugin';
    case 'pending':
      return source === 'user' && tpl.status === 'pending';
  }
}

/** Provenance badge: user templates surface their review status (pending /
 *  shared / mine-private — a visible private template is always the viewer's
 *  own); bundled and plugin their source. Text + edge only, never a fill. */
function badgeFor(tpl: ConductorTemplate): { key: string; className: string } {
  const source = sourceOf(tpl);
  if (source === 'user') {
    if (tpl.status === 'pending') {
      return { key: 'templateBadgePending', className: 'border-[color:var(--warning)] text-[color:var(--warning)]' };
    }
    if (tpl.status === 'shared') {
      return { key: 'templateBadgeShared', className: 'border-[color:var(--success)] text-[color:var(--success)]' };
    }
    return { key: 'templateBadgeMine', className: 'border-[color:var(--accent)] text-[color:var(--accent)]' };
  }
  if (source === 'plugin') {
    return { key: 'templateBadgePlugin', className: 'border-[color:var(--border-strong)] text-[color:var(--fg-muted)]' };
  }
  return { key: 'templateBadgeBundled', className: 'border-[color:var(--border-strong)] text-[color:var(--fg-muted)]' };
}

/** Wire shape of the template error envelopes (parsed out of ApiError.body). */
function serverErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const parsed: unknown = JSON.parse(err.body);
      if (typeof parsed === 'object' && parsed !== null) {
        const message = (parsed as { message?: unknown }).message;
        if (typeof message === 'string' && message) return message;
      }
    } catch {
      /* non-JSON body → fall through to err.message */
    }
    return err.message;
  }
  return String(err);
}

const BADGE_BASE = 'rounded-full border px-2 py-0.5 text-[11px]';
const CHIP_BASE =
  'rounded-full border px-3 py-1 text-[12px] font-medium transition-colors ' +
  'ease-[cubic-bezier(0.22,0.61,0.36,1)] duration-[140ms]';

type PendingAction = { id: string; kind: 'submit' | 'delete' | 'approve' | 'reject' };

export interface TemplateGalleryProps {
  templates: ConductorTemplate[];
  onUseTemplate: (template: ConductorTemplate) => void;
  /** backend viewer identity (AuthUser.id = session sub); null while unknown —
   *  "My templates" and non-private manage actions then stay conservative. */
  viewer?: string | null;
  /** invoked after every successful mutation so the page refetches the catalog. */
  onCatalogChanged?: () => void;
}

export function TemplateGallery({
  templates,
  onUseTemplate,
  viewer = null,
  onCatalogChanged,
}: TemplateGalleryProps): React.JSX.Element | null {
  const t = useTranslations('conductor');
  // Template metadata is localized in the manifest itself ({ en, de?, … } or a plain
  // string) — resolve against the active locale here, en as fallback.
  const locale = useLocale();

  const [facet, setFacet] = useState<Facet>('all');
  const [query, setQuery] = useState('');
  const [useCaseFilter, setUseCaseFilter] = useState<string | null>(null);
  // One in-flight mutation at a time; delete asks for an inline confirm first.
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const pendingCount = useMemo(
    () => templates.filter((tpl) => matchesFacet(tpl, 'pending', viewer)).length,
    [templates, viewer],
  );

  // Secondary facet: distinct locale-resolved use-case values, catalog-wide.
  const useCases = useMemo(() => {
    const seen = new Set<string>();
    for (const tpl of templates) {
      const resolved = resolveConductorText(tpl.useCase, locale).trim();
      if (resolved) seen.add(resolved);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [templates, locale]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return templates.filter((tpl) => {
      if (!matchesFacet(tpl, facet, viewer)) return false;
      const useCase = resolveConductorText(tpl.useCase, locale).trim();
      if (useCaseFilter !== null && useCase !== useCaseFilter) return false;
      if (!needle) return true;
      return [resolveConductorText(tpl.name, locale), resolveConductorText(tpl.description, locale), useCase].some(
        (text) => text.toLowerCase().includes(needle),
      );
    });
  }, [templates, facet, viewer, query, useCaseFilter, locale]);

  // Empty catalog → render nothing (no empty-state noise; the page hides the
  // whole section too). Filtered-into-emptiness renders an empty-state line.
  if (templates.length === 0) return null;

  const runAction = async (action: PendingAction, fn: () => Promise<unknown>): Promise<void> => {
    if (pendingAction !== null) return;
    setPendingAction(action);
    setActionError(null);
    try {
      await fn();
      setConfirmDeleteId(null);
      onCatalogChanged?.();
    } catch (err) {
      setActionError(t('templateRequestFailed', { message: serverErrorMessage(err) }));
    } finally {
      setPendingAction(null);
    }
  };

  const isBusy = (id: string, kind: PendingAction['kind']): boolean =>
    pendingAction !== null && pendingAction.id === id && pendingAction.kind === kind;

  return (
    <div className="grid gap-3">
      {/* Provenance facets — selection control (not a state color), so the
          active chip may use the accent fill like the store's filter tabs. */}
      <nav className="flex flex-wrap items-center gap-2" aria-label={t('templateFacetAria')}>
        {FACETS.map(([key, labelKey]) => {
          const active = facet === key;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              onClick={() => setFacet(key)}
              className={`${CHIP_BASE} ${
                active
                  ? 'border-[color:var(--accent)] bg-[color:var(--accent)] text-[color:var(--fg-on-dark)]'
                  : 'border-[color:var(--border)] bg-transparent text-[color:var(--fg-muted)] hover:border-[color:var(--border-strong)] hover:text-[color:var(--fg-strong)]'
              }`}
            >
              {t(labelKey)}
              {key === 'pending' && pendingCount > 0 && (
                <span
                  className={`ml-2 rounded-full border px-1.5 font-mono text-[10px] tabular-nums ${
                    active ? 'border-[color:var(--fg-on-dark)]' : 'border-[color:var(--warning)] text-[color:var(--warning)]'
                  }`}
                >
                  {pendingCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          className="w-full max-w-xs rounded-md border border-[color:var(--border)] bg-transparent px-3 py-1.5 text-[13px] text-[color:var(--fg-strong)] placeholder:text-[color:var(--fg-muted)]"
          placeholder={t('templateSearchPlaceholder')}
          aria-label={t('templateSearchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {/* Use-case chips — toggle; clicking the active chip clears the filter. */}
        {useCases.length > 1 && (
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('templateUseCaseAria')}>
            {useCases.map((useCase) => {
              const active = useCaseFilter === useCase;
              return (
                <button
                  key={useCase}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setUseCaseFilter(active ? null : useCase)}
                  className={`${CHIP_BASE} ${
                    active
                      ? 'border-[color:var(--accent)] text-[color:var(--accent)]'
                      : 'border-[color:var(--border)] text-[color:var(--fg-muted)] hover:border-[color:var(--border-strong)]'
                  }`}
                >
                  {useCase}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Mutation errors — inline TEXT (Lume state rule), server message included. */}
      {actionError && <p className="text-[13px] text-[color:var(--danger)]">{actionError}</p>}

      {visible.length === 0 ? (
        <p className="text-[14px] text-[color:var(--fg-muted)]">
          {facet === 'pending' ? t('templatePendingEmpty') : t('templateNoMatches')}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {visible.map((tpl) => {
            const source = sourceOf(tpl);
            const own = isOwn(tpl, viewer);
            const pending = source === 'user' && tpl.status === 'pending';
            const badge = badgeFor(tpl);
            const version = tpl.latestVersion ?? tpl.version ?? 1;
            const scheduled = (tpl.graph.triggers ?? []).some((trigger) => trigger.kind === 'cron');
            const mappingSummary = SLOT_SUMMARY_KINDS.map(([kind, key]) => {
              const slots = tpl.slots[kind];
              const count = slots?.length ?? 0;
              return count > 0 ? t(key, { count }) : null;
            })
              .filter((part): part is string => part !== null)
              .join(' · ');

            return (
              <article
                key={tpl.id}
                className="flex flex-col gap-3 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[15px] font-medium text-[color:var(--fg-strong)]">
                    {resolveConductorText(tpl.name, locale)}
                  </h3>
                  <span className={`${BADGE_BASE} ${badge.className}`}>{t(badge.key)}</span>
                  <span className={`${BADGE_BASE} border-[color:var(--border)] font-mono text-[color:var(--fg-muted)]`}>
                    {t('templateVersionTag', { version })}
                  </span>
                  <span className="rounded-full border border-[color:var(--border)] px-2 py-0.5 text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
                    {resolveConductorText(tpl.useCase, locale)}
                  </span>
                  {scheduled && (
                    <span className={`${BADGE_BASE} border-[color:var(--accent)] text-[color:var(--accent)]`}>
                      {t('templateScheduleBadge')}
                    </span>
                  )}
                </div>
                <p className="line-clamp-3 text-[13px] leading-[1.55] text-[color:var(--fg-muted)]">
                  {resolveConductorText(tpl.description, locale)}
                </p>
                {/* Reviewer context on pending cards: who submitted it. */}
                {pending && (
                  <p className="text-[12px] text-[color:var(--fg-muted)]">
                    {t('templateSubmittedBy', { author: tpl.createdBy ?? '—' })}
                  </p>
                )}
                <div className="mt-auto flex flex-wrap items-center justify-between gap-3">
                  <span className="text-[12px] text-[color:var(--fg-muted)]">
                    {mappingSummary ? t('templateMappingSummary', { summary: mappingSummary }) : null}
                    {mappingSummary && tpl.instantiationCount !== undefined ? ' · ' : null}
                    {tpl.instantiationCount !== undefined
                      ? t('templateUsageCount', { count: tpl.instantiationCount })
                      : null}
                  </span>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                    {/* Review actions — pending cards, EVERY operator (the queue
                        is install-wide; non-author reviewers act right here). */}
                    {pending && (
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          busy={isBusy(tpl.id, 'approve')}
                          busyLabel={t('templateApproving')}
                          disabled={pendingAction !== null}
                          onClick={() => void runAction({ id: tpl.id, kind: 'approve' }, () => approveConductorTemplate(tpl.id))}
                        >
                          {t('approve')}
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          busy={isBusy(tpl.id, 'reject')}
                          busyLabel={t('templateRejecting')}
                          disabled={pendingAction !== null}
                          onClick={() => void runAction({ id: tpl.id, kind: 'reject' }, () => rejectConductorTemplate(tpl.id))}
                        >
                          {t('reject')}
                        </Button>
                      </>
                    )}
                    {/* Author manage actions on own user templates. */}
                    {own && tpl.status === 'private' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        busy={isBusy(tpl.id, 'submit')}
                        busyLabel={t('templateSubmitting')}
                        disabled={pendingAction !== null}
                        onClick={() => void runAction({ id: tpl.id, kind: 'submit' }, () => submitConductorTemplate(tpl.id))}
                      >
                        {t('templateSubmitButton')}
                      </Button>
                    )}
                    {own && confirmDeleteId !== tpl.id && (
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={pendingAction !== null}
                        onClick={() => {
                          setActionError(null);
                          setConfirmDeleteId(tpl.id);
                        }}
                      >
                        {t('templateDeleteButton')}
                      </Button>
                    )}
                    <Button variant="primary" size="sm" className="shrink-0" onClick={() => onUseTemplate(tpl)}>
                      {t('templateUseButton')}
                    </Button>
                  </div>
                </div>
                {/* Inline delete confirm — deliberate second step, no browser dialog. */}
                {own && confirmDeleteId === tpl.id && (
                  <div className="flex flex-wrap items-center gap-2 border-t border-[color:var(--border)] pt-3">
                    <span className="text-[12px] text-[color:var(--danger)]">{t('templateDeleteConfirm')}</span>
                    <Button
                      variant="danger"
                      size="sm"
                      busy={isBusy(tpl.id, 'delete')}
                      busyLabel={t('templateDeleting')}
                      disabled={pendingAction !== null}
                      onClick={() => void runAction({ id: tpl.id, kind: 'delete' }, () => deleteConductorTemplate(tpl.id))}
                    >
                      {t('templateDeleteConfirmButton')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pendingAction !== null}
                      onClick={() => setConfirmDeleteId(null)}
                    >
                      {t('templateCancelButton')}
                    </Button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
