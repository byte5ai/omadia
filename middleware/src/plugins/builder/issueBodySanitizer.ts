/**
 * Issue-body sanitizer (concept plan: docs/plans/native-issue-reporting.md).
 *
 * Runs over the rendered body of a builder-generated GitHub issue before
 * the operator approves submission. Three responsibilities:
 *
 *   1. Secrets scanner — replace known credential patterns with
 *      `[REDACTED:<kind>]`. AWS keys, GitHub PATs, Slack tokens, generic
 *      `Authorization: Bearer …`, email addresses, IBANs.
 *   2. URL redactor — replace non-public hosts (`*.internal`, RFC1918
 *      IPs, `localhost`) with `[REDACTED:internal-url]`.
 *   3. Hard size limit — truncate at 64 KB and append a marker so the
 *      operator never silently ships a 200 KB body they did not preview.
 *
 * The output is the body the operator sees in the approval modal
 * alongside a "I have reviewed this body and confirm no confidential
 * data is included" checkbox. The sanitizer reduces the surface area of
 * what the operator has to catch by eye; it does NOT replace operator
 * review.
 *
 * Patterns are intentionally conservative — a false positive (over-
 * redaction) only mangles the bug report, while a false negative
 * (leaked secret) leaks data into a public repo. When in doubt,
 * redact.
 */

export type SecretKind =
  | 'aws-access-key'
  | 'github-pat'
  | 'slack-token'
  | 'bearer-token'
  | 'email'
  | 'iban'
  | 'internal-url';

export interface Redaction {
  kind: SecretKind;
  /** Character offset of the original match in the raw input. */
  index: number;
  length: number;
}

export interface SanitizeResult {
  body: string;
  redactions: Redaction[];
  truncated: boolean;
  truncatedBytes: number;
}

export interface SanitizerOptions {
  /** Maximum body size in bytes. Default 64 KB. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024;

interface Pattern {
  kind: SecretKind;
  regex: RegExp;
}

// Order matters: more specific patterns first so a generic "bearer-token"
// regex does not eat a longer "github-pat" match.
const PATTERNS: Pattern[] = [
  // AWS access key id: `AKIA` + 16 uppercase/digit chars.
  { kind: 'aws-access-key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  // GitHub PATs — both classic and fine-grained.
  {
    kind: 'github-pat',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  },
  // Slack tokens (bot, user, refresh, app, etc.).
  {
    kind: 'slack-token',
    regex: /\bxox[abprsoe]-[A-Za-z0-9-]{10,}\b/g,
  },
  // Generic `Authorization: Bearer <token>` — case-insensitive header form.
  {
    kind: 'bearer-token',
    regex: /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  },
  // Email addresses. We intentionally redact ALL emails — operator notes
  // often include customer emails or "send to alice@…" patterns.
  {
    kind: 'email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  // IBANs — 2-letter country + 2 check digits + 11-30 alphanumerics. Allow
  // spaces in groups of four for the printed form. Anchored on word boundary.
  {
    kind: 'iban',
    regex: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}\s?[A-Z0-9]{1,4}\b/g,
  },
];

// Internal-URL redaction is a second pass because we want to keep the
// scheme intact in the redaction marker so the reader knows what was
// stripped (URL vs. credential).
const INTERNAL_URL_REGEX =
  /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|(?:[A-Za-z0-9-]+\.)+(?:internal|local|lan|intranet|corp))(?::\d+)?(?:\/[^\s"'<>)]*)?/g;

const TRUNCATION_MARKER_TEMPLATE = (bytes: number) =>
  `\n\n[…] ${String(bytes)} bytes truncated by sanitizer. Re-run the report ` +
  `with a smaller spec snapshot if the missing context matters.`;

/**
 * Sanitize an issue body. Always succeeds; sanitization failures
 * (malformed regex, etc.) would surface as redaction misses, not
 * exceptions.
 */
export function sanitizeIssueBody(
  raw: string,
  opts: SanitizerOptions = {},
): SanitizeResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const redactions: Redaction[] = [];
  let body = raw ?? '';

  for (const { kind, regex } of PATTERNS) {
    body = body.replace(regex, (match, offset: number) => {
      redactions.push({ kind, index: offset, length: match.length });
      return `[REDACTED:${kind}]`;
    });
  }

  body = body.replace(INTERNAL_URL_REGEX, (match, offset: number) => {
    redactions.push({ kind: 'internal-url', index: offset, length: match.length });
    return `[REDACTED:internal-url]`;
  });

  const encoder = new TextEncoder();
  const encoded = encoder.encode(body);
  let truncated = false;
  let truncatedBytes = 0;
  if (encoded.length > maxBytes) {
    truncatedBytes = encoded.length - maxBytes;
    // Decode the first `maxBytes` bytes back to a string. Use a
    // `fatal: false` decoder so we tolerate splitting a multi-byte char.
    const decoder = new TextDecoder('utf-8', { fatal: false });
    body = decoder.decode(encoded.slice(0, maxBytes));
    body = body + TRUNCATION_MARKER_TEMPLATE(truncatedBytes);
    truncated = true;
  }

  return { body, redactions, truncated, truncatedBytes };
}

/**
 * Convenience helper: returns true when the sanitizer made at least one
 * redaction OR truncated the body. Used by the approval modal to nudge
 * the operator to re-read the preview.
 */
export function hasSensitiveContent(result: SanitizeResult): boolean {
  return result.redactions.length > 0 || result.truncated;
}
