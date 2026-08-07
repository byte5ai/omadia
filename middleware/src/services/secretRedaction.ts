/**
 * Redaction for anything on its way to a log line in the OAuth path (W0-1, D5).
 *
 * An OAuth error is one of the most secret-dense strings in the system: a
 * provider's error body routinely echoes the `code`, the `code_verifier`, or a
 * whole token JSON back at you, and `fetch` failures embed the request URL with
 * its query string. `String(err)` therefore cannot go to a log untouched.
 *
 * Two layers, because either alone leaks:
 *  1. EXACT values we already hold (the token we just sent, the verifier we
 *     generated) — caught wherever they appear, in any encoding shape.
 *  2. PATTERNS for values we do NOT hold, because the error came from a server
 *     that minted them (a rotated refresh token in a JSON error body).
 */

const REDACTED = '[redacted]';

/**
 * Sensitive parameter/field names, matched in JSON bodies and query strings.
 *
 * The OAuth snake_case set is the original scope. The rest were added when this
 * redactor picked up a second caller: `mcp_call_log` stores error text from
 * ARBITRARY upstream MCP servers, which are not OAuth providers and do not
 * speak RFC 6749 spelling. A vendor answering `authentication failed;
 * X-API-Key: sk_live_…` was persisted verbatim because no pattern matched.
 *
 * camelCase variants are listed explicitly rather than matched case-insensitively
 * on the underscore forms, because `accessToken` and `access_token` are
 * different strings and the alternation is literal.
 */
const SECRET_KEYS = [
  // OAuth / OIDC (RFC 6749, 7636)
  'access_token',
  'refresh_token',
  'id_token',
  'code_verifier',
  'code_challenge',
  'client_secret',
  'assertion',
  'code',
  // camelCase spellings, common in JSON APIs and SDK error objects
  'accessToken',
  'refreshToken',
  'idToken',
  'clientSecret',
  'apiKey',
  'authToken',
  'sessionToken',
  'privateKey',
  // Generic credential names an upstream MCP server is likely to echo
  'api_key',
  'apikey',
  'token',
  'secret',
  'password',
  'passwd',
  'private_key',
  'session_token',
  'auth_token',
] as const;

/** Header names whose VALUE is a credential, matched as `Name: value`.
 *  `Authorization` is handled separately (it has a scheme prefix worth keeping). */
const SECRET_HEADERS = [
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'api-key',
  'proxy-authorization',
] as const;

const KEY_ALTERNATION = SECRET_KEYS.join('|');

/** `"access_token":"…"` / `"access_token": '…'` in a JSON-ish body. */
const JSON_FIELD_RE = new RegExp(`("?(?:${KEY_ALTERNATION})"?\\s*:\\s*)("[^"]*"|'[^']*'|[^,}\\s]+)`, 'gi');
/** `code=…` / `&refresh_token=…` in a query string or form body. */
const QUERY_PARAM_RE = new RegExp(`\\b(${KEY_ALTERNATION})=([^&\\s"'}\\]]+)`, 'gi');
/** `Authorization: Bearer …` echoed back in an error. Also covers `Basic`,
 *  which carries base64 `user:password` and is what a non-OAuth upstream is
 *  most likely to send. The scheme word is kept — it is diagnostic, not secret. */
const BEARER_RE = /\b(bearer\s+|basic\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;

/** `X-API-Key: sk_live_…` — a header whose whole value is the credential.
 *  Separate from `QUERY_PARAM_RE` because the separator is `:` and the name
 *  contains hyphens, which `\b` handles differently. */
const HEADER_RE = new RegExp(`\\b(${SECRET_HEADERS.join('|')})(\\s*:\\s*)([^\\s,;"'}\\]]+)`, 'gi');

/** Escape a literal for safe use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redact secrets from arbitrary text before it reaches a log.
 *
 * @param text    the text to sanitize (already stringified).
 * @param secrets exact secret values known to the caller (token, verifier, …).
 *                Short values (< 8 chars) are ignored — redacting them would
 *                shred unrelated text without protecting anything meaningful.
 */
export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    out = out.replace(new RegExp(escapeRe(secret), 'g'), REDACTED);
    // Providers frequently echo the value URL-encoded rather than raw.
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.replace(new RegExp(escapeRe(encoded), 'g'), REDACTED);
  }
  out = out.replace(JSON_FIELD_RE, (_m, key: string) => `${key}"${REDACTED}"`);
  out = out.replace(QUERY_PARAM_RE, (_m, key: string) => `${key}=${REDACTED}`);
  out = out.replace(
    HEADER_RE,
    (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`,
  );
  out = out.replace(BEARER_RE, (_m, prefix: string) => `${prefix}${REDACTED}`);
  return out;
}

/**
 * Redact an audit entry's `error` before it is persisted.
 *
 * Structural on purpose — no import of the row type — so both `mcp_call_log`
 * sinks can share ONE transform. There are two of them (the runtime observer
 * and the Agent Builder sandbox observer), they write to the same table, and
 * only one of them was redacting; a copy-pasted expression at each call site is
 * how that asymmetry happened in the first place.
 *
 * Removes CREDENTIALS, not PII. An upstream error quoting a customer name still
 * lands in the table — masking that means running the privacy pipeline inside
 * the audit writer, which is a design decision rather than a patch.
 */
export function redactAuditError<T extends { readonly error: string | null }>(entry: T): T {
  return entry.error === null ? entry : { ...entry, error: redactSecrets(entry.error) };
}

/**
 * `String(err)` for a log line, with redaction applied. Use this instead of
 * `String(err)` anywhere an OAuth error can reach a logger.
 */
export function redactedErrorText(
  err: unknown,
  secrets: readonly (string | null | undefined)[] = [],
): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return redactSecrets(raw, secrets);
}
