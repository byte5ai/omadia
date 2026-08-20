/**
 * Provider errors reach the chat surfaces as a raw string that wraps the one
 * sentence a user can act on in transport noise: an optional leading HTTP status
 * ("429 ..."), and — for JSON-bodied providers like Anthropic — the full
 * response envelope. `extractProviderErrorMessage` peels both away and returns
 * the embedded human-readable message, provider-agnostic (works for the OpenAI
 * plain-text shape and the Anthropic JSON shape alike).
 *
 * The discriminator is a single question: after stripping any leading HTTP
 * status, does the *whole* remaining string parse as a JSON object? That, not
 * the presence of braces and not a leading status, is what tells a wrapped
 * provider envelope apart from an application message:
 *
 *   - Empty / whitespace input returns `null`.
 *   - If the remainder is a JSON object, it is a provider envelope: mine
 *     `error.message`, then a top-level `message`, and return the first
 *     non-empty one. An envelope with nothing surfaceable returns `null` so the
 *     caller shows the generic fallback — never the raw JSON. This covers the
 *     status-less rate-limit envelope `{"type":"error","error":{...}}`, which a
 *     brace-substring hunt used to leak verbatim to users.
 *   - Otherwise it is an application message and is returned unchanged (minus
 *     the stripped status prefix), braces or not. So the builder's own
 *     human-readable events, brace-bearing diagnostics, and messages that merely
 *     embed a JSON fragment (e.g. `Agent stopped: {"message":"waiting"}`) pass
 *     through with their surrounding text intact.
 */
export function extractProviderErrorMessage(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Strip a leading HTTP status ("429 ...", "400 ...").
  const withoutStatus = trimmed.replace(/^\d{3}\s+/, '');

  // Provider envelope iff the whole remaining string is a JSON object.
  const envelope = parseJsonObject(withoutStatus);
  if (envelope) {
    // Anthropic-style: the sentence lives under `error.message`, else a
    // top-level `message`. No message means the envelope carries nothing
    // surfaceable — fall back rather than leak the raw JSON.
    return messageFromEnvelope(envelope);
  }

  // Not a JSON object: an application message (with or without a stripped status
  // prefix). Return it unchanged; never destroy it.
  return withoutStatus.length > 0 ? withoutStatus : null;
}

/**
 * Convenience wrapper for UI call sites: returns the extracted provider message
 * when one is present, otherwise the caller's translated generic fallback.
 */
export function humanizeProviderError(raw: string, fallback: string): string {
  return extractProviderErrorMessage(raw) ?? fallback;
}

/**
 * True when a provider error is a credential rejection — the one failure class
 * a user can actually FIX themselves, so chat surfaces show a localized
 * sentence pointing at Admin → LLM access instead of the provider's raw
 * English sentence ("API key is invalid.", "invalid x-api-key", …).
 *
 * Field-test provenance (OM-26, retest 2026-08-20): the packaged app already
 * stripped the JSON envelope, but the extracted sentence itself was English in
 * a German UI and named no next step. The middleware has no request locale
 * (see `PatternViolation.hint` in the middleware for the doctrine), so the
 * client owns this mapping, keyed on the error's SHAPE — status 401,
 * `authentication_error`, or the well-known key phrasings — never on full
 * message equality, which would break on the provider's next wording change.
 */
export function isProviderAuthError(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^401\b/.test(trimmed)) return true;
  if (/authentication_error/i.test(trimmed)) return true;
  return /\b(api[ -]?key|x-api-key)\b[^.\n]{0,40}\b(invalid|abgelehnt|rejected|expired|revoked)\b|\b(invalid|expired|revoked)\b[^.\n]{0,24}\b(api[ -]?key|x-api-key)\b/i.test(
    trimmed,
  );
}

/**
 * Parse `candidate` as a whole and return it only when it is a non-null JSON
 * object. Anything else (parse failure, array, string, number, `null`) yields
 * `null` — the string is then treated as an application message, not envelope.
 */
function parseJsonObject(candidate: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Mine the human-readable sentence from a parsed provider envelope: prefer
 * `error.message`, then a top-level `message`. Returns `null` when neither
 * exists so the caller shows the translated generic fallback.
 */
function messageFromEnvelope(obj: Record<string, unknown>): string | null {
  const nested = obj.error;
  if (nested && typeof nested === 'object') {
    const message = (nested as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  const top = obj.message;
  if (typeof top === 'string' && top.trim()) return top.trim();
  return null;
}
