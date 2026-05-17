/**
 * Per-turn tokenise-map (Privacy-Shield v2, Slice S-2).
 *
 * In-memory `Map<originalValue, token>` scoped to a single orchestrator
 * turn. Same value within the same map always returns the same token,
 * so an email mentioned twice within one turn does not look like two
 * different addresses to the LLM — intra-turn cross-reference coherence
 * in the answer stays intact. Across turns, tokens are NOT preserved:
 * coherence comes from the assistant-tail (real values after restore),
 * not from stable token names.
 *
 * Lifecycle:
 *   - The service mints a map on the first `processOutbound` /
 *     `processToolResult` call of a turn.
 *   - The map is shared between outbound, tool-input, tool-result and
 *     inbound calls of the SAME turn — that's what gives intra-turn
 *     reconciliation (a name from the user prompt and the same name
 *     from a tool result get the same token).
 *   - `finalizeTurn(turnId)` drops the map together with the
 *     accumulator. After that the PII bindings are eligible for GC.
 *
 * Token format (Privacy-Shield v2):
 *
 *   «TYPE_N»  — French guillemets wrap an uppercase display type and a
 *               fortlaufende counter, both unique within the map.
 *
 *   Examples: «PERSON_1», «EMAIL_2», «IBAN_3», «CONTRACT_CLAUSE_4».
 *
 * Why this format (vs. the v1 `tok_<8 hex>_<type>`):
 *
 *   - LLM-friendly: «PERSON_3» reads like a normal table-cell value, so
 *     under Markdown-table or bulleted-list output pressure the model
 *     keeps the token verbatim instead of paraphrasing it into an
 *     invented name (the 2026-05-14 HR-routine failure mode).
 *   - Regex-unambiguous: French guillemets (U+00AB / U+00BB) do not
 *     appear in normal German or English text, so the restore regex
 *     never over- or under-matches.
 *   - Type-hint readable: PERSON / EMAIL / IBAN / ADDRESS / CARD /
 *     APIKEY surfaces the kind of value without exposing the value.
 *   - Counter aids audit: ordering in the output corresponds to
 *     ordering in the detection pass.
 *
 * Privacy property: the type carries information the user already
 * disclosed by entering the value (typing an email reveals that the
 * shape is an email); revealing it as a type-label to the LLM adds no
 * new disclosure beyond what the user already chose. The counter is
 * map-local and carries no cross-session identity.
 */

export interface TokenizeMap {
  /** Get an existing token for `value` if present, else mint a new one
   *  and remember the binding. Always returns the same token for the
   *  same value within one map — mapping is by value only; the
   *  `typeHint` only steers the initial mint and is ignored on
   *  subsequent lookups. */
  tokenFor(value: string, typeHint?: string): string;
  /** Look up the original value behind a token. `undefined` for unknown
   *  tokens so the caller can decide what to do (Output Validator
   *  flags hallucinated tokens, restoreTokens leaves them in place). */
  resolve(token: string): string | undefined;
  /** Privacy-Shield v2 (Slice S-5): reverse predicate used by the
   *  Output Validator to distinguish "PII the LLM produced spontaneously"
   *  from "PII that came back via token-restore". Returns `true` iff
   *  the value was ever tokenised in this map. */
  hasOriginalValue(value: string): boolean;
  /** Drop all bindings; safe to call on an already-empty map. */
  clear(): void;
  /** Number of unique values currently mapped. Also the count of
   *  distinct tokens minted this turn — used by the Output Validator
   *  as the denominator for the token-loss ratio. */
  readonly size: number;
}

/**
 * Token format regex: `«` + uppercase letters + optional `_`-separated
 * uppercase tail + `_` + counter + `»`.
 *
 * Examples that match: «PERSON_1», «EMAIL_42», «CREDIT_CARD_3».
 * Examples that don't match: «person_1», «PERSON», «PERSON_», «PERSON 1».
 *
 * Backwards-compat note: v1 emitted `tok_<8 hex>_<type>` tokens. The new
 * regex does NOT match those — token maps are turn-scoped and a fresh
 * boot has no in-flight v1 tokens. The fast-reject in `restoreTokens`
 * switches from `'tok_'` to `'«'` accordingly.
 */
export const TOKEN_REGEX = /«[A-Z][A-Z_]*_\d+»/g;

/** Cheap detector: does this string look like one of our tokens? */
export function isToken(s: string): boolean {
  return /^«[A-Z][A-Z_]*_\d+»$/.test(s);
}

/**
 * Map a detector hit type (e.g. `pii.name`, `pii.credit_card`,
 * `business.contract_clause`) to the uppercase display name that
 * appears inside the token wrapper.
 *
 * Known PII classes are mapped to short, memorable names (PERSON,
 * EMAIL, …). Unknown types collapse to a cleaned uppercase form of
 * their namespace tail, which keeps audit information legible while
 * staying within the regex grammar.
 *
 * Length is capped at 30 chars so the token wrapper stays compact in
 * Markdown-table cells. Empty / malformed input falls back to `PII`.
 */
export function displayTypeFor(typeHint: string | undefined): string {
  if (typeHint === undefined || typeHint.length === 0) return 'PII';

  // Strip namespace prefix: keep only the tail after the first `.`.
  const dot = typeHint.indexOf('.');
  const tail = dot >= 0 ? typeHint.slice(dot + 1) : typeHint;

  const cleaned = tail
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (cleaned.length === 0) return 'PII';

  const mapped = KNOWN_TYPE_DISPLAY[cleaned] ?? cleaned;
  return mapped.slice(0, 30);
}

/** Canonical short display names for known PII classes. Unknown
 *  classes pass through as their cleaned-uppercase form. */
const KNOWN_TYPE_DISPLAY: Readonly<Record<string, string>> = {
  NAME: 'PERSON',
  PERSON: 'PERSON',
  EMAIL: 'EMAIL',
  EMAIL_ADDRESS: 'EMAIL',
  PHONE: 'PHONE',
  PHONE_DE: 'PHONE',
  PHONE_NUMBER: 'PHONE',
  IBAN: 'IBAN',
  IBAN_CODE: 'IBAN',
  CREDIT_CARD: 'CARD',
  CARD: 'CARD',
  ADDRESS: 'ADDRESS',
  LOCATION: 'ADDRESS',
  GPE: 'ADDRESS',
  ORGANIZATION: 'ORG',
  ORG: 'ORG',
  API_KEY: 'APIKEY',
  APIKEY: 'APIKEY',
  IP_ADDRESS: 'IP',
  IP: 'IP',
  CRYPTO_ADDRESS: 'CRYPTO',
  CRYPTO: 'CRYPTO',
  SSN: 'SSN',
};

class InMemoryTokenizeMap implements TokenizeMap {
  private readonly forward = new Map<string, string>();
  private readonly reverse = new Map<string, string>();
  /** Per-display-type fortlaufende counter. `«PERSON_1»`, `«PERSON_2»`,
   *  but `«EMAIL_1»` starts independently — readability over global
   *  ordering. */
  private readonly counters = new Map<string, number>();

  tokenFor(value: string, typeHint?: string): string {
    const existing = this.forward.get(value);
    if (existing !== undefined) return existing;
    const type = displayTypeFor(typeHint);
    const next = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, next);
    const token = `«${type}_${String(next)}»`;
    this.forward.set(value, token);
    this.reverse.set(token, value);
    return token;
  }

  resolve(token: string): string | undefined {
    return this.reverse.get(token);
  }

  hasOriginalValue(value: string): boolean {
    return this.forward.has(value);
  }

  clear(): void {
    this.forward.clear();
    this.reverse.clear();
    this.counters.clear();
  }

  get size(): number {
    return this.forward.size;
  }
}

export function createTokenizeMap(): TokenizeMap {
  return new InMemoryTokenizeMap();
}
