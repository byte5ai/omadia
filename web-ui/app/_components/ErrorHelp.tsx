'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { resolveErrorHelp } from '../_lib/errorHelp';
import { supportDetail } from '../_lib/scanFailure';

interface ErrorHelpProps {
  /** The middleware's machine code, typically `ApiError.code`. */
  code: string | null;
  /**
   * The thrown value. Rendered ONLY inside the support disclosure, and only
   * after `supportDetail()` has redacted provider internals and capped the
   * length. Never the headline.
   */
  rawDetail?: unknown;
  /**
   * What to show as the headline when the code resolves to nothing. Two
   * legitimate sources: a server string that is all an older middleware sent
   * (a provider's `verifyError`), or the caller's own localized line for the
   * operation that failed, which beats the generic one whenever the caller
   * knows what it was doing. Leave it undefined and the component falls back
   * to its own localized "that failed" line.
   */
  fallback?: string;
}

/**
 * OM-09 — render an error the operator can act on.
 *
 * Two lines: what happened, and the one thing to do about it. Both come from
 * `messages/*.json` via {@link resolveErrorHelp}, so a German operator reads
 * German. The server's own text is never the headline; it sits behind a
 * collapsed disclosure aimed at a support thread, redacted on the way in.
 *
 * Lume: text and edge colours only. No filled state block, no spinner.
 */
export function ErrorHelp({
  code,
  rawDetail,
  fallback,
}: ErrorHelpProps): React.ReactElement | null {
  const t = useTranslations();
  const tUi = useTranslations('errorHelpUi');
  const help = resolveErrorHelp(code, t);
  const detail =
    rawDetail === undefined || rawDetail === null
      ? undefined
      : supportDetail(rawDetail);

  // Nothing to say and nothing to disclose: render nothing rather than an
  // empty red box. The caller's condition decided this row should exist.
  if (!help && fallback === undefined && detail === undefined) return null;

  const headline = help?.what ?? fallback ?? tUi('unknownFailure');

  return (
    <div className="flex flex-col gap-1 text-[12px] text-[color:var(--danger)]">
      <p>{headline}</p>
      {help ? (
        <p className="text-[color:var(--fg-muted)]">
          {help.next}
          {help.actionHref !== undefined && code !== null ? (
            <>
              {' '}
              <Link
                href={help.actionHref}
                className="underline underline-offset-2 text-[color:var(--accent)]"
              >
                {t(`errorHelp.${code}.action`)}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      {detail !== undefined && detail.length > 0 ? (
        <details className="text-[color:var(--fg-muted)]">
          <summary className="cursor-pointer">{tUi('supportDetails')}</summary>
          <pre className="mt-1 whitespace-pre-wrap break-all border-l border-[color:var(--border)] pl-2">
            {detail}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
