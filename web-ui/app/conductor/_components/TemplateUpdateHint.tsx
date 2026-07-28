'use client';

import { useTranslations } from 'next-intl';

import type { ConductorWorkflowTemplateHint } from '@/app/_lib/api';

/**
 * Opt-in template update path (#478 F3): a workflow instantiated from a template
 * whose catalog manifest moved past the instantiated version gets this hint on
 * its list row. Copy-not-reference stands — nothing propagates automatically;
 * the single action opens the instantiate form PINNED to the latest version, so
 * re-instantiation is a deliberate, reviewable act that creates a NEW workflow
 * (new slug) and leaves this one untouched.
 *
 * Lume: the update signal is warning-colored TEXT only (no filled alert box);
 * the action is a plain text button with the same warning color — state as
 * text/edge, never fills.
 */
export function TemplateUpdateHint({
  hint,
  onReinstantiate,
}: {
  hint: ConductorWorkflowTemplateHint;
  onReinstantiate: (templateId: string, version: number) => void;
}): React.JSX.Element | null {
  const t = useTranslations('conductor');
  if (!hint.updateAvailable) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[12px] text-[color:var(--warning)]">
      <span>{t('templateUpdateHint', { version: hint.version, latestVersion: hint.latestVersion })}</span>
      <button
        type="button"
        className="cursor-pointer underline underline-offset-2 hover:text-[color:var(--fg-strong)]"
        onClick={() => onReinstantiate(hint.id, hint.latestVersion)}
      >
        {t('templateReinstantiateButton', { version: hint.latestVersion })}
      </button>
    </div>
  );
}
