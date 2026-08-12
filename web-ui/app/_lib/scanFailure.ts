/**
 * OM-26 — keep provider internals out of the UI.
 *
 * A customer saw this rendered in the skill editor:
 *
 *   Tiefen-Scan-Hinweis: llm completion failed: 401 {"type":"error","error":
 *   {"type":"authentication_error","message":"invalid x-api-key"},
 *   "request_id":"req_011CdcPnpMTB8iyAmMBnbem8"}
 *
 * Two separate problems: the message was unusable (it never says "your API key
 * is wrong, fix it here"), and it exposed a provider-internal request id.
 *
 * The primary fix is server-side — `skillVerdictLlmVerifier` now stores a code
 * instead of the raw payload, and logs the detail server-side only, while the
 * skill read path scrubs rows that were persisted BEFORE that change
 * (`middleware/src/services/providerInternalsRedaction.ts`). This module is the
 * client half: it maps that code to localized copy, and — for the error paths
 * that still surface a raw `ApiError.body`, which never goes through the
 * verdict read path at all — scrubs the recognisable provider-internal tokens
 * as the last line of defence. `REDACTIONS` below mirrors the middleware list;
 * change one, change both.
 */

/** Mirrors `SCAN_FAILED_CODE_PREFIX` in the middleware verifier. */
const SCAN_FAILED_CODE_PREFIX = 'scan_failed:';

/**
 * Failure codes the middleware can store in a `scan_failed` rationale. Keep in
 * sync with `ScanFailedCode` in
 * `middleware/src/services/skillVerdictLlmVerifier.ts`.
 */
export const SCAN_FAILURE_CODES = [
  'auth',
  'rate_limit',
  'overloaded',
  'provider_error',
  'timeout',
  'malformed_json',
  'unsupported_severity',
  'missing_rationale',
  'unexpected',
] as const;

export type ScanFailureCode = (typeof SCAN_FAILURE_CODES)[number];

/**
 * Extract the machine code from a rationale, or null when the rationale is a
 * genuine free-text LLM judgment (the normal, successful case).
 */
export function parseScanFailureCode(
  rationale: string | null | undefined,
): ScanFailureCode | null {
  if (!rationale?.startsWith(SCAN_FAILED_CODE_PREFIX)) return null;
  const code = rationale.slice(SCAN_FAILED_CODE_PREFIX.length).trim();
  return (SCAN_FAILURE_CODES as readonly string[]).includes(code)
    ? (code as ScanFailureCode)
    : null;
}

/**
 * Patterns for provider-internal identifiers that must never be shown. These
 * are correlation handles and credentials — meaningless to the operator, and a
 * liability the moment the text is pasted into a support thread or an issue.
 */
const INTERNAL_ID_NAMES =
  '(?:x-)?(?:request[-_]?id|requestid|trace[-_]?id|traceid|correlation[-_]?id|correlationid|cf-ray)';

const REDACTIONS: ReadonlyArray<RegExp> = [
  // Correlation handles — `"request_id":"req_…"`, `x-request-id: abc`,
  // `"cf-ray":"8f3a…"`, `requestId=…` — in snake_case, kebab-case or camelCase,
  // as a JSON field or as a bare header/log line.
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
 * Strip provider-internal identifiers from a raw error string.
 *
 * This is NOT the primary defence — the server not sending them is. It exists
 * because several call sites render `ApiError.body` verbatim, and a raw body is
 * whatever an upstream chose to put in it.
 */
export function redactProviderInternals(raw: string): string {
  return REDACTIONS.reduce(
    (text, pattern) => text.replace(pattern, REDACTED),
    raw,
  );
}

/** Longest raw detail we are willing to put on screen, even inside a details. */
const MAX_DETAIL_CHARS = 600;

/**
 * Turn any thrown value into a redacted, length-capped string suitable for the
 * "Details für den Support" disclosure. Never used as the primary message.
 */
export function supportDetail(err: unknown): string {
  const raw =
    typeof err === 'string'
      ? err
      : err instanceof Error
        ? ((err as { body?: string }).body ?? err.message)
        : String(err);
  const redacted = redactProviderInternals(raw);
  return redacted.length > MAX_DETAIL_CHARS
    ? `${redacted.slice(0, MAX_DETAIL_CHARS)}…`
    : redacted;
}
