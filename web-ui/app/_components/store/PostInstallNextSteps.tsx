'use client';

import Link from 'next/link';
import { Check, KeyRound, MessageSquare, Plug, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { PluginReadiness } from '../../_lib/storeTypes';

interface PostInstallNextStepsProps {
  pluginName: string;
  /** OM-16 — when the freshly-installed plugin still needs credentials, the
   *  setup link is the FIRST thing offered and carries the missing count.
   *  #884 — `awaiting_llm` is the same idea one level out: nothing is left to
   *  fill in on this plugin's own form, so the CTA points at the providers
   *  admin page instead of the anchor. */
  readiness?: PluginReadiness;
}

const LINK_CLASS =
  'inline-flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--accent)] transition-colors hover:underline';

/**
 * OM-06 / OM-07 — "installed" is not a destination.
 *
 * Installing a plugin used to end at a green "Installiert · AKTIV" pill with no
 * indication that the plugin does nothing until it is attached to an
 * orchestrator. This mirrors the skill-import success flow
 * (`DashboardOnboarding.tsx` → `BringYourSkills`), which already gets this
 * right: confirm what happened, then name the concrete next step and offer the
 * destinations.
 */
export function PostInstallNextSteps({
  pluginName,
  readiness,
}: PostInstallNextStepsProps): React.ReactElement {
  const t = useTranslations('store.install');
  const needsSetup = readiness?.state === 'config_required';
  const needsLlmProvider = readiness?.state === 'awaiting_llm';
  const missingCount = readiness?.missing_fields.length ?? 0;

  return (
    <div className="rounded-md border border-dashed border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] px-4 py-3">
      <p className="flex items-start gap-2 text-[13px] text-[color:var(--fg)]">
        <Check
          className="mt-0.5 size-4 shrink-0 text-[color:var(--success)]"
          aria-hidden
        />
        {t('installedNext', { name: pluginName })}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        {needsSetup ? (
          <a href="#setup-fields" className={LINK_CLASS}>
            <KeyRound className="size-3.5" aria-hidden />
            {t('toSetup', { count: missingCount })}
          </a>
        ) : null}
        {needsLlmProvider ? (
          <Link href="/admin/providers" className={LINK_CLASS}>
            <Sparkles className="size-3.5" aria-hidden />
            {t('toLlmProvider')}
          </Link>
        ) : null}
        <Link href="/operator/agents" className={LINK_CLASS}>
          <Plug className="size-3.5" aria-hidden />
          {t('toOrchestrators')}
        </Link>
        <Link href="/chat" className={LINK_CLASS}>
          <MessageSquare className="size-3.5" aria-hidden />
          {t('toChat')}
        </Link>
      </div>
    </div>
  );
}
