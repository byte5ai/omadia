/**
 * Per-session tokenise-map.
 *
 * In-memory `Map<originalValue, token>` scoped to a single chat session.
 * Same value within the same session always gets the same token, so an
 * email mentioned twice does not look like two different addresses to
 * the LLM (which would damage cross-reference coherence in the answer).
 *
 * Slice 2.4 hardens this:
 *   - AES-256 in-memory encryption of the original values
 *   - Conversation-scoped lifetime with 15-min idle TTL
 *   - Explicit destroy on `session.end`
 *
 * Slice 2.2 (Option B): tokens carry an inline type suffix
 * (`tok_<8 hex>_<type>`) so the LLM can infer the kind of placeholder
 * (name / email / iban / …) without seeing the value. This is what
 * stops the public LLM from defensively asking "wer ist tok_a3f9?"
 * when the user typed a real employee name. The type is derived from
 * the detector hit (`pii.email` → `email`, `pii.name` → `name`,
 * `business.contract_clause` → `contract_clause`, …) and kept short
 * (max 20 chars, lowercase, [a-z0-9_]).
 *
 * Privacy property: the type is information the user already disclosed
 * by entering the value (they typed an email, so the LLM seeing "this
 * is an email-shaped token" reveals nothing new). The token's hex
 * portion remains the unique identity carrier; suffixes do not leak
 * across map entries.
 */

import { randomBytes } from 'node:crypto';

export interface TokenizeMap {
  /** Get an existing token for `value` if present, else mint a new one
   *  and remember the binding. Always returns the same token for the
   *  same value within one map. The optional `typeHint` tags the minted
   *  token with a short type suffix (`name`, `email`, …) so the LLM
   *  can recognise the placeholder kind. Re-using an existing value
   *  always returns the previously-minted token regardless of the
   *  typeHint passed on the second call — mapping is by value only. */
  tokenFor(value: string, typeHint?: string): string;
  /** Look up the original value behind a token. `undefined` for unknown
   *  tokens so the caller can decide between leave-as-is (Slice 2 inbound
   *  restore policy) and erroring. */
  resolve(token: string): string | undefined;
  /** Drop all bindings; safe to call on an already-empty map. Slice 1b
   *  uses this in tests; the orchestrator will call it at turn-end in
   *  Slice 2. */
  clear(): void;
  /** Number of unique values currently mapped. Test-only convenience. */
  readonly size: number;
}

/**
 * Token format: `tok_<8 hex>_<type suffix>`.
 *
 * Suffix is `[a-z0-9_]+` capped to a small length budget. Word
 * boundaries on either side keep the regex from over-matching when a
 * token sits next to non-word characters (period, comma, paren, …).
 *
 * Backwards-compat note: pre-Slice-2.2 sessions emitted bare
 * `tok_<8 hex>` tokens. The new regex does NOT match those, which is
 * fine — sessions are session-scoped and a fresh boot mints fresh
 * tokens. Production rollout simply happens after a deploy.
 */
export const TOKEN_REGEX = /\btok_[0-9a-f]{8}_[a-z0-9_]{1,30}\b/g;

/** Cheap detector: does this string look like one of our tokens? Used
 *  by Slice 2's inbound-restore + hallucination re-scan. */
export function isToken(s: string): boolean {
  return /^tok_[0-9a-f]{8}_[a-z0-9_]{1,30}$/.test(s);
}

/**
 * Slice 2.2: derive a short, LLM-readable suffix from a detector hit
 * type. `pii.email` → `email`, `pii.credit_card` → `credit_card`,
 * `business.contract_clause` → `contract_clause`. Unknown / falsy
 * types collapse to `value`.
 *
 * Length is capped at 20 chars; the regex enforces a 30-char ceiling
 * but staying well under that keeps surface text readable.
 */
export function sanitizeTypeHint(typeHint: string | undefined): string {
  if (typeHint === undefined || typeHint.length === 0) return 'value';
  // Strip the namespace prefix (everything up to and including the
  // first `.`). Then lowercase and keep only [a-z0-9_].
  const dot = typeHint.indexOf('.');
  const tail = dot >= 0 ? typeHint.slice(dot + 1) : typeHint;
  const cleaned = tail.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (cleaned.length === 0) return 'value';
  return cleaned.slice(0, 20);
}

class InMemoryTokenizeMap implements TokenizeMap {
  private readonly forward = new Map<string, string>();
  private readonly reverse = new Map<string, string>();

  tokenFor(value: string, typeHint?: string): string {
    const existing = this.forward.get(value);
    if (existing !== undefined) return existing;
    const token = mintToken(typeHint);
    this.forward.set(value, token);
    this.reverse.set(token, value);
    return token;
  }

  resolve(token: string): string | undefined {
    return this.reverse.get(token);
  }

  clear(): void {
    this.forward.clear();
    this.reverse.clear();
  }

  get size(): number {
    return this.forward.size;
  }
}

export function createTokenizeMap(): TokenizeMap {
  return new InMemoryTokenizeMap();
}

function mintToken(typeHint?: string): string {
  const suffix = sanitizeTypeHint(typeHint);
  return `tok_${randomBytes(4).toString('hex')}_${suffix}`;
}
