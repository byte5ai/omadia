'use client';

import Link from 'next/link';
import { Check, KeyRound, MessageSquare, Plug, Sparkles } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import type { PluginKind, PluginReadiness } from '../../_lib/storeTypes';

interface PostInstallNextStepsProps {
  pluginName: string;
  /** OM-16 — when the freshly-installed plugin still needs credentials, the
   *  setup link is the FIRST thing offered and carries the missing count.
   *  #884 — `awaiting_llm` is the same idea one level out: nothing is left to
   *  fill in on this plugin's own form, so the CTA points at the providers
   *  admin page instead of the anchor. */
  readiness?: PluginReadiness;
  /** #1492 — how the plugin is used decides what "next" means. */
  kind?: PluginKind;
  /** #1492 — orchestrators this plugin is enabled on. `null` = unknown. */
  attachedTo?: string[] | null;
}

const LINK_CLASS =
  'inline-flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--accent)] transition-colors hover:underline';

/** Kinds an operator attaches to an orchestrator. Integrations are used through
 *  the agents that depend on them; channels and extensions are neither. */
const ATTACHABLE: ReadonlySet<PluginKind> = new Set<PluginKind>(['agent', 'tool']);

/**
 * OM-06 / OM-07 — "installed" is not a destination: confirm what happened,
 * then name the concrete next step.
 *
 * #1496 — but only for a plugin that is actually RUNNING. An errored plugin
 * used to get a green check and "Try it in chat" directly under the red
 * "Activation failed" pill; the cause is rendered above this block
 * (`ActivationFailureNotice`, the connection banner), so here it renders
 * nothing. A plugin that still needs setup gets the setup step, not a check.
 *
 * #1492 — and the hint fits the plugin. It used to tell every plugin, built-ins
 * already attached since first boot included, to "attach it to an
 * orchestrator", and to try integrations and extensions in chat.
 */
export function PostInstallNextSteps({
  pluginName,
  readiness,
  kind,
  attachedTo,
}: PostInstallNextStepsProps): React.ReactElement | null {
  const t = useTranslations('store.install');
  const format = useFormatter();
  const state = readiness?.state;

  if (state === 'errored' || state === 'connection_failed') return null;

  if (state === 'config_required' || state === 'awaiting_llm') {
    const needsSetup = state === 'config_required';
    return (
      <div className="rounded-md border border-dashed border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] px-4 py-3">
        <p className="text-[13px] text-[color:var(--fg)]">
          {needsSetup ? t('nextSetup', { name: pluginName }) : t('nextLlm', { name: pluginName })}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
          {needsSetup ? (
            <a href="#setup-fields" className={LINK_CLASS}>
              <KeyRound className="size-3.5" aria-hidden />
              {t('toSetup', { count: readiness?.missing_fields.length ?? 0 })}
            </a>
          ) : (
            <Link href="/admin/providers" className={LINK_CLASS}>
              <Sparkles className="size-3.5" aria-hidden />
              {t('toLlmProvider')}
            </Link>
          )}
        </div>
      </div>
    );
  }

  // Running (or a pre-OM-16 middleware that sends no readiness at all).
  // An unknown kind keeps the original attach-and-try hint.
  const attachable = kind === undefined || ATTACHABLE.has(kind);
  const attached = attachable && attachedTo && attachedTo.length > 0 ? attachedTo : null;
  const message = !attachable
    ? kind === 'integration'
      ? t('nextIntegration', { name: pluginName })
      : t('nextRunning', { name: pluginName })
    : attached
      ? t('nextAttached', { name: pluginName, agents: format.list(attached) })
      : t('installedNext', { name: pluginName });

  return (
    <div className="rounded-md border border-dashed border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] px-4 py-3">
      <p className="flex items-start gap-2 text-[13px] text-[color:var(--fg)]">
        <Check
          className="mt-0.5 size-4 shrink-0 text-[color:var(--success)]"
          aria-hidden
        />
        {message}
      </p>
      {attachable ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
          <Link href="/operator/agents" className={LINK_CLASS}>
            <Plug className="size-3.5" aria-hidden />
            {attached ? t('toManageOrchestrators') : t('toOrchestrators')}
          </Link>
          <Link href="/chat" className={LINK_CLASS}>
            <MessageSquare className="size-3.5" aria-hidden />
            {t('toChat')}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
