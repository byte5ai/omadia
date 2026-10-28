'use client';

import { useTranslations } from 'next-intl';

import {
  ACTIVATION_ERROR_CODES,
  activationErrorCopyKey,
  type ActivationErrorCode,
} from '../../_lib/activationError';
import type { ActivationErrorReason } from '../../_lib/storeTypes';

/**
 * #1456 — the one place a failed activation is explained to an operator.
 *
 * What it replaces: `t('activationFailed', { message })`, which prefixed a
 * German half-sentence onto the plugin API's English exception text. The
 * reader got advice meant for a plugin author ("add '…@<major>' to the
 * manifest's `requires:` list") and nothing they could act on.
 *
 * Shape follows the Teams-identity error panel, which solved the same problem
 * for provisioning failures: a localized `what` line keyed on the CODE, a
 * `next` line saying what the operator can do, the code's own arguments (the
 * field to fill, the capabilities waited for), and the raw sentence last, as a
 * technical detail. The sentence is never the headline — but it is never
 * dropped either: it is all a failure recorded by an older build has, and it is
 * what the operator forwards to whoever supplies the plugin.
 */

const KNOWN: ReadonlySet<string> = new Set(ACTIVATION_ERROR_CODES);

export function ActivationFailureNotice({
  reason,
  detail,
  className,
}: {
  /** Classified reason, or `null` when the middleware sent none. */
  reason: ActivationErrorReason | null;
  /** The raw activation sentence, when there is one. */
  detail?: string | undefined;
  className?: string;
}): React.ReactElement | null {
  const t = useTranslations('store.activationError');

  // Nothing to say at all — render nothing rather than an empty red box.
  if (!reason && (detail ?? '') === '') return null;

  // An unknown code degrades to the `unknown` copy, which exists for exactly
  // this: a middleware newer than this build, and a failure recorded before
  // the classification existed.
  const code: ActivationErrorCode =
    reason && KNOWN.has(reason.code)
      ? (reason.code as ActivationErrorCode)
      : 'unknown';
  const key = activationErrorCopyKey(code);

  return (
    <div
      className={`flex flex-col gap-1 text-[12px] ${className ?? ''}`}
      data-testid="activation-failure"
      data-activation-error-code={code}
    >
      <p className="text-[color:var(--danger,#b03030)]">{t(`${key}.what`)}</p>
      <p className="text-[color:var(--fg)]">{t(`${key}.next`)}</p>
      {code === 'secret_missing' || code === 'config_missing' ? (
        reason?.field ? (
          <p className="font-mono-num text-[11px] text-[color:var(--fg-muted)]">
            {t(`${key}.field`, { field: reason.field })}
          </p>
        ) : null
      ) : null}
      {code === 'dependency_unresolved' && (reason?.requires?.length ?? 0) > 0 ? (
        <p className="font-mono-num text-[11px] text-[color:var(--fg-muted)]">
          {t(`${key}.requires`, { requires: (reason?.requires ?? []).join(', ') })}
        </p>
      ) : null}
      {code === 'provider_conflict' && reason?.conflicting_plugin_id ? (
        <p className="font-mono-num text-[11px] text-[color:var(--fg-muted)]">
          {t(`${key}.conflictsWith`, { plugin: reason.conflicting_plugin_id })}
        </p>
      ) : null}
      {(detail ?? '') !== '' ? (
        <p className="font-mono-num text-[11px] text-[color:var(--fg-subtle)]">
          {t('technicalDetail', { raw: detail ?? '' })}
        </p>
      ) : null}
    </div>
  );
}
