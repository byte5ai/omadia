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

/** Sensitive parameter/field names, matched in JSON bodies and query strings. */
const SECRET_KEYS = [
  'access_token',
  'refresh_token',
  'id_token',
  'code_verifier',
  'code_challenge',
  'client_secret',
  'assertion',
  'code',
] as const;

const KEY_ALTERNATION = SECRET_KEYS.join('|');

/** `"access_token":"…"` / `"access_token": '…'` in a JSON-ish body. */
const JSON_FIELD_RE = new RegExp(`("?(?:${KEY_ALTERNATION})"?\\s*:\\s*)("[^"]*"|'[^']*'|[^,}\\s]+)`, 'gi');
/** `code=…` / `&refresh_token=…` in a query string or form body. */
const QUERY_PARAM_RE = new RegExp(`\\b(${KEY_ALTERNATION})=([^&\\s"'}\\]]+)`, 'gi');
/** `Authorization: Bearer …` echoed back in an error. */
const BEARER_RE = /\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;

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
  out = out.replace(BEARER_RE, (_m, prefix: string) => `${prefix}${REDACTED}`);
  return out;
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
