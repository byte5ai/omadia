'use client';

import { useTranslations } from 'next-intl';

import { ApiError } from '@/app/_lib/api';
import { serverErrorMessage } from '@/app/_lib/apiErrorMessage';

/** Shared styling + error-formatting for the two webhook admin sections — kept
 *  in one place so the endpoints and subscriptions lists (issue #437) stay
 *  visually identical without copy-pasting class strings. */

export const inputCls =
  'w-full rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]';

export const card = 'rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4';

type TFn = (key: string, values?: Record<string, string | number>) => string;

/**
 * The `conductor.*` codes `middleware/src/conductor/webhookRoutes.ts` emits,
 * mapped to keys under `adminWebhooks.errors`. Kept local rather than added to
 * `errorHelp.ts`, whose coverage test scopes that catalogue to a fixed set of
 * route files (same reasoning as `/admin/datasets`). Every `*_failed` code is a
 * server-side failure with nothing for the operator to correct, so they share
 * one line.
 */
const CODE_KEYS: Readonly<Record<string, string>> = {
  'conductor.webhook_url_forbidden': 'urlForbidden',
  'conductor.invalid_input': 'invalidInput',
  'conductor.not_found': 'notFound',
  'conductor.webhooks_unavailable': 'unavailable',
};

/** Which form field an error belongs to, so it can sit next to that field. */
export type WebhookErrorField = 'url';

export interface FriendlyWebhookError {
  /** Localized headline. */
  readonly message: string;
  /** The server's own (English) sentence, as secondary detail; never the body. */
  readonly detail?: string;
  readonly field?: WebhookErrorField;
}

/**
 * #1338 — turn a failed webhook call into something an operator can read.
 * Before, every `ApiError` rendered its raw JSON body. Now: a localized line
 * for each known code, the server's `message` only as detail under it, and a
 * localized "request failed" line with the status for anything else.
 */
export function toFriendlyError(err: unknown, t: TFn): FriendlyWebhookError {
  const detail =
    serverErrorMessage(err) ?? (err instanceof ApiError ? undefined : errorText(err));
  const withDetail = (message: string): FriendlyWebhookError =>
    detail === undefined ? { message } : { message, detail };

  if (err instanceof ApiError) {
    const key = err.code === null ? undefined : CODE_KEYS[err.code];
    if (key !== undefined) {
      const friendly = withDetail(t(`errors.${key}`));
      return err.code === 'conductor.webhook_url_forbidden'
        ? { ...friendly, field: 'url' }
        : friendly;
    }
    if (err.code?.startsWith('conductor.') && err.code.endsWith('_failed')) {
      return withDetail(t('errors.serverFailed'));
    }
    return withDetail(t('errors.requestFailed', { status: err.status }));
  }
  return withDetail(t('errors.unexpected'));
}

function errorText(err: unknown): string | undefined {
  const text = err instanceof Error ? err.message : String(err);
  return text.trim().length > 0 ? text : undefined;
}

/** Renders a {@link FriendlyWebhookError}: headline, then the detail muted. */
export function WebhookError({
  error,
  className = '',
}: {
  error: FriendlyWebhookError;
  className?: string;
}): React.ReactElement {
  return (
    <div className={`flex flex-col gap-0.5 text-sm ${className}`} role="alert">
      <p className="text-[color:var(--danger)]">{error.message}</p>
      {error.detail !== undefined && (
        <p className="text-[12px] text-[color:var(--fg-muted)]">{error.detail}</p>
      )}
    </div>
  );
}

export function StatusBadge({ enabled }: { enabled: boolean }): React.ReactElement {
  const t = useTranslations('adminWebhooks.badge');
  return (
    <span
      className={[
        'inline-flex items-center gap-2 rounded-full px-2 py-0.5 text-[11px] uppercase tracking-[0.16em]',
        enabled
          ? 'bg-[color:var(--success)]/10 text-[color:var(--success)]'
          : 'bg-[color:var(--border)]/40 text-[color:var(--fg-muted)]',
      ].join(' ')}
    >
      {enabled ? t('enabled') : t('disabled')}
    </span>
  );
}
