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

/** W2-3 (issue #542) — enumerate the tools the public MCP endpoint exposes to
 *  this key. Seeing a tool name is itself a disclosure, so listing is its own
 *  capability rather than a free side effect of authenticating. */
export const MCP_LIST_SCOPE = 'mcp:list';

/** W2-3 — call a READ tool over the public MCP endpoint. Deliberately NOT
 *  sufficient for a write: see `MCP_WRITE_SCOPE_PREFIX`. */
export const MCP_INVOKE_SCOPE = 'mcp:invoke';

/**
 * W2-3 — prefix of the per-tool write capability, `mcp:write:<tool>`.
 *
 * Marcel's decision to expose write tools (not just reads) over a PUBLIC
 * endpoint is what makes this granularity a requirement rather than a nicety.
 * Three properties hold, and each exists because the coarser alternative is a
 * real escalation:
 *
 *  - It is PER TOOL. `mcp:invoke` authorizes reads as a class; there is no
 *    equivalent class-wide write scope, because "this integration may write"
 *    is never the sentence an operator means — they mean "this integration may
 *    call `create_lead`", and nothing else.
 *  - It is NOT reachable via `WILDCARD_SCOPE`. `*` is a convenience for an
 *    operator's own tooling; silently including "delete every Odoo invoice via
 *    an internet-facing endpoint" in that convenience is not a trade anyone
 *    consciously makes. `hasScope` enforces this for every caller — see there.
 *  - It is THREE segments, so it cannot collide with, or be satisfied by, any
 *    two-segment scope an operator or plugin already minted.
 */
export const MCP_WRITE_SCOPE_PREFIX = 'mcp:write:';

/** Builds the write capability for one tool. Use this rather than
 *  concatenating, so the prefix has exactly one definition. */
export function mcpWriteScope(toolName: string): ApiKeyScope {
  return `${MCP_WRITE_SCOPE_PREFIX}${toolName}`;
}

/** True for a `mcp:write:<tool>` scope. Drives the wildcard exclusion in
 *  `hasScope`, so it must stay a pure shape test with no allow-list. */
export function isMcpWriteScope(scope: ApiKeyScope): boolean {
  return scope.startsWith(MCP_WRITE_SCOPE_PREFIX);
}

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

/**
 * W2-3 — the ONLY three-segment shape admitted: `mcp:write:<tool>`.
 *
 * Written as a literal `mcp:write:` prefix rather than a generic
 * `<a>:<b>:<c>` rule on purpose. A generic three-segment rule would quietly
 * legalize every `foo:bar:baz` string an operator mistypes, and each such
 * string would then be a scope that validates, persists, and grants nothing —
 * indistinguishable from a revoked key at debug time. `<tool>` reuses the same
 * character class the other segments use, so a tool name that cannot appear
 * here cannot be granted at all (fail closed, not fail open).
 */
const MCP_WRITE_SCOPE_PATTERN = /^mcp:write:[a-z][a-z0-9_-]*$/;

/**
 * The bare two-segment `mcp:write`, rejected outright.
 *
 * It is a perfectly well-formed two-segment scope, so `SCOPE_PATTERN` accepts
 * it — and it is the single most likely thing an operator types when they mean
 * "let this key write". It would validate, persist, and grant NOTHING (no write
 * check ever asks for it), which is indistinguishable from a revoked key at
 * debug time. Rejecting it turns a silent misconfiguration into an error at the
 * moment of the mistake. There is deliberately no class-wide write scope to
 * point them at instead: writes are per tool, by design.
 */
const REJECTED_SCOPES: readonly string[] = ['mcp:write'];

export function isValidScope(value: unknown): value is ApiKeyScope {
  if (typeof value !== 'string') return false;
  if (value === WILDCARD_SCOPE) return true;
  if (REJECTED_SCOPES.includes(value)) return false;
  if (MCP_WRITE_SCOPE_PATTERN.test(value)) return true;
  // Checked LAST and unchanged: a `mcp:write:x` string has two colons and
  // never matched `SCOPE_PATTERN` anyway, so nothing that used to validate
  // stops validating and nothing new slips through the two-segment rule.
  return SCOPE_PATTERN.test(value);
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
 *
 * The empty array earns its place in the malformed group by an invariant on
 * the write side: no writer here can persist one. `assertValidScopes` throws
 * on `[]`, so `create()` cannot store it, and the HTTP boundary
 * (`CreateKeyRequestSchema` in `@omadia/channel-api`'s `adminKeysRouter.ts`)
 * answers `400` before that. A persisted `[]` is therefore corruption or a
 * foreign writer by construction, and denying is the only honest reading.
 * Keep the two halves in step — if `[]` ever became persistable, the same
 * value would mean "grant the default" on write and "grant nothing" on read.
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
 *
 * An EXPLICIT empty array is rejected here rather than resolved to any default.
 * The read path (`normalizeScopes`) treats a persisted `[]` as corruption and
 * returns `DENY_ALL_SCOPES`; if creation quietly turned the same value into
 * `LEGACY_DEFAULT_SCOPES` instead, one field would mean "deny everything" going
 * out and "grant chat" going in — and the grant is the dangerous direction.
 * Omitting `scopes` entirely remains the way to ask for the legacy default.
 */
export function assertValidScopes(scopes: readonly unknown[]): readonly ApiKeyScope[] {
  if (scopes.length === 0) {
    throw new Error(
      'API-key scopes must not be empty; omit the field entirely to accept the default',
    );
  }
  const invalid = scopes.filter((s) => !isValidScope(s));
  if (invalid.length > 0) {
    throw new Error(`invalid API-key scope(s): ${invalid.map((s) => String(s)).join(', ')}`);
  }
  return Array.from(new Set(scopes as readonly ApiKeyScope[]));
}

/**
 * True when `granted` covers `required` — exact match, or the global `*`.
 *
 * W2-3 carves ONE exception out of the wildcard: a `mcp:write:<tool>` scope is
 * satisfied by an exact match and by nothing else. The exception lives HERE,
 * inside the single scope-matching primitive, rather than in a second
 * `hasWriteScope` function the public-MCP route is expected to remember to
 * call. A parallel matcher is a matcher someone eventually forgets: the wrong
 * call would still compile, still typecheck, and still return `true` for `*` —
 * quietly granting an internet-facing write. There is one matcher, and it is
 * correct for every caller including `requireApiKey`'s own `opts.scope` gate.
 *
 * `hasWriteScope` below exists only as an intention-revealing alias; it adds no
 * behavior, so using the wrong one of the two is not a security event.
 */
export function hasScope(
  granted: readonly ApiKeyScope[] | undefined,
  required: ApiKeyScope,
): boolean {
  if (!granted) return false;
  if (isMcpWriteScope(required)) return granted.includes(required);
  return granted.includes(WILDCARD_SCOPE) || granted.includes(required);
}

/** True when `granted` explicitly names the write capability for `toolName`.
 *  Intention-revealing alias for `hasScope(granted, mcpWriteScope(tool))` —
 *  see the wildcard note on `hasScope`. */
export function hasWriteScope(
  granted: readonly ApiKeyScope[] | undefined,
  toolName: string,
): boolean {
  return hasScope(granted, mcpWriteScope(toolName));
}
