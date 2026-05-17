/**
 * Pre-detector allowlist (Privacy-Shield v2, Slice S-3).
 *
 * Filters known-harmless spans out of the detector pipeline so they
 * never become tokens. Three sources contribute terms:
 *
 *   - **tenantSelf** — names, aliases, GF, address, domain, HRB-Nr.
 *     of the tenant itself (e.g. `byte5`, `byte5.de`, `byte5 GmbH`).
 *     Tokenising these on the wire to the public LLM is a category
 *     error: the tenant identity is by-construction known to the
 *     contract; masking it earns no privacy but loses the primary
 *     referent of every conversation.
 *
 *   - **repoDefault** — German office-/HR-domain topic-nouns shipped
 *     in `data/privacy-topic-nouns-de.json` (Urlaubsregeln,
 *     Arbeitszeiten, Reisekostenabrechnung, …). German compound nouns
 *     are systematically false-positive-tagged as PERSON / ORG /
 *     LOCATION by spaCy NER on short prompts; the allowlist removes
 *     the dominant FP class.
 *
 *   - **operatorOverride** — per-tenant additions via plugin config
 *     `extra_allowlist_terms` (JSON array). Lets operators extend the
 *     defaults for their domain (legal terminology, medical terms,
 *     internal project codenames) without forking the repo.
 *
 * Mechanics — span-filter, not text-mask:
 *
 *   - The allowlist scans the input text once per `transformOne` call
 *     and returns spans + sources.
 *   - The detector pool runs on the unmodified text (so coverage,
 *     latency and audit-hash semantics are unchanged).
 *   - After detection, detector hits whose span overlaps an allowlist
 *     span are dropped before policy applies. The receipt records
 *     the allowlist counts so the operator sees "X terms passed
 *     through" alongside the maskings.
 *
 * Privacy property: the allowlist is purely additive in the "pass
 * through" direction — it never expands what gets tokenised, only
 * what gets exempted. A misconfigured allowlist therefore degrades to
 * "more PII reaches the LLM" (which the operator OPTED INTO when they
 * added the term), never "PII falsely surfaced to the wrong actor".
 */

export type AllowlistSource = 'tenantSelf' | 'repoDefault' | 'operatorOverride';

export interface AllowlistMatch {
  /** Half-open [start, end) byte offsets in the scanned text. */
  readonly span: readonly [number, number];
  /** Which configured source contributed the matched term. Surfaced
   *  in the receipt's `allowlist.bySource` breakdown. */
  readonly source: AllowlistSource;
}

export interface Allowlist {
  /** Walk `text` once and return every allowlist hit in left-to-right
   *  order. Returns `[]` on empty input or when no terms are
   *  configured — the caller can branch on `length === 0` to skip
   *  the filter step entirely. */
  scan(text: string): readonly AllowlistMatch[];
}

export interface AllowlistConfig {
  readonly tenantSelfTerms?: readonly string[];
  readonly repoDefaultTerms?: readonly string[];
  readonly operatorOverrideTerms?: readonly string[];
}

const EMPTY_ALLOWLIST: Allowlist = { scan: () => [] };

/**
 * Build an allowlist from the three configured sources.
 *
 * Terms are normalised to lowercase for matching (case-insensitive
 * comparison against the input). Empty / whitespace-only terms are
 * silently dropped. If the same term appears in multiple sources,
 * the priority is `tenantSelf` > `operatorOverride` > `repoDefault` —
 * the most specific source wins so the receipt attribution is stable.
 *
 * Returns a no-op allowlist when all three sources are empty so the
 * caller incurs no scan cost.
 */
export function createAllowlist(config: AllowlistConfig): Allowlist {
  // Source priority: later writes override earlier (we insert from
  // lowest to highest priority).
  const lookup = new Map<string, AllowlistSource>();
  addTerms(lookup, config.repoDefaultTerms, 'repoDefault');
  addTerms(lookup, config.operatorOverrideTerms, 'operatorOverride');
  addTerms(lookup, config.tenantSelfTerms, 'tenantSelf');

  if (lookup.size === 0) return EMPTY_ALLOWLIST;

  // Longest-first alternation: regex picks the first matching
  // alternative without backtracking, so sorting by descending length
  // guarantees that "Urlaubsregeln" wins over "Urlaub" when both are
  // configured.
  const sortedKeys = [...lookup.keys()].sort((a, b) => b.length - a.length);
  const pattern = sortedKeys.map(escapeRegex).join('|');
  // Word boundaries via Unicode-aware lookbehind/lookahead so German
  // umlauts and ß count as word chars. JavaScript `\b` is ASCII-only
  // and would split incorrectly on "Übersicht" etc.
  const boundary = '[^\\p{L}\\p{N}]';
  const re = new RegExp(
    `(?<=^|${boundary})(?:${pattern})(?=$|${boundary})`,
    'giu',
  );

  return {
    scan(text: string): readonly AllowlistMatch[] {
      if (text.length === 0) return [];
      const matches: AllowlistMatch[] = [];
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const source = lookup.get(m[0].toLowerCase());
        if (source !== undefined) {
          matches.push({ span: [m.index, m.index + m[0].length], source });
        }
        // Guard against zero-width-match infinite loops (cannot happen
        // with the current pattern, but defensive coding here is cheap).
        if (m.index === re.lastIndex) re.lastIndex += 1;
      }
      return matches;
    },
  };
}

/**
 * Drop any detector hit whose `[start, end)` span overlaps at least
 * one allowlist span. Half-open overlap test: hits [a,b) and
 * allowlist [c,d) overlap iff `a < d && c < b`.
 *
 * Used by `transformOne` to filter the detector pool's output before
 * policy decisions are taken. The allowlist span list is small
 * (typically <50 spans per turn even on a long memory recall) so a
 * naive O(hits × allowlist) check is fine; no sweep needed.
 */
export function filterHitsByAllowlist<T extends { readonly span: readonly [number, number] }>(
  hits: readonly T[],
  allowlistMatches: readonly AllowlistMatch[],
): readonly T[] {
  if (hits.length === 0 || allowlistMatches.length === 0) return hits;
  return hits.filter((hit) => {
    const [hs, he] = hit.span;
    return !allowlistMatches.some((a) => a.span[0] < he && hs < a.span[1]);
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function addTerms(
  lookup: Map<string, AllowlistSource>,
  terms: readonly string[] | undefined,
  source: AllowlistSource,
): void {
  if (terms === undefined) return;
  for (const raw of terms) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    lookup.set(trimmed.toLowerCase(), source);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
