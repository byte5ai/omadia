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

/** Grants nothing. Every `hasScope` check against it is false. */
export const DENY_ALL_SCOPES: readonly ApiKeyScope[] = [];

/**
 * Normalizes the `scopes` field of a PERSISTED record.
 *
 * The distinction that matters here is *absent* versus *malformed*, because
 * collapsing the two turns a read error into a capability GRANT:
 *
 * - **Absent** (`undefined` — the field was never written) is a genuine
 *   pre-#439 record. It gets `LEGACY_DEFAULT_SCOPES`: exactly what that key
 *   could already do, no more.
 * - **Present but malformed** — not an array (`"memory:read"` stored as a
 *   bare string), or an array holding anything that is not a valid scope
 *   (`["Chat:Write"]`, `["nonsense"]`), or an empty array — is corruption or
 *   a writer bug. It gets `DENY_ALL_SCOPES`. Such a record is at least as
 *   likely to be a key an operator deliberately restricted AWAY from chat as
 *   it is to be a lost pre-#439 key, and handing it `chat:write` would grant
 *   precisely the access the operator removed.
 *
 * Partially-valid arrays deny too, rather than silently narrowing to the
 * valid subset: a record we cannot read faithfully is one we must not guess
 * at, and a key that looks like it has half its capabilities is worse to
 * debug than one that plainly has none.
 *
 * The key still AUTHENTICATES in the deny case — `verify()` is unaffected —
 * it is simply authorized for nothing, so every scope check fails closed and
 * the caller gets `403`, not a silently-widened `200`.
 */
export function normalizeScopes(raw: unknown): readonly ApiKeyScope[] {
  if (raw === undefined) return LEGACY_DEFAULT_SCOPES;
  if (!Array.isArray(raw)) {
    warnMalformedScopes('scopes is not an array', raw);
    return DENY_ALL_SCOPES;
  }
  if (raw.length === 0) {
    warnMalformedScopes('scopes is an empty array', raw);
    return DENY_ALL_SCOPES;
  }
  const invalid = raw.filter((entry) => !isValidScope(entry));
  if (invalid.length > 0) {
    warnMalformedScopes(
      `scopes contains ${String(invalid.length)} invalid entr${invalid.length === 1 ? 'y' : 'ies'}`,
      raw,
    );
    return DENY_ALL_SCOPES;
  }
  return Array.from(new Set(raw as readonly ApiKeyScope[]));
}

/** A malformed persisted `scopes` field silently stops a key from working;
 *  without this line an operator has no way to tell that from a revoke. The
 *  raw value is summarized, never dumped — the record it came from also
 *  holds a key hash. */
function warnMalformedScopes(reason: string, raw: unknown): void {
  console.warn(
    `[api-key-auth] malformed persisted scopes (${reason}, type=${
      Array.isArray(raw) ? 'array' : typeof raw
    }) — key denied all scopes until the record is repaired`,
  );
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
