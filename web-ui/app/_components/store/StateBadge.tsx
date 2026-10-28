import { useFormatter, useTranslations } from 'next-intl';

import type {
  PluginActionStatus,
  PluginInstallState,
  PluginReadiness,
} from '../../_lib/storeTypes';
import { cn } from '../../_lib/cn';
import {
  ACTIVATION_ERROR_CODES,
  parseActivationErrorReason,
  type ActivationErrorCode,
} from '../../_lib/activationError';

interface StateBadgeProps {
  state: PluginInstallState;
  isLegacy?: boolean;
  /**
   * OM-16 — kernel-derived readiness. Orthogonal to `state`: an installed
   * plugin whose credentials were emptied is still `install_state:
   * 'installed'`, and the badge must say so instead of an unqualified green
   * "Installiert". Absent on payloads from a pre-OM-16 middleware, in which
   * case the badge renders exactly as it used to.
   */
  readiness?: PluginReadiness;
  /**
   * #1453 — the plugin's own pushed status. Readiness and this signal are
   * computed independently (`withReadiness` / `withActionStatus` in
   * `routes/store.ts`), so until this prop existed a plugin that reported a
   * refused API key rendered a red "Nicht verbunden" pill NEXT TO an
   * unchanged green badge. The badge is the weaker of the two claims — it only
   * knows that activation happened — so it yields.
   */
  actionStatus?: PluginActionStatus;
  className?: string;
}

/** Message-key leaves under `store.stateBadge` — translated at render. */
const LABEL_KEY: Record<PluginInstallState, string> = {
  available: 'available',
  installed: 'installed',
  'update-available': 'updateAvailable',
  incompatible: 'incompatible',
};

const STYLE: Record<PluginInstallState, string> = {
  available:
    'text-[color:var(--fg)] border-[color:var(--border-strong)] bg-[color:var(--bg-soft)]',
  installed:
    'text-[color:var(--success)] border-[color:var(--success)]/50 bg-[color:var(--success)]/10',
  'update-available':
    'text-[color:var(--accent)] border-[color:var(--accent)]/50 bg-[color:var(--accent)]/10',
  incompatible:
    'text-[color:var(--danger)] border-[color:var(--danger)]/50 bg-[color:var(--danger)]/8',
};

const WARNING_STYLE =
  'text-[color:var(--warning)] border-[color:var(--warning)]/50 bg-[color:var(--warning)]/12';
const DANGER_STYLE =
  'text-[color:var(--danger)] border-[color:var(--danger)]/50 bg-[color:var(--danger)]/8';

const PILL =
  'inline-flex items-center gap-2 rounded-full border px-3 py-0.5 text-[11px] font-medium uppercase tracking-[0.12em]';

const KNOWN_CODES: ReadonlySet<string> = new Set(ACTIVATION_ERROR_CODES);

/**
 * #1456 — the badge's hover text for a failed activation.
 *
 * It used to be `readiness.error_detail`, the plugin API's exception sentence:
 * English in a German UI, and unreachable for keyboard, screen-reader and
 * touch users anyway. It is now the one-line localized summary of the
 * classified reason. The full explanation is not hidden in a tooltip at all —
 * it is rendered as text on the plugin page.
 */
function erroredTitle(
  readiness: PluginReadiness,
  t: (key: string) => string,
): string {
  const reason = parseActivationErrorReason(readiness.error_reason);
  const code: ActivationErrorCode =
    reason && KNOWN_CODES.has(reason.code)
      ? (reason.code as ActivationErrorCode)
      : 'unknown';
  return t(`${code}.short`);
}

export function StateBadge({
  state,
  isLegacy,
  readiness,
  actionStatus,
  className,
}: StateBadgeProps): React.ReactElement {
  const t = useTranslations('store.stateBadge');
  const tError = useTranslations('store.activationError');
  const format = useFormatter();

  if (isLegacy) {
    return (
      <span className={cn(PILL, WARNING_STYLE, className)}>
        <span className="-mt-0.5" aria-hidden>
          ⚠
        </span>
        {t('migrationNeeded')}
      </span>
    );
  }

  // OM-16 — readiness only ever REPLACES the label for a plugin the registry
  // considers present. An 'available' or 'incompatible' plugin has no
  // readiness story to tell.
  const isPresent = state === 'installed' || state === 'update-available';

  if (isPresent && readiness?.state === 'errored') {
    return (
      <span
        className={cn(PILL, DANGER_STYLE, className)}
        // #1456 — a `title` is user-facing text, so it may not be the plugin
        // API's English exception sentence. The badge carries the one-line
        // localized summary of the classified reason; the full explanation
        // lives on the plugin page, as text.
        title={erroredTitle(readiness, tError)}
      >
        {t('errored')}
      </span>
    );
  }

  // #1453 — the credentials were CHECKED and refused. Red, like `errored`,
  // because the plugin cannot serve a request — but a different label: it did
  // come up, so "activation failed" would be a false statement. The plugin's
  // own wording for the failure rides on the adjacent action-status pill; the
  // badge carries the state, not the detail.
  if (isPresent && readiness?.state === 'connection_failed') {
    return (
      <span
        className={cn(PILL, DANGER_STYLE, className)}
        title={actionStatus?.detail ?? undefined}
      >
        {t('connectionFailed')}
      </span>
    );
  }

  if (isPresent && readiness?.state === 'config_required') {
    const missing = readiness.missing_fields;
    return (
      <span
        className={cn(PILL, WARNING_STYLE, className)}
        title={
          missing.length > 0
            ? t('missingFields', { fields: missing.join(', ') })
            : undefined
        }
      >
        {t('configRequired')}
      </span>
    );
  }

  // Both warning states mean "installed but not usable yet".
  // The label names which admin form the operator must fix.
  if (isPresent && readiness?.state === 'awaiting_llm') {
    return (
      <span className={cn(PILL, WARNING_STYLE, className)}>
        {t('awaitingLlm')}
      </span>
    );
  }

  // #1453 — `verified_at` is the moment the plugin last ACTIVATED; nothing
  // asked the target system whether its credentials work. So the label says
  // "active since", never "configured"/"verified", and it is withheld entirely
  // once the plugin itself has reported that something needs attention.
  const reportedTrouble =
    actionStatus?.state === 'error' || actionStatus?.state === 'needs_action';

  if (
    isPresent &&
    readiness?.state === 'ready' &&
    readiness.verified_at &&
    !reportedTrouble
  ) {
    const at = new Date(readiness.verified_at);
    if (!Number.isNaN(at.getTime())) {
      return (
        <span className={cn(PILL, STYLE.installed, className)}>
          {t('activeSince', {
            time: format.dateTime(at, {
              dateStyle: 'short',
              timeStyle: 'short',
            }),
          })}
        </span>
      );
    }
  }

  return (
    <span className={cn(PILL, STYLE[state], className)}>
      {t(LABEL_KEY[state])}
    </span>
  );
}
