/**
 * #1456 / #1497 — the activation outcome as the middleware reports it, narrowed
 * at the boundary.
 *
 * Mirrors `ActivationErrorCode` / `PluginActivationResult` in middleware
 * `api/admin-v1.ts`. The raw `error` is the plugin API's message, written for
 * plugin AUTHORS and English in every locale — it is only ever shown as a
 * secondary "technical detail". What the operator reads comes from
 * `store.activationError.<code>` in the catalog.
 */

export const ACTIVATION_ERROR_CODES = [
  'secret_missing',
  'config_missing',
  'capability_not_declared',
  'network_not_permitted',
  'permission_not_granted',
  'dependency_unresolved',
  'provider_conflict',
  'target_unreachable',
  'unknown',
] as const;

export type ActivationErrorCode = (typeof ACTIVATION_ERROR_CODES)[number];

/** Anything that is not a known code — an older middleware sends none, a newer
 *  one may send a code this UI predates — reads as `unknown`, which still has
 *  localized copy. Never throws. */
export function parseActivationErrorCode(value: unknown): ActivationErrorCode {
  return (ACTIVATION_ERROR_CODES as readonly unknown[]).includes(value)
    ? (value as ActivationErrorCode)
    : 'unknown';
}

/** The one shape install, setup-field writes and update/ingest answer with. */
export interface PluginActivationResult {
  state: 'active' | 'inactive' | 'errored';
  ok: boolean;
  error: string | null;
  error_code: ActivationErrorCode | null;
}

/** Tolerant narrowing of a response's `activation` field; `null` when absent
 *  or malformed (an older middleware), which callers must not read as "ok". */
export function parseActivationResult(value: unknown): PluginActivationResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const state = v['state'];
  if (state !== 'active' && state !== 'inactive' && state !== 'errored') return null;
  return {
    state,
    ok: state === 'active',
    error: typeof v['error'] === 'string' ? v['error'] : null,
    error_code: state === 'errored' ? parseActivationErrorCode(v['error_code']) : null,
  };
}
