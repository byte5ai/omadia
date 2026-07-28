'use client';

import { useTranslations } from 'next-intl';

/**
 * Epic #470 W0 — branch-protection verdict rows (UI spec §3, step 3). Text-only
 * verdicts in `font-mono`: enabled `--success`, missing `--danger` with a
 * full-sentence warning, unknown `--fg-subtle`. A `--danger` verdict warns
 * loudly but never blocks Finish — it is a documented setup assumption.
 */

export function ProtectionCheckList({
  branch,
  ok,
}: {
  branch: string;
  /** true = protected, false = missing, null = could not verify. */
  ok: boolean | null;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.wizard.checks');
  return (
    <div className="flex flex-col gap-2">
      <div className="font-mono text-xs">
        <span className="text-[color:var(--fg-muted)]">{t('label', { branch })} — </span>
        {ok === true ? <span className="text-[color:var(--success)]">{t('enabled')}</span> : null}
        {ok === false ? <span className="text-[color:var(--danger)]">{t('missing')}</span> : null}
        {ok === null ? <span className="text-[color:var(--fg-subtle)]">{t('unknown')}</span> : null}
      </div>
      {ok === false ? (
        <p className="text-sm text-[color:var(--fg)]">{t('warning', { branch })}</p>
      ) : null}
      {ok === null ? <p className="text-sm text-[color:var(--fg-muted)]">{t('unknownHint')}</p> : null}
    </div>
  );
}
