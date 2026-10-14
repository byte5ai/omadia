import Link from 'next/link';
import { Cpu, KeyRound } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { RuntimeReadinessCause } from '../../../_lib/runtimeReadiness';

/**
 * The orchestrator page's empty state for a fresh install.
 *
 * Until an LLM access exists and the orchestrator plugin is assigned to it,
 * the middleware publishes no `orchestratorRegistry@1` and both operator
 * routes this page reads answer their structured 503
 * (`multi_orchestrator_unavailable`). The dashboard links here anyway, and
 * the page used to print the raw `GET /v1/operator/agents failed: 503` lines.
 *
 * That 503 is the expected first-start state, not an outage, so it gets the
 * same cause-specific copy as the readiness card and a link to where the fix
 * is made. Every other failure (transport error, 500, a 503 without the
 * marker) still renders as an error on the page — see `page.tsx`.
 */
export function OrchestratorSetupState({
  cause,
}: {
  cause: RuntimeReadinessCause;
}): React.ReactElement {
  const t = useTranslations('operatorAgents.setup');
  const noAssignment = cause === 'no_assignment';
  const Icon = noAssignment ? Cpu : KeyRound;
  const title = noAssignment
    ? t('titleNoAssignment')
    : cause === 'unknown'
      ? t('titleUnknown')
      : t('titleNoAccess');
  const body = noAssignment
    ? t('bodyNoAssignment')
    : cause === 'unknown'
      ? t('bodyUnknown')
      : t('bodyNoAccess');

  return (
    <section
      data-testid="orchestrator-setup-state"
      data-cause={cause}
      className="border border-[color:var(--rule-strong)] bg-[color:var(--paper)] p-6"
    >
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-[color:var(--accent)]">
        <Icon className="size-3.5" aria-hidden />
        {t('eyebrow')}
      </div>
      <h2 className="mt-3 text-xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[color:var(--fg-muted)]">
        {body}
      </p>
      <Link
        href="/admin/providers"
        className="mt-5 inline-block border border-[color:var(--ink)] bg-[color:var(--ink)] px-4 py-2 text-[11px] uppercase tracking-[0.16em] text-[color:var(--paper)] transition hover:border-[color:var(--accent)] hover:bg-[color:var(--accent)]"
      >
        {noAssignment ? t('ctaNoAssignment') : t('cta')}
      </Link>
    </section>
  );
}
