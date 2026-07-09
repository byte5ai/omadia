/**
 * Provider errors reach the chat surfaces as a raw string that wraps the one
 * sentence a user can act on in transport noise: a leading HTTP status
 * ("429 ..."), and — for JSON-bodied providers like Anthropic — the full
 * response envelope. `extractProviderErrorMessage` peels both away and returns
 * the embedded human-readable message, provider-agnostic (works for the OpenAI
 * plain-text shape and the Anthropic JSON shape alike).
 *
 * A leading 3-digit HTTP status is the only reliable evidence that a string is a
 * wrapped transport error rather than an application message. The function keys
 * its "give up" behaviour on that fact:
 *
 *   - Empty / whitespace input returns `null`.
 *   - A JSON envelope is mined for `error.message`, then a top-level `message`;
 *     a match is returned whether or not a status prefix was present.
 *   - When nothing surfaceable can be pulled out, a status-prefixed input
 *     returns `null` (it IS a wrapped provider error carrying no message — the
 *     caller shows the generic fallback), while an input with no status prefix
 *     is returned unchanged. A string with no status prefix is treated as an
 *     application message, braces or not, and is never destroyed — so the
 *     builder's own human-readable events (e.g. `builder.paused_on_issue`) and
 *     brace-bearing diagnostics pass through untouched.
 */
export function extractProviderErrorMessage(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Strip a leading HTTP status ("429 ...", "400 ...").
  const withoutStatus = trimmed.replace(/^\d{3}\s+/, '');
  const hadStatus = withoutStatus !== trimmed;

  // Anthropic-style: a JSON envelope carries the sentence under `error.message`
  // (or a top-level `message`).
  const jsonStart = withoutStatus.indexOf('{');
  const jsonEnd = withoutStatus.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    const message = messageFromJson(withoutStatus.slice(jsonStart, jsonEnd + 1));
    if (message) return message;
    // A JSON envelope we can't pull a message from is only noise when a status
    // prefix marks it as a wrapped provider error; without one it is an
    // application message that merely contains braces — hand it back untouched.
    return hadStatus ? null : trimmed;
  }

  // OpenAI-style: plain-text sentence behind the status prefix.
  if (hadStatus) {
    return withoutStatus.length > 0 ? withoutStatus : null;
  }

  // No status, no JSON envelope: already a clean human string — pass through.
  return trimmed;
}

/**
 * Convenience wrapper for UI call sites: returns the extracted provider message
 * when one is present, otherwise the caller's translated generic fallback.
 */
export function humanizeProviderError(raw: string, fallback: string): string {
  return extractProviderErrorMessage(raw) ?? fallback;
}

function messageFromJson(candidate: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const nested = obj.error;
  if (nested && typeof nested === 'object') {
    const message = (nested as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  const top = obj.message;
  if (typeof top === 'string' && top.trim()) return top.trim();
  return null;
}
