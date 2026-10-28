/**
 * #1456 — classify an activation failure for the operator, and project the
 * one activation-result shape every (re)activating write answers with (#1497).
 *
 * WHY
 * ---
 * The registry used to record an activation failure as free text only — the
 * exception message, which the plugin API writes for plugin AUTHORS. The store
 * then interpolated it into a translated prefix, so the German UI read
 * "Installiert, aber das Plugin ist nicht gestartet: plugin '…' called
 * ctx.services.get('entityRefBus') but its manifest does not declare that
 * capability — add …", an instruction no operator can follow. One string cannot
 * carry both "fill in the missing key" and "this plugin version does not fit
 * this server", so the failure gets a CODE next to the raw tail.
 *
 * RULES
 *  - Classify from the error OBJECT (`name`, typed fields, errno `code`),
 *    never from the message. `name` rather than `instanceof`, because a plugin
 *    can bundle its own copy of `@omadia/plugin-api` and still throw the same
 *    class — and the kernel's own throws carry the same names.
 *  - The raw message stays the technical detail (`last_activation_error`,
 *    still bounded to 500 chars). Nothing else is persisted: no code argument,
 *    so no second place that could carry plugin text or a secret value.
 *  - Absence degrades to `unknown`, never to "fine": registry files written
 *    before the field existed carry a reason and no code.
 */

import type {
  ActivationErrorCode,
  PluginActivationResult,
} from '../api/admin-v1.js';
import type { InstalledAgent } from './installedRegistry.js';

/** What a seam hands the registry when an activation did not take. A bare
 *  string is still accepted by the registry and recorded without a code. */
export interface ActivationFailure {
  readonly message: string;
  readonly code: ActivationErrorCode;
}

const ACTIVATION_ERROR_CODES: ReadonlySet<string> = new Set<ActivationErrorCode>([
  'secret_missing',
  'config_missing',
  'capability_not_declared',
  'network_not_permitted',
  'permission_not_granted',
  'dependency_unresolved',
  'provider_conflict',
  'target_unreachable',
  'unknown',
]);

export function isActivationErrorCode(value: unknown): value is ActivationErrorCode {
  return typeof value === 'string' && ACTIVATION_ERROR_CODES.has(value);
}

/** Errno codes that mean "the other side did not answer". Same set
 *  `bootstrap.ts` treats as transient, read from the typed field here. */
const UNREACHABLE_ERRNOS: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const BY_NAME: Readonly<Record<string, ActivationErrorCode>> = {
  MissingSecretError: 'secret_missing',
  MissingConfigError: 'config_missing',
  ServiceNotDeclaredError: 'capability_not_declared',
  EventNotDeclaredError: 'capability_not_declared',
  HttpForbiddenError: 'network_not_permitted',
  NetForbiddenError: 'network_not_permitted',
};

function readField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function errnoOf(err: unknown): string | undefined {
  // undici wraps the socket error: `TypeError('fetch failed', { cause })`.
  for (const candidate of [err, readField(err, 'cause')]) {
    const code = readField(candidate, 'code');
    if (typeof code === 'string' && UNREACHABLE_ERRNOS.has(code)) return code;
  }
  return undefined;
}

/** The operator-facing kind of failure behind a thrown activation error. */
export function classifyActivationError(err: unknown): ActivationErrorCode {
  const name = readField(err, 'name');
  if (typeof name === 'string') {
    const byName = BY_NAME[name];
    if (byName) return byName;
    if (name === 'SqlPermissionError') {
      // `undeclared` is the author's missing manifest line; `ungranted` is the
      // operator's open consent. Only the second is the operator's to fix.
      return readField(err, 'reason') === 'ungranted'
        ? 'permission_not_granted'
        : 'capability_not_declared';
    }
  }
  if (errnoOf(err) !== undefined) return 'target_unreachable';
  return 'unknown';
}

/**
 * The thrown value as the registry records it: the raw message (never empty —
 * every consumer tests it for truthiness) plus its code.
 */
export function describeActivationFailure(
  err: unknown,
  emptyFallback = 'activation threw without a message',
): ActivationFailure {
  const message = (err instanceof Error ? err.message : String(err)) || emptyFallback;
  return { message, code: classifyActivationError(err) };
}

/** Normalise what a caller handed `markActivationFailed`/`…Blocked`. */
export function toActivationFailure(
  error: string | ActivationFailure,
): { readonly message: string; readonly code: ActivationErrorCode | undefined } {
  return typeof error === 'string'
    ? { message: error, code: undefined }
    : { message: error.message, code: error.code };
}

/** The stored code of a failed entry, `unknown` when it predates codes. */
export function activationErrorCodeOf(entry: InstalledAgent): ActivationErrorCode {
  return isActivationErrorCode(entry.last_activation_error_code)
    ? entry.last_activation_error_code
    : 'unknown';
}

/**
 * #1497 — the registry's word on a plugin after an activation attempt, in the
 * shape install, setup-field writes and update/ingest all return. `null` for a
 * plugin the registry does not hold.
 *
 * Error fields are filled only for `errored`: an `active` entry may still
 * carry a failure count from a boot attempt, and reporting that as the reason
 * for a plugin that is running would be the opposite lie.
 */
export function activationResultOf(
  entry: InstalledAgent | undefined,
): PluginActivationResult | null {
  if (!entry) return null;
  if (entry.status !== 'errored') {
    return { state: entry.status, ok: entry.status === 'active', error: null, error_code: null };
  }
  return {
    state: 'errored',
    ok: false,
    error: entry.last_activation_error ?? null,
    error_code: activationErrorCodeOf(entry),
  };
}
