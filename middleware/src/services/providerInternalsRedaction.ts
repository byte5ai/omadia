/**
 * OM-26 — one scrubber for provider-internal identifiers, used on BOTH the
 * write path and the read path.
 *
 * A customer saw this rendered in the skill editor:
 *
 *   Tiefen-Scan-Hinweis: llm completion failed: 401 {"type":"error","error":
 *   {"type":"authentication_error","message":"invalid x-api-key"},
 *   "request_id":"req_011CdcPnpMTB8iyAmMBnbem8"}
 *
 * `skillVerdictLlmVerifier` no longer *writes* payloads like that: failures are
 * persisted as a `scan_failed:<code>` sentinel and the raw error is logged
 * server-side only. But rows persisted BEFORE that fix still hold the raw JSON,
 * and the read path served them unchanged. Redacting at render time in the
 * web-ui is too late — by then the `request_id` is already in the HTTP response
 * body, in devtools, and in whatever client-side error reporter is installed.
 *
 * So this runs server-side on the way out as well. The web-ui keeps its own
 * copy (`web-ui/app/_lib/scanFailure.ts`) as the last line of defence for the
 * error paths that render a raw `ApiError.body`; the two pattern lists are
 * deliberately kept in agreement.
 */

/**
 * Field/header names that carry a provider-internal correlation handle. They
 * are meaningless to the operator and a liability the moment the text is
 * pasted into a support thread or a public issue.
 *
 * Written as one alternation so both the JSON shape (`"request_id":"…"`) and
 * the header/log shape (`x-request-id: …`) are covered by a single pattern,
 * with or without an `x-` prefix and in snake_case, kebab-case or camelCase.
 */
const INTERNAL_ID_NAMES =
  '(?:x-)?(?:request[-_]?id|requestid|trace[-_]?id|traceid|correlation[-_]?id|correlationid|cf-ray)';

/**
 * Patterns for provider-internal identifiers that must never reach the client.
 * Keep in sync with `REDACTIONS` in `web-ui/app/_lib/scanFailure.ts`.
 */
const REDACTIONS: readonly RegExp[] = [
  // `"request_id": "req_…"`, `x-request-id: abc`, `"cf-ray":"8f3a…"`, …
  new RegExp(`"?\\b${INTERNAL_ID_NAMES}\\b"?\\s*[:=]\\s*(?:"[^"]*"|[A-Za-z0-9_.:-]+)`, 'gi'),
  // Bare Anthropic-style request ids, even without their field name.
  /\breq_[A-Za-z0-9]{6,}\b/g,
  // Anything that looks like an API key.
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /"(?:x-)?api[-_]?key"\s*:\s*"[^"]*"/gi,
];

/** Replacement marker. Deliberately not localized — it is a redaction mark. */
const REDACTED = '[redacted]';

/**
 * Strip provider-internal identifiers from an arbitrary string.
 *
 * Deliberately a *token* scrubber, not a payload filter. It is the right tool
 * for text that is mostly legitimate (a free-text LLM rationale, an
 * `ApiError.body` shown behind a "details for support" disclosure) and the
 * WRONG tool for a raw provider error payload — masking `request_id` there
 * still leaves `x-api-key` and `authentication_error` behind. Whole raw
 * payloads are handled by `sanitizeVerdictRationale` in
 * `skillVerdictLlmVerifier.ts`, which replaces them outright.
 */
export function redactProviderInternals(raw: string): string {
  return REDACTIONS.reduce((text, pattern) => text.replace(pattern, REDACTED), raw);
}
