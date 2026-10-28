/**
 * #1456 — reading the middleware's activation-failure classification.
 *
 * What this replaces: the drawer and the plugin page rendered
 * `t('activationFailed', { message })`, where `message` was the plugin API's
 * own exception sentence. Only the prefix came from the catalog, so the German
 * UI said "Installiert, aber das Plugin ist nicht gestartet:" and then
 * continued in English — with advice addressed to a plugin author ("add
 * 'entityRefBus@<major>' to the manifest's `requires:` list"), which an
 * operator cannot act on.
 *
 * The middleware now classifies the failure into a code
 * (`plugins/activationErrorReason.ts`). This module narrows that code at the
 * boundary and maps it to catalog copy, so the operator reads what happened
 * and what they can do, in their language. The raw sentence survives as a
 * secondary technical detail — never as the headline.
 *
 * Narrowed tolerantly, exactly like `parseTeamsIdentityLastErrorDetail`: a
 * middleware older than the field sends no reason, and a newer one may send a
 * code this build has no copy for. Both must still render the localized
 * fallback over the raw sentence rather than losing the error.
 */

import type { ActivationErrorReason } from './storeTypes';

/** Every code this build has copy for. The catalog is checked against this
 *  list by `__tests__/activationError.test.ts`, so a new code cannot ship
 *  without both locales. */
export const ACTIVATION_ERROR_CODES = [
  'capability_not_declared',
  'dependency_unresolved',
  'provider_conflict',
  'secret_missing',
  'config_missing',
  'permission_not_granted',
  'target_unreachable',
  'unknown',
] as const;

export type ActivationErrorCode = (typeof ACTIVATION_ERROR_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set(ACTIVATION_ERROR_CODES);

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringListOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((entry) => typeof entry === 'string')
    ? (value as string[])
    : undefined;
}

/**
 * Narrow `readiness.error_reason` / `activation_state.error_reason` /
 * `last_activation_error_reason`.
 *
 * `null` means "no classification was sent" — the caller then renders the raw
 * sentence as the technical detail under the generic headline. An object whose
 * `code` this build does not know degrades to `unknown`, which has its own
 * copy, rather than being dropped.
 */
export function parseActivationErrorReason(
  value: unknown,
): ActivationErrorReason | null {
  if (value === null || value === undefined || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const rawCode = record['code'];
  const code: ActivationErrorCode =
    typeof rawCode === 'string' && CODE_SET.has(rawCode)
      ? (rawCode as ActivationErrorCode)
      : 'unknown';

  const capability = stringOf(record['capability']);
  const field = stringOf(record['field']);
  const conflicting = stringOf(record['conflicting_plugin_id']);
  const requires = stringListOf(record['requires']);

  return {
    code,
    ...(capability ? { capability } : {}),
    ...(field ? { field } : {}),
    ...(conflicting ? { conflicting_plugin_id: conflicting } : {}),
    ...(requires ? { requires } : {}),
  };
}

/** Catalog sub-key under `store.activationError` for a code. Identity today —
 *  it exists so a code renamed on the wire does not force a catalog rename
 *  (and a translation review) with it. */
export function activationErrorCopyKey(code: ActivationErrorCode): string {
  return code;
}
