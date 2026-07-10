'use client';

import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { resolveConductorText } from '@/app/_lib/api';
import type { ConductorTemplate, ConductorTemplateSlots } from '@/app/_lib/api';

/**
 * Workflow-template gallery (#429): the curated catalog rendered as a card grid on
 * /conductor. Purely presentational — the page fetches the catalog and owns what
 * happens on "Use template" (the slot-mapping flow).
 *
 * Each card answers "what problem does this solve and what will I need to map"
 * before commit: name + use-case tag, description, a "you will map: …" slot
 * summary, and a schedule badge for cron-triggered templates (schedule
 * transparency starts at the card). Lume: state colors are text/edge only —
 * the tag and badge are bordered text, never filled pills.
 */

/** Render order + per-kind plural i18n key for the "you will map" summary. */
const SLOT_SUMMARY_KINDS: ReadonlyArray<readonly [keyof ConductorTemplateSlots, string]> = [
  ['roles', 'templateSlotRoles'],
  ['agents', 'templateSlotAgents'],
  ['actions', 'templateSlotActions'],
  ['events', 'templateSlotEvents'],
  ['channels', 'templateSlotChannels'],
];

export interface TemplateGalleryProps {
  templates: ConductorTemplate[];
  onUseTemplate: (template: ConductorTemplate) => void;
}

export function TemplateGallery({ templates, onUseTemplate }: TemplateGalleryProps): React.JSX.Element | null {
  const t = useTranslations('conductor');
  // Template metadata is localized in the manifest itself ({ en, de?, … } or a plain
  // string) — resolve against the active locale here, en as fallback.
  const locale = useLocale();

  // Empty catalog → render nothing (no empty-state noise).
  if (templates.length === 0) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {templates.map((tpl) => {
        const scheduled = (tpl.graph.triggers ?? []).some((trigger) => trigger.kind === 'cron');
        const mappingSummary = SLOT_SUMMARY_KINDS.map(([kind, key]) => {
          const count = tpl.slots[kind]?.length ?? 0;
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
              <h3 className="text-[15px] font-medium text-[color:var(--fg-strong)]">{resolveConductorText(tpl.name, locale)}</h3>
              <span className="rounded-full border border-[color:var(--border)] px-2 py-0.5 text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
                {resolveConductorText(tpl.useCase, locale)}
              </span>
              {scheduled && (
                <span className="rounded-full border border-[color:var(--accent)] px-2 py-0.5 text-[11px] text-[color:var(--accent)]">
                  {t('templateScheduleBadge')}
                </span>
              )}
            </div>
            <p className="line-clamp-3 text-[13px] leading-[1.55] text-[color:var(--fg-muted)]">
              {resolveConductorText(tpl.description, locale)}
            </p>
            <div className="mt-auto flex items-center justify-between gap-3">
              <span className="text-[12px] text-[color:var(--fg-muted)]">
                {mappingSummary ? t('templateMappingSummary', { summary: mappingSummary }) : null}
              </span>
              <Button variant="primary" size="sm" className="shrink-0" onClick={() => onUseTemplate(tpl)}>
                {t('templateUseButton')}
              </Button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
