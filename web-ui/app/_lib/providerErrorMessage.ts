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
 * Back-compat shim over {@link classifyProviderError} — older call sites and
 * tests ask the auth question directly.
 */
export function isProviderAuthError(raw: string): boolean {
  return classifyProviderError(raw) === 'auth';
}

/**
 * Provider failure classes a chat surface can say something USEFUL about, in
 * the user's language. Everything else stays `generic` and shows the
 * extracted provider sentence (still better than a shrug for the long tail).
 *
 *  - `auth`       — the stored key was rejected. User-fixable: the copy sends
 *                   them to Admin → LLM access ("Schlüssel testen").
 *  - `rate_limit` — the provider throttled the request. NOT user-fixable in
 *                   settings; the copy says retry shortly, no settings link.
 *  - `overloaded` — the provider itself is overloaded (Anthropic 529 /
 *                   `overloaded_error`). Same posture: wait and retry.
 *
 * Matched on SHAPE (status prefix, provider error-type marker, bounded phrase
 * proximity) — never full-sentence equality, which would break on the
 * provider's next wording change. Order matters: the status/type markers are
 * unambiguous, the phrase heuristics run last.
 */
export type ProviderErrorClass = 'auth' | 'rate_limit' | 'overloaded' | 'generic';

export function classifyProviderError(raw: string): ProviderErrorClass {
  const trimmed = raw.trim();
  if (!trimmed) return 'generic';
  if (/^401\b/.test(trimmed) || /authentication_error/i.test(trimmed)) {
    return 'auth';
  }
  // A quota/billing exhaustion also arrives as 429 (OpenAI's
  // `insufficient_quota`), but "wait and retry" would be WRONG advice there —
  // the account needs a billing action. Those keep the provider's own
  // sentence ("check your plan and billing details"), which is the accurate
  // next step. Only genuinely transient throttling classifies as rate_limit.
  if (/insufficient_quota|\bquota\b|\bbilling\b/i.test(trimmed)) {
    return 'generic';
  }
  if (/^429\b/.test(trimmed) || /rate_limit_error/i.test(trimmed)) {
    return 'rate_limit';
  }
  if (/^529\b/.test(trimmed) || /overloaded_error/i.test(trimmed)) {
    return 'overloaded';
  }
  if (
    /\b(api[ -]?key|x-api-key)\b[^.\n]{0,40}\b(invalid|abgelehnt|rejected|expired|revoked)\b|\b(invalid|expired|revoked)\b[^.\n]{0,24}\b(api[ -]?key|x-api-key)\b/i.test(
      trimmed,
    )
  ) {
    return 'auth';
  }
  if (/\brate limit\b|\bexceeded your rate\b/i.test(trimmed)) return 'rate_limit';
  if (/^overloaded\.?$/i.test(trimmed)) return 'overloaded';
  return 'generic';
}

/**
 * One resolver for every chat error surface: localized copy for the classes
 * we can improve on, the extracted provider sentence otherwise. `t` is the
 * caller's `chat`-namespace translator.
 */
export function resolveProviderErrorMessage(
  raw: string,
  t: (key: string) => string,
): string {
  switch (classifyProviderError(raw)) {
    case 'auth':
      return t('errorProviderAuth');
    case 'rate_limit':
      return t('errorProviderRateLimit');
    case 'overloaded':
      return t('errorProviderOverloaded');
    default:
      return humanizeProviderError(raw, t('errorProviderGeneric'));
  }
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
