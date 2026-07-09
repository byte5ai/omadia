/**
 * Provider errors reach the chat surfaces as a raw string that wraps the one
 * sentence a user can act on in transport noise: a leading HTTP status
 * ("429 ..."), and — for JSON-bodied providers like Anthropic — the full
 * response envelope. `extractProviderErrorMessage` peels both away and returns
 * the embedded human-readable message, provider-agnostic (works for the OpenAI
 * plain-text shape and the Anthropic JSON shape alike).
 *
 * It is deliberately a no-op on strings that are already clean: an input with
 * no status prefix and no JSON envelope is returned unchanged, so the builder's
 * own human-readable error events (e.g. `builder.paused_on_issue`) pass through
 * untouched. It returns `null` only when the string looks like a wrapped
 * provider error yet carries no message we can surface — that is the caller's
 * cue to fall back to a translated generic notice.
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
    // A JSON envelope we can't pull a message from is unusable noise.
    return null;
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
