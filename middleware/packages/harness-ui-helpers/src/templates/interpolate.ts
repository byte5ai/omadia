/**
 * Safe path-interpolation for item-template expressions (B.12).
 *
 * Templates use a `${path.to.field}` syntax and are evaluated against a
 * scope-object (e.g. `{ item }` when rendering a list of items). Resolution
 * rules:
 *
 *   - Each `${...}` body is parsed as a dot-separated path:
 *     `${item.title}` → `scope.item.title`
 *     `${item.repo.name}` → `scope.item.repo.name`
 *
 *   - Whitelisted method-suffixes (no eval, no arbitrary calls):
 *     `.join("…")` on arrays — `${item.labels.join(", ")}`
 *     `.toLocaleString()` on numbers/dates — `${item.amount.toLocaleString()}`
 *
 *   - Missing paths resolve to `''` (empty string) instead of `'undefined'`.
 *
 *   - All resolved values are HTML-escaped via the same escape table used
 *     by the `html` tagged-template. XSS guarantee: even if `item.title`
 *     contains `<script>`, the output is `&lt;script&gt;`.
 *
 *   - Function-call syntax outside the whitelist (`${foo()}`, `${obj.run()}`)
 *     resolves to `''` — codegen + lint should never produce such templates,
 *     but we degrade gracefully rather than throwing at render-time.
 *
 * NOTE: this is NOT a general-purpose template engine. It is intentionally
 * narrow so the LLM (or operator) cannot smuggle arbitrary JS into an
 * item-template field. For free-form HTML, use the `free-form-html`
 * render-mode instead.
 */

import { escapeHtml } from '../html.js';

const TEMPLATE_RE = /\$\{([^}]+)\}/g;
const PATH_TOKEN_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
const JOIN_SUFFIX_RE = /\.join\((['"])([^'"]*)\1\)$/;
const TOLOCALESTRING_SUFFIX = '.toLocaleString()';

export interface InterpolateOptions {
  /** Scope object whose top-level keys are referenced from the template
   *  (e.g. `{ item }` to enable `${item.title}`). */
  readonly scope: Record<string, unknown>;
}

/**
 * Resolve a single `${path}` expression body (the part between the braces)
 * against the scope. Returns a string, already HTML-escaped where the value
 * is user-controlled. Whitelisted method suffixes are applied BEFORE escape.
 *
 * Exported for testing; production code uses `interpolate()`.
 */
export function resolveExpression(
  body: string,
  scope: Record<string, unknown>,
): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return '';

  // --- Whitelisted method suffixes ---
  // .join("…") — array → joined string
  const joinMatch = JOIN_SUFFIX_RE.exec(trimmed);
  if (joinMatch) {
    const pathPart = trimmed.slice(0, trimmed.length - joinMatch[0].length);
    const separator = joinMatch[2] ?? '';
    const value = lookupPath(pathPart, scope);
    if (!Array.isArray(value)) return '';
    return escapeHtml(value.map((v) => String(v ?? '')).join(separator));
  }

  // .toLocaleString() — number/date → locale-string
  if (trimmed.endsWith(TOLOCALESTRING_SUFFIX)) {
    const pathPart = trimmed.slice(0, trimmed.length - TOLOCALESTRING_SUFFIX.length);
    const value = lookupPath(pathPart, scope);
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return escapeHtml(value.toLocaleString());
    if (value instanceof Date) return escapeHtml(value.toLocaleString());
    return escapeHtml(String(value));
  }

  // Reject anything with parentheses that didn't match the whitelist —
  // defends against `${run()}`, `${obj.method(arg)}`, etc.
  if (trimmed.includes('(') || trimmed.includes(')')) return '';

  // Plain path lookup
  const value = lookupPath(trimmed, scope);
  if (value === null || value === undefined) return '';
  return escapeHtml(String(value));
}

/**
 * Looks up `path` (e.g. `item.repo.name`) against `scope`. Returns
 * `undefined` on any failure (non-existent key, intermediate null, malformed
 * path). Never throws. Each path segment must match a strict identifier
 * regex — guards against bracket-syntax or quoted-segment injection.
 */
function lookupPath(path: string, scope: Record<string, unknown>): unknown {
  const trimmed = path.trim();
  if (trimmed.length === 0) return undefined;
  const segments = trimmed.split('.');
  let current: unknown = scope;
  for (const seg of segments) {
    if (!PATH_TOKEN_RE.test(seg)) return undefined;
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/**
 * Interpolate every `${...}` in `template` against `scope`. Literal
 * characters between expressions are passed through verbatim and ARE NOT
 * escaped — the assumption is that the template comes from the spec
 * (operator-authored), not from user content. Item data flowing through
 * `${...}` IS escaped.
 *
 * Returns a plain string (caller wraps in `safe()` if needed).
 */
export function interpolate(template: string, opts: InterpolateOptions): string {
  if (template.length === 0) return '';
  return template.replace(TEMPLATE_RE, (_match, body: string) =>
    resolveExpression(body, opts.scope),
  );
}
