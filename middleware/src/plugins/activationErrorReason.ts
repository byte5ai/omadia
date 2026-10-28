/**
 * #1456 — the machine-readable half of an activation failure.
 *
 * Before this, a failed activation was recorded as free text only: whatever
 * `err.message` the plugin API produced. Those messages are written FOR PLUGIN
 * AUTHORS ("add 'entityRefBus@<major>' to the manifest's `requires:` list"),
 * they are English in both UI languages, and the one thing an operator needs —
 * what THEY can do — is not in them. A UI that only has the sentence can only
 * interpolate it, which is exactly what `store.install.activationFailed` did.
 *
 * So the failure is classified here into a closed set of codes, one per
 * OPERATOR ACTION rather than one per exception class:
 *
 *   capability_not_declared → nothing to fix on this server; the plugin
 *                             version is wrong for this core (roll back, report)
 *   dependency_unresolved   → install the plugin that provides the capability
 *   provider_conflict       → two installed plugins provide the same
 *                             capability; uninstall one
 *   secret_missing          → fill the secret field in setup
 *   config_missing          → fill the config field in setup
 *   permission_not_granted  → grant the permission in the grants panel
 *   target_unreachable      → the target system / infra dependency is down
 *   unknown                 → no classification; the UI falls back to the raw
 *                             sentence as a technical detail
 *
 * Classification reads the error OBJECT — its `name` and its typed fields —
 * never its message. That is the same policy `toolErrorNotice.ts` already
 * applies to exception text that would otherwise reach a model, and it is why
 * `teamsProvisioningJob`'s `"<code>: …"` sentence-prefix round trip is NOT the
 * pattern copied here.
 *
 * `name` rather than `instanceof`: a plugin resolves `@omadia/plugin-api` from
 * its own `node_modules`, so an error can cross a package boundary from a
 * second copy of the class and fail every `instanceof` while being exactly the
 * error we mean. The class names are part of the plugin-API contract.
 */

/** What the operator can do about a failed activation. */
export type ActivationErrorCode =
  | 'capability_not_declared'
  | 'dependency_unresolved'
  | 'provider_conflict'
  | 'secret_missing'
  | 'config_missing'
  | 'permission_not_granted'
  | 'target_unreachable'
  | 'unknown';

/**
 * The classified reason, as persisted on the registry entry and projected to
 * clients. Deliberately tiny: a code plus the arguments a localized sentence
 * needs. Never a free-text field — the raw sentence stays in
 * `last_activation_error`, and nothing here may carry a secret VALUE (the
 * field key only).
 */
export interface ActivationErrorReason {
  code: ActivationErrorCode;
  /** Capability name (`capability_not_declared`, `permission_not_granted`,
   *  `provider_conflict`). */
  capability?: string;
  /** The plugin that won a `provider_conflict` — the one an operator would
   *  keep, named so the choice is not blind. */
  conflicting_plugin_id?: string;
  /** Setup-field key (`secret_missing`, `config_missing`). */
  field?: string;
  /** Raw `<name>@<major>` entries (`dependency_unresolved`). */
  requires?: string[];
}

/** An error's own name, when it is one. */
function errorName(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function stringField(err: unknown, key: string): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const value = (err as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Node / driver errnos that mean "the other side was not reachable", as
 *  `err.code`. */
const UNREACHABLE_ERRNOS = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
] as const;

const UNREACHABLE_ERRNO_SET: ReadonlySet<string> = new Set(UNREACHABLE_ERRNOS);

/**
 * Connection-level failure fingerprints IN THE MESSAGE — the single source of
 * truth for two questions that must not disagree about the same failure:
 * whether to TELL the operator the target system was unreachable (here), and
 * whether the entry is worth re-attempting on the next boot
 * (`bootstrap.retryErroredPlugins`, which imports this).
 *
 * The message is the one thing this module reads besides the error object, and
 * only to look for a fingerprint in it — never to copy any of it into a
 * reason. The exception is necessary because a wrapper that rethrows (`new
 * Error(\`connect failed: \${err.message}\`)`) keeps the errno in the text and
 * loses `err.code`, which is the common shape for a plugin whose database or
 * Ollama host is down. Driver prose ("the database system is starting up") only
 * ever exists in the text.
 */
export const TRANSIENT_UNREACHABLE_RE =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|getaddrinfo|Connection terminated|connection refused|the database system is starting up|timed out/i;

/**
 * Classify what a plugin's activation hook threw.
 *
 * Total: an unrecognised throw — including a thrown string, which IS a message
 * and must not be parsed — yields `unknown`, and the UI then renders its
 * localized fallback with the raw sentence as a technical detail. Never throws.
 */
export function classifyActivationError(err: unknown): ActivationErrorReason {
  const name = errorName(err);
  const capability = stringField(err, 'capability');

  switch (name) {
    case 'ServiceNotDeclaredError':
      // Both of its reasons are the same fact for an operator: this plugin
      // build asks the core for a capability its manifest never declared.
      return {
        code: 'capability_not_declared',
        ...(capability ? { capability } : {}),
      };
    case 'SqlPermissionError':
      // The one error class that is two different stories. `ungranted` is the
      // operator's to answer (a grant); `undeclared` is a manifest bug they
      // cannot fix at all.
      return {
        code:
          stringField(err, 'reason') === 'ungranted'
            ? 'permission_not_granted'
            : 'capability_not_declared',
        ...(capability ? { capability } : {}),
      };
    case 'MissingSecretError': {
      const field = stringField(err, 'key');
      return { code: 'secret_missing', ...(field ? { field } : {}) };
    }
    case 'MissingConfigError': {
      const field = stringField(err, 'key');
      return { code: 'config_missing', ...(field ? { field } : {}) };
    }
    default:
      break;
  }

  const errno = stringField(err, 'code');
  if (errno !== undefined && UNREACHABLE_ERRNO_SET.has(errno)) {
    return { code: 'target_unreachable' };
  }
  const message = stringField(err, 'message');
  if (message !== undefined && TRANSIENT_UNREACHABLE_RE.test(message)) {
    return { code: 'target_unreachable' };
  }

  return { code: 'unknown' };
}

/**
 * The resolver's other refusal, also not an exception: two installed plugins
 * provide the same capability and the younger one is dropped. Terminal — a
 * retry cannot resolve it — and the operator's action is to uninstall one of
 * the two, which is why the survivor is named.
 */
export function providerConflictReason(
  capability: string,
  keptPluginId: string,
): ActivationErrorReason {
  return {
    code: 'provider_conflict',
    ...(capability ? { capability } : {}),
    ...(keptPluginId ? { conflicting_plugin_id: keptPluginId } : {}),
  };
}

/**
 * The capability-resolver's refusal, which is not an exception at all: the
 * runtime drops a consumer from the eligible set and synthesises a sentence
 * for it. The `requires:` list it was refused for is already structured, so it
 * travels with the reason — the operator's action is to install a provider for
 * those names.
 */
export function dependencyUnresolvedReason(
  requires: readonly string[],
): ActivationErrorReason {
  return {
    code: 'dependency_unresolved',
    ...(requires.length > 0 ? { requires: [...requires] } : {}),
  };
}
