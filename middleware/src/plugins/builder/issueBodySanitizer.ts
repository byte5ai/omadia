/**
 * Issue-body sanitizer.
 *
 * Runs over the rendered body of a builder-generated GitHub issue before
 * the operator approves submission. Three responsibilities:
 *
 *   1. Secrets scanner — replace known credential patterns with
 *      `[REDACTED:<kind>]`. Anthropic / OpenAI keys, AWS keys, GitHub PATs,
 *      Slack tokens, JWTs, generic `Authorization: Bearer …`,
 *      `key=` / `token=` / `password=` values (the key stays, #1783), email
 *      addresses, IBANs, and absolute home-directory paths.
 *   2. URL redactor — replace non-public hosts (`*.internal`, RFC1918
 *      IPs, link-local / cloud-metadata `169.254.*`, `localhost`) with
 *      `[REDACTED:internal-url]`.
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
  | 'anthropic-key'
  | 'openai-key'
  | 'jwt'
  | 'secret-value'
  | 'home-path'
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
  // Anthropic keys (`sk-ant-api03-…`, `sk-ant-admin01-…`) before the
  // generic OpenAI-style `sk-` form.
  { kind: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  // OpenAI keys: `sk-…`, `sk-proj-…`, `sk-svcacct-…`.
  { kind: 'openai-key', regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  // JWTs: three base64url segments, the first one a JSON header (`eyJ`).
  {
    kind: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
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

// `api_key=…`, `token: …`, `password=…` — only the value goes; the key
// stays so the report still says which setting was involved (#1783).
const SECRET_VALUE_REGEX =
  /\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|apikey|access[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|password|passwd|pwd)\b["']?\s*[=:]\s*)(["']?)(?!\[REDACTED:)([^\s"'&,;)\]}]{4,})\2/gi;

// Absolute home-directory paths name the operator's account and machine
// layout: `/Users/<name>/…`, `/home/<name>/…`, `/root/…`, `C:\Users\<name>\…`.
const HOME_PATH_REGEX =
  /(?:\/(?:Users|home)\/[^\s/"'`]+|\/root(?=\/)|\b[A-Za-z]:\\Users\\[^\s\\"'`]+)/g;

// Internal-URL redaction is a second pass because we want to keep the
// scheme intact in the redaction marker so the reader knows what was
// stripped (URL vs. credential).
const INTERNAL_URL_REGEX =
  /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|169\.254(?:\.\d{1,3}){2}|10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|(?:[A-Za-z0-9-]+\.)+(?:internal|local|lan|intranet|corp))(?::\d+)?(?:\/[^\s"'<>)]*)?/g;

const LINK_LOCAL_IP_REGEX = /\b169\.254\.\d{1,3}\.\d{1,3}\b/g;

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

  body = body.replace(
    SECRET_VALUE_REGEX,
    (match: string, key: string, quote: string, value: string, offset: number) => {
      redactions.push({ kind: 'secret-value', index: offset + key.length + quote.length, length: value.length });
      return `${key}${quote}[REDACTED:secret-value]${quote}`;
    },
  );

  body = body.replace(INTERNAL_URL_REGEX, (match, offset: number) => {
    redactions.push({ kind: 'internal-url', index: offset, length: match.length });
    return `[REDACTED:internal-url]`;
  });

  // A bare link-local / cloud-metadata address outside a URL.
  body = body.replace(LINK_LOCAL_IP_REGEX, (match, offset: number) => {
    redactions.push({ kind: 'internal-url', index: offset, length: match.length });
    return `[REDACTED:internal-url]`;
  });

  body = body.replace(HOME_PATH_REGEX, (match, offset: number) => {
    redactions.push({ kind: 'home-path', index: offset, length: match.length });
    return `[REDACTED:home-path]`;
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

/** GitHub caps issue titles at 256 characters. */
const MAX_TITLE_CHARS = 256;

/**
 * #1783 — the title goes to the same public repo as the body (confirm card,
 * `issues/new?title=…`, the create-issue route), so it gets the same
 * redaction, on one line and within GitHub's length cap.
 */
export function sanitizeIssueTitle(raw: string): { title: string; redactions: Redaction[] } {
  const oneLine = (raw ?? '').replace(/\s+/g, ' ').trim();
  const { body, redactions } = sanitizeIssueBody(oneLine);
  return { title: body.slice(0, MAX_TITLE_CHARS), redactions };
}
