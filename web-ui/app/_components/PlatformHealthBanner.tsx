'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Database, KeyRound, PlugZap } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from './ui/Button';
import { cn } from '../_lib/cn';
import type { PlatformNotice } from '../_lib/platformHealth';

/**
 * Shared platform banner for the pages an operator opens first — the
 * dashboard and `/admin` (#1332, #1384). The state is decided server-side
 * (`platformNotice` in `_lib/platformHealth.ts`) from the middleware's own
 * `/health`; this component only renders it.
 *
 * - `databaseUnreachable` — the API is up, Postgres is not. Named as such, so
 *   the operator stops looking at the middleware and the update page.
 * - `middlewareUnreachable` — `/health` itself did not answer.
 * - `devMasterKey` — the vault and/or keychain master key is read from the dev
 *   file next to the data it encrypts. Used to be visible on `/system` only.
 *
 * Every variant links to `/system`, the page that shows the full picture.
 * Only the dev-key warning can be dismissed, and only for the page view: it
 * is a posture problem the operator may knowingly accept on a local stack,
 * the outages are not something to wave away.
 */
export function PlatformHealthBanner({
  notice,
}: {
  notice: PlatformNotice | null;
}): React.ReactElement | null {
  const t = useTranslations('platformHealth.banner');
  const [dismissed, setDismissed] = useState(false);
  if (notice === null || dismissed) return null;

  const outage = notice.kind !== 'devMasterKey';
  const Icon =
    notice.kind === 'databaseUnreachable'
      ? Database
      : notice.kind === 'middlewareUnreachable'
        ? PlugZap
        : KeyRound;
  const body =
    notice.kind === 'devMasterKey'
      ? t('devMasterKey.body', { which: notice.which })
      : t(`${notice.kind}.body`);

  return (
    <div
      role={outage ? 'alert' : 'status'}
      data-testid="platform-health-banner"
      data-kind={notice.kind}
      className={cn(
        'mb-8 flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start',
        outage
          ? 'border-[color:var(--danger)]/40 bg-[color:var(--danger)]/5'
          : 'border-[color:var(--warning)]/40 bg-[color:var(--warning)]/5',
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 size-5 shrink-0',
          outage ? 'text-[color:var(--danger)]' : 'text-[color:var(--warning)]',
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold text-[color:var(--fg-strong)]">
          {t(`${notice.kind}.title`)}
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--fg-muted)]">
          {body}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Link
          href="/system"
          className="inline-flex items-center gap-1 text-[12px] font-semibold uppercase tracking-[0.14em] text-[color:var(--accent)] hover:underline"
        >
          {t('cta')}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
        {outage ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setDismissed(true);
            }}
          >
            {t('dismiss')}
          </Button>
        )}
      </div>
    </div>
  );
}
