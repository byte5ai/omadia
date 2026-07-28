/**
 * Issue #439 — per-key scopes.
 *
 * Authentication alone stopped being sufficient the moment API keys became a
 * first-class auth method usable by more than the one chat route: a key that
 * authenticates must also be restrictable to the capabilities its holder
 * actually needs. A scope is a plain `<resource>:<action>` string so a plugin
 * can mint its own vocabulary without this package having to know about it.
 *
 * Deliberately no hierarchy matching (`chat:*`): the only wildcard is the
 * global `*`, and everything else is an exact match. A prefix matcher invites
 * exactly the kind of "I thought `admin:*` didn't cover `admin:delete`"
 * mistake that scopes exist to prevent.
 */

/** A scope string. Kept as `string` rather than a closed union so plugins can
 *  define their own capability names — validity is enforced by shape
 *  (`isValidScope`), not by an allow-list this package would have to own. */
export type ApiKeyScope = string;

/** Grants every scope. Only ever set explicitly by an operator — never a
 *  default, and never inferred for a key that predates scopes. */
export const WILDCARD_SCOPE = '*';

/** The capability the public chat ingress requires (`@omadia/channel-api`). */
export const CHAT_WRITE_SCOPE = 'chat:write';

/**
 * What a key with no persisted `scopes` field is treated as.
 *
 * Backward compatibility with a security floor: keys minted by issue #438
 * predate scopes entirely, and the only thing they could ever reach was
 * `POST /api/public/v1/chat`. Defaulting them to `chat:write` keeps every one
 * of them working exactly as before. Defaulting them to `*` would also "keep
 * them working" — and would silently widen every existing key to whatever
 * scoped surface gets added next, which is a privilege escalation delivered
 * by an upgrade.
 */
export const LEGACY_DEFAULT_SCOPES: readonly ApiKeyScope[] = [CHAT_WRITE_SCOPE];

/** `<resource>:<action>`, lowercase, or the bare global wildcard. */
const SCOPE_PATTERN = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/;

export function isValidScope(value: unknown): value is ApiKeyScope {
  if (typeof value !== 'string') return false;
  return value === WILDCARD_SCOPE || SCOPE_PATTERN.test(value);
}

/**
 * Normalizes the `scopes` field of a PERSISTED record. Lenient by design —
 * a stored record is not user input, and a missing/corrupt field must not
 * take a working integration offline; it falls back to the legacy default.
 */
export function normalizeScopes(raw: unknown): readonly ApiKeyScope[] {
  if (!Array.isArray(raw)) return LEGACY_DEFAULT_SCOPES;
  const valid = Array.from(new Set(raw.filter(isValidScope)));
  return valid.length > 0 ? valid : LEGACY_DEFAULT_SCOPES;
}

/**
 * Validates operator-supplied scopes at CREATION time. Strict by design —
 * silently dropping a typo'd scope would hand back a key that looks right and
 * is quietly missing a capability. Callers accepting HTTP input should
 * validate first and answer 400; reaching this throw is a programmer error.
 */
export function assertValidScopes(scopes: readonly unknown[]): readonly ApiKeyScope[] {
  const invalid = scopes.filter((s) => !isValidScope(s));
  if (invalid.length > 0) {
    throw new Error(`invalid API-key scope(s): ${invalid.map((s) => String(s)).join(', ')}`);
  }
  return Array.from(new Set(scopes as readonly ApiKeyScope[]));
}

/** True when `granted` covers `required` — exact match, or the global `*`. */
export function hasScope(
  granted: readonly ApiKeyScope[] | undefined,
  required: ApiKeyScope,
): boolean {
  if (!granted) return false;
  return granted.includes(WILDCARD_SCOPE) || granted.includes(required);
}
