import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { parseActivationErrorCode } from '../../_lib/activationError';
import { cn } from '../../_lib/cn';

interface ActivationFailureNoticeProps {
  /** `readiness.error_code` / `activation.error_code`; anything unrecognised
   *  (or absent, on an older middleware) renders the `unknown` copy. */
  code: unknown;
  /** The raw activation message. Developer text — shown collapsed as a
   *  technical detail, never as the headline. */
  detail?: string | null;
  /** Optional lead-in naming what just happened ("Updated, but …"). */
  lead?: string;
  className?: string;
}

/**
 * #1456 — why a plugin did not start, in the operator's language.
 *
 * The store used to interpolate the plugin API's exception message into a
 * translated prefix, so the German UI read "Installiert, aber das Plugin ist
 * nicht gestartet: plugin '…' called ctx.services.get('entityRefBus') but its
 * manifest does not declare that capability — add …". This renders what went
 * wrong and what the operator can do about it, per code, and demotes the raw
 * sentence to a collapsed technical detail.
 *
 * Deliberately no `'use client'`: `StateBadge` renders on the server and uses
 * {@link useActivationErrorLabel}, and nothing here needs the browser.
 */
export function ActivationFailureNotice({
  code,
  detail,
  lead,
  className,
}: ActivationFailureNoticeProps): React.ReactElement {
  const t = useTranslations('store.activationError');
  const key = parseActivationErrorCode(code);
  return (
    <div
      role="alert"
      className={cn(
        'rounded-md border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/5 px-4 py-3 text-[12px] text-[color:var(--fg)]',
        className,
      )}
    >
      <p className="flex items-start gap-2 font-semibold text-[color:var(--danger,#b03030)]">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          {lead ? `${lead} ` : null}
          {t(`${key}.what`)}
        </span>
      </p>
      <p className="mt-1 pl-6 leading-relaxed">{t(`${key}.next`)}</p>
      {detail ? (
        <details className="mt-2 pl-6 text-[11px] text-[color:var(--fg-muted)]">
          <summary className="cursor-pointer select-none">{t('technicalDetail')}</summary>
          <p className="font-mono-num mt-1 break-words">{detail}</p>
        </details>
      ) : null}
    </div>
  );
}

/** The short, localized label for a code — for `title=` attributes, where the
 *  raw tail used to leak English exception text into the German UI. */
export function useActivationErrorLabel(): (code: unknown) => string {
  const t = useTranslations('store.activationError');
  return (code: unknown) => t(`${parseActivationErrorCode(code)}.what`);
}
