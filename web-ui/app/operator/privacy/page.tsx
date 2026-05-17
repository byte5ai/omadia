import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import {
  getOperatorPrivacyState,
  type OperatorPrivacyState,
} from '../../_lib/api';
import { redirectIfUnauthorized } from '../../_lib/authRedirect';
import { PrivacyOperatorDashboard } from './_components/PrivacyOperatorDashboard';

/**
 * Privacy-Shield v2 — Slice S-7 — Operator UI.
 *
 * Read + edit surface for the privacy shield's runtime state.
 * Sections (v0.2.0):
 *   1. Config overview (egress mode + active detectors + override-
 *      persistence note)
 *   2. Tenant-Self-Preview (read-only)
 *   3. Repo-Default browser (read-only, searchable)
 *   4. Operator-Override CRUD (textarea ← runtime-only persistence)
 *   5. Live-Test sandbox (run detector + allowlist on a snippet, see
 *      tokenisation + which terms passed the allowlist)
 *
 * Section "Recent-Hits-Audit" is deferred to v0.2.x — requires a new
 * receipt-persistence layer (see Notion ticket "Privacy-Shield v2.x:
 * Receipt-Persistence + Recent-Hits-Audit-UI").
 */

export const metadata: Metadata = {
  title: 'Privacy Operator · Omadia',
};

export const dynamic = 'force-dynamic';

export default async function PrivacyOperatorPage(): Promise<React.ReactElement> {
  const t = await getTranslations('privacyOperator');
  let initialState: OperatorPrivacyState | null = null;
  let loadError: string | null = null;
  try {
    initialState = await getOperatorPrivacyState();
  } catch (err) {
    await redirectIfUnauthorized(err);
    loadError =
      err instanceof Error
        ? err.message
        : t('errorLoadingState');
  }

  return (
    <main className="mx-auto w-full max-w-[1600px] px-6 py-12 lg:px-10 lg:py-16">
      <header className="b5-hero-bg relative -mx-6 rounded-[22px] border border-[color:var(--divider)] px-6 py-10 lg:-mx-10 lg:px-10 lg:py-14">
        <div className="flex items-baseline gap-3 text-[12px] font-semibold uppercase tracking-[0.24em] text-[color:var(--accent)]">
          <span className="font-mono-num text-[color:var(--fg-subtle)]">
            06
          </span>
          <span className="h-px flex-1 bg-[color:var(--border)]" />
          <span>{t('eyebrow')}</span>
        </div>

        <h1 className="font-display mt-6 text-[clamp(2.25rem,4.5vw,3.75rem)] leading-[1.05] text-[color:var(--fg-strong)]">
          {t('heroTitle')}
        </h1>

        <p className="mt-6 max-w-2xl text-[18px] font-semibold leading-[1.55] text-[color:var(--fg-muted)]">
          <span className="text-[color:var(--highlight)] font-[900]">:</span>{' '}
          {t('heroLede')}
        </p>
      </header>

      <section className="mt-12">
        {loadError ? (
          <div className="rounded-[18px] border border-[color:var(--divider)] bg-[color:var(--bg-elevated)] p-6 text-[15px] text-[color:var(--fg)]">
            <p className="font-semibold text-[color:var(--accent-warning,#cc6600)]">
              {t('errorLoadingState')}
            </p>
            <p className="mt-2 text-[color:var(--fg-muted)]">{loadError}</p>
          </div>
        ) : initialState ? (
          <PrivacyOperatorDashboard initialState={initialState} />
        ) : null}
      </section>
    </main>
  );
}
