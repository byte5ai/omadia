/**
 * Privacy-Shield v2 (Phase A, post-deploy 2026-05-14) — mechanical
 * restoration of LLM self-anonymization patterns.
 *
 * The directive (S-1, S-4) instructs the LLM to emit `«PERSON_N»`
 * tokens verbatim in tables and lists so `processInbound` restores
 * them to the real names. In practice the LLM still substitutes
 * generic labels like "Mitarbeiter 1 / 2 / 3" or "Employee A / B / C"
 * in HR-style tabular output — strong privacy-related policy bias
 * overrides the system-prompt rule. Hardening the directive helps
 * but never deterministically.
 *
 * This module closes the gap mechanically. It scans the assistant
 * output for recognised self-anonymization patterns, derives a
 * positional index from each match (`Mitarbeiter 3` → index 3), and
 * substitutes the corresponding real name from a positional
 * person-token list captured during the most recent tool-result
 * tokenisation. The result is a deterministic safety net that does
 * not depend on LLM cooperation.
 *
 * Important design choices:
 *
 *   - **Conservative substitution.** When the count of distinct
 *     labels in the text exceeds the positional token list, NO
 *     substitution is performed. Restoring a few and leaving the
 *     rest as labels would corrupt the table's row-to-name mapping;
 *     better to surface the issue (operators see the unresolved
 *     labels in the receipt) than to ship a wrong restoration.
 *
 *   - **Positional source = tool-result token-order**, not the
 *     turn-map's global mint order. The LLM's "Mitarbeiter 1" refers
 *     to the first person-row in the tool result, not the first
 *     person ever tokenised in the turn (the user may have mentioned
 *     a name earlier; that mint comes before the tool-result mints
 *     in the global ordering). The caller must supply
 *     `personTokenOrder` from the latest `processToolResult` scan.
 *
 *   - **Type-restricted to PERSON.** Other PII types (EMAIL, IBAN,
 *     ADDRESS, …) do not show this self-anonymization pattern. If
 *     they ever do, a separate handler would extend the pattern
 *     set; this module keeps the contract narrow on purpose.
 *
 *   - **Per-label semantics: same label → same restoration.** If
 *     the LLM emits "Mitarbeiter 1" twice in the same answer (a
 *     summary plus a table cell), both occurrences resolve to the
 *     same real name. Restoration is keyed on the label INDEX, not
 *     on textual position, so the substitution stays coherent across
 *     repeats within one answer.
 *
 * Pattern set (extensible — operators can add more via
 * `extra_self_anonymization_patterns` plugin config in a later slice):
 *
 *   - `Mitarbeiter\s+\d+`      — German default, the live failure mode
 *   - `Mitarbeiterin\s+\d+`    — German female form
 *   - `Kollege\s+\d+`          — German colleague variant
 *   - `Kollegin\s+\d+`         — German female colleague variant
 *   - `Employee\s+\d+`         — English form
 *   - `Person\s+\d+`           — Language-neutral form
 *   - `Anonym\s+\d+`           — German "Anonym 1/2/3" pattern
 *
 * Numbered-letter variants (`Mitarbeiter A/B/C`, `Person A/B/C`) are
 * intentionally NOT covered in this version — they are observed less
 * often, and supporting them requires a different ordinal mapping
 * (A → 1, B → 2, …) that is easier to bolt on once we have telemetry
 * showing they occur.
 */

import type { TokenizeMap } from './tokenizeMap.js';

/**
 * Half-open `[start, end)` byte offsets inside the scanned text plus
 * the parsed label keyword and 1-based ordinal. Exposed for tests and
 * for the receipt telemetry that wants to surface which patterns
 * fired.
 */
export interface SelfAnonymizationMatch {
  readonly span: readonly [number, number];
  /** Raw matched substring, e.g. `"Mitarbeiter 1"`. */
  readonly raw: string;
  /** Keyword stem (`"Mitarbeiter"`, `"Employee"`, …) — lower-case
   *  normalised so the caller can group counts by pattern type. */
  readonly keyword: string;
  /** 1-based ordinal extracted from the match. `"Mitarbeiter 3"` → 3. */
  readonly index: number;
}

export interface RestorationOutcome {
  /** Transformed text. Equal to input when no substitution was
   *  performed (conservative-skip or zero matches). */
  readonly text: string;
  /** Total distinct labels found in the input. */
  readonly detected: number;
  /** Number of labels actually restored to real names. Zero when
   *  the conservative-skip rule triggered. */
  readonly restored: number;
  /** Number of labels that could not be restored — either because
   *  the index exceeded `personTokenOrder.length`, or because the
   *  positional token did not resolve to a real value in the
   *  TokenizeMap. */
  readonly ambiguous: number;
  /** Lower-case keyword stems that fired, deduplicated. Useful for
   *  the receipt block ("which language/style of self-anon hit?"). */
  readonly patternsHit: readonly string[];
  /** Highest 1-based ordinal observed across all matches. Lets the
   *  caller emit a one-line diagnostic ("4 labels, max index 4, 3
   *  tokens available → skipped"). */
  readonly maxIndexSeen: number;
}

/**
 * Compiled pattern set. Each entry contributes its own keyword stem
 * so the telemetry can attribute hits per pattern class. The shared
 * regex form is `\b<keyword>\s+(\d+)\b` (word-boundary on both ends,
 * `\d+` captured as the ordinal). `i` flag is intentionally omitted —
 * the LLM emits these labels in normalised German/English casing
 * ("Mitarbeiter", "Employee") and accepting lower-case would
 * mass-match common nouns ("mitarbeiter dieses jahres") inside
 * narrative prose.
 */
const PATTERNS: ReadonlyArray<{ readonly keyword: string; readonly regex: RegExp }> = [
  { keyword: 'mitarbeiter', regex: /\bMitarbeiter\s+(\d+)\b/g },
  { keyword: 'mitarbeiterin', regex: /\bMitarbeiterin\s+(\d+)\b/g },
  { keyword: 'kollege', regex: /\bKollege\s+(\d+)\b/g },
  { keyword: 'kollegin', regex: /\bKollegin\s+(\d+)\b/g },
  { keyword: 'employee', regex: /\bEmployee\s+(\d+)\b/g },
  { keyword: 'person', regex: /\bPerson\s+(\d+)\b/g },
  { keyword: 'anonym', regex: /\bAnonym\s+(\d+)\b/g },
];

/**
 * Walk `text` once per pattern, return every match left-to-right.
 * Pure function — exported for unit-test inspection and for the
 * service's audit logging (where the operator wants to see WHICH
 * spans triggered).
 *
 * The same `(keyword, index)` pair may legitimately match more than
 * once if the LLM repeats a label in body prose and a table cell; we
 * return every occurrence so the substitution pass can rewrite all
 * of them. The downstream restorer deduplicates on `(keyword, index)`
 * when computing the "distinct labels" count.
 */
export function detectSelfAnonymizationLabels(
  text: string,
): readonly SelfAnonymizationMatch[] {
  if (text.length === 0) return [];
  const out: SelfAnonymizationMatch[] = [];
  for (const { keyword, regex } of PATTERNS) {
    // Reset lastIndex on a copy — the module-level RegExp is `g`-flagged
    // and would otherwise carry state between calls.
    const local = new RegExp(regex.source, regex.flags);
    let m: RegExpExecArray | null;
    while ((m = local.exec(text)) !== null) {
      const indexStr = m[1];
      if (indexStr === undefined) continue;
      const parsed = Number.parseInt(indexStr, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) continue;
      out.push({
        span: [m.index, m.index + m[0].length],
        raw: m[0],
        keyword,
        index: parsed,
      });
    }
  }
  // Sort left-to-right; ties broken by ascending end-offset (shorter
  // spans first) — only relevant if two patterns ever overlap at the
  // same start, which the current pattern set cannot.
  out.sort((a, b) => {
    if (a.span[0] !== b.span[0]) return a.span[0] - b.span[0];
    return a.span[1] - b.span[1];
  });
  return out;
}

/**
 * Main entry. Given the assistant text, the captured per-tool-result
 * person-token order, and the live TokenizeMap, return a transformed
 * text plus restoration stats. Conservative-skip behaviour when the
 * positional list cannot cover the observed maxIndex.
 *
 * `personTokenOrder` is expected to be the de-duplicated, in-order
 * sequence of `«PERSON_N»` tokens that appeared in the most recent
 * tool-result text after tokenisation. Index 1 (1-based) of the
 * LLM's "Mitarbeiter N" labels maps to `personTokenOrder[0]`, which
 * the map then resolves to the real name.
 */
export function restoreSelfAnonymization(
  text: string,
  personTokenOrder: readonly string[],
  map: TokenizeMap,
): RestorationOutcome {
  const matches = detectSelfAnonymizationLabels(text);
  if (matches.length === 0) {
    return {
      text,
      detected: 0,
      restored: 0,
      ambiguous: 0,
      patternsHit: [],
      maxIndexSeen: 0,
    };
  }

  // Distinct labels = unique (keyword, index) pairs. Useful for the
  // "count-mismatch → skip" decision below.
  const distinct = new Set<string>();
  let maxIndex = 0;
  const patternSet = new Set<string>();
  for (const m of matches) {
    distinct.add(`${m.keyword}/${String(m.index)}`);
    if (m.index > maxIndex) maxIndex = m.index;
    patternSet.add(m.keyword);
  }
  const detected = distinct.size;
  const patternsHit = [...patternSet].sort();

  // Conservative skip: if the highest observed index exceeds the
  // available positional tokens, restoration would be partial and
  // could misalign row-to-name mappings in tables. Return the text
  // unchanged and surface the gap via the receipt.
  if (personTokenOrder.length === 0 || maxIndex > personTokenOrder.length) {
    return {
      text,
      detected,
      restored: 0,
      ambiguous: detected,
      patternsHit,
      maxIndexSeen: maxIndex,
    };
  }

  // Build the per-(keyword, index) replacement once so repeated
  // occurrences of the same label in the answer body all resolve to
  // the same real name. Skip pairs whose positional token does not
  // resolve in the map (defensive — should not happen if the
  // accumulator is consistent, but cheaper than a noisy crash).
  const replacementFor = new Map<string, string>();
  let resolvedCount = 0;
  for (const key of distinct) {
    const slashAt = key.lastIndexOf('/');
    if (slashAt < 0) continue;
    const indexStr = key.slice(slashAt + 1);
    const idx = Number.parseInt(indexStr, 10);
    if (!Number.isFinite(idx) || idx <= 0 || idx > personTokenOrder.length) continue;
    const token = personTokenOrder[idx - 1];
    if (token === undefined) continue;
    const original = map.resolve(token);
    if (original === undefined) continue;
    replacementFor.set(key, original);
    resolvedCount += 1;
  }

  if (resolvedCount === 0) {
    return {
      text,
      detected,
      restored: 0,
      ambiguous: detected,
      patternsHit,
      maxIndexSeen: maxIndex,
    };
  }

  // Replace right-to-left so earlier spans stay valid. Each match
  // looks up its (keyword, index) key in the precomputed map.
  const sorted = [...matches].sort((a, b) => b.span[0] - a.span[0]);
  let out = text;
  let restoredOccurrences = 0;
  for (const m of sorted) {
    const key = `${m.keyword}/${String(m.index)}`;
    const replacement = replacementFor.get(key);
    if (replacement === undefined) continue;
    out = out.slice(0, m.span[0]) + replacement + out.slice(m.span[1]);
    restoredOccurrences += 1;
  }

  // `restored` is the count of DISTINCT labels resolved. The number
  // of textual occurrences rewritten lives in `restoredOccurrences`
  // (kept local — operators care about how many people had their
  // names restored, not how many table cells had it stamped).
  void restoredOccurrences;
  return {
    text: out,
    detected,
    restored: resolvedCount,
    ambiguous: detected - resolvedCount,
    patternsHit,
    maxIndexSeen: maxIndex,
  };
}

/**
 * Phase A.1 (post-deploy 2026-05-14 second iteration) — gap-fill
 * restoration of `«PERSON_N»` tokens that survived `processInbound`
 * because they had no binding in the turn-map.
 *
 * Observed failure mode v149 HR-routine: the LLM emits some tokens
 * verbatim (e.g. `«PERSON_5»`, `«PERSON_8»`) that `processInbound`
 * restores fine, but throws in a hallucinated extra (`«PERSON_12»`)
 * that does not exist in the turn-map and therefore survives to the
 * channel. Strategy:
 *
 *   1. Resolve every captured tool-result person-token to its real
 *      name → that is the FULL set of names that legitimately
 *      belong in the final answer.
 *   2. Scan the text for occurrences of each real name → the set of
 *      names already present.
 *   3. The set difference is the "missing names" — people in the
 *      tool result that did not surface in the final text.
 *   4. Scan the text for unresolved `«TYPE_N»` tokens (any type, not
 *      just PERSON — the LLM occasionally hallucinates EMAIL or ORG
 *      placeholders too). Each such token represents a "row position"
 *      where a real name was expected.
 *   5. **Conservative count match**: only proceed when the number of
 *      unresolved tokens equals the number of missing names. Off-by-one
 *      means we cannot align the substitution and the wrong real name
 *      could end up in the wrong row.
 *   6. Substitute left-to-right: nth unresolved token in output order
 *      gets the nth missing name in tool-result order.
 *
 * This algorithm uses the non-name fields (departments, dates) as
 * implicit anchors: the LLM emits the row for the right person
 * (correct dept + dates) but flubs the name slot. Whatever the name
 * slot is — be it a label like "Mitarbeiter 1" (handled in
 * `restoreSelfAnonymization`) or an unresolved token like
 * `«PERSON_12»` (handled here) — the substitution restores it to
 * the name whose dept+date the LLM already correctly reproduced.
 *
 * Type-agnostic: the regex matches `«TYPE_N»` for any uppercase TYPE.
 * We never substitute the same span twice (label-pattern restoration
 * runs first; if Phase-A.0 already filled a slot, this pass sees
 * a real name and finds no unresolved token there).
 */
const ANY_TOKEN_REGEX = /«[A-Z][A-Z_]*_\d+»/g;

export interface UnresolvedTokenMatch {
  readonly span: readonly [number, number];
  readonly token: string;
}

export function restoreUnresolvedPersonTokens(
  text: string,
  personTokenOrder: readonly string[],
  map: TokenizeMap,
): RestorationOutcome {
  if (text.length === 0 || personTokenOrder.length === 0) {
    return {
      text,
      detected: 0,
      restored: 0,
      ambiguous: 0,
      patternsHit: [],
      maxIndexSeen: 0,
    };
  }

  // Step 1: find every unresolved «TYPE_N» token in left-to-right
  // order. Resolved tokens (those whose map.resolve() returns a
  // value) are NOT candidates — they would already have been
  // restored to real names by `processInbound`.
  const unresolved: UnresolvedTokenMatch[] = [];
  const local = new RegExp(ANY_TOKEN_REGEX.source, ANY_TOKEN_REGEX.flags);
  let m: RegExpExecArray | null;
  while ((m = local.exec(text)) !== null) {
    const tok = m[0];
    if (map.resolve(tok) !== undefined) continue;
    unresolved.push({ span: [m.index, m.index + tok.length], token: tok });
  }
  if (unresolved.length === 0) {
    return {
      text,
      detected: 0,
      restored: 0,
      ambiguous: 0,
      patternsHit: [],
      maxIndexSeen: 0,
    };
  }

  // Step 2-4: compute the set of "missing names" — real names from
  // the tool result that are NOT present in the current text. The
  // text inclusion check is naive (substring) but conservative
  // enough for the HR-routine shape; if a name is a substring of
  // another both rows count as "present" which UNDER-counts missing
  // and forces the conservative-skip in step 5.
  const missing: string[] = [];
  const allNames: string[] = [];
  for (const token of personTokenOrder) {
    const name = map.resolve(token);
    if (name === undefined) continue;
    allNames.push(name);
    if (!text.includes(name)) missing.push(name);
  }
  void allNames;

  const detected = unresolved.length;
  const patternsHit: readonly string[] = ['unresolved-token'];

  // Step 5: conservative count match. If the LLM dropped 2 names
  // and we see 1 unresolved token, we cannot tell WHICH name is
  // missing from that one slot — skip rather than guess.
  if (unresolved.length !== missing.length) {
    return {
      text,
      detected,
      restored: 0,
      ambiguous: detected,
      patternsHit,
      maxIndexSeen: detected,
    };
  }

  // Step 6: substitute right-to-left so earlier spans stay valid.
  // The mapping is positional: nth unresolved token gets the nth
  // missing name. Both arrays are already in left-to-right /
  // tool-result order respectively.
  const sorted = [...unresolved]
    .map((u, i) => ({ ...u, replacement: missing[i] }))
    .sort((a, b) => b.span[0] - a.span[0]);
  let out = text;
  let restored = 0;
  for (const { span, replacement } of sorted) {
    if (replacement === undefined) continue;
    out = out.slice(0, span[0]) + replacement + out.slice(span[1]);
    restored += 1;
  }

  return {
    text: out,
    detected,
    restored,
    ambiguous: detected - restored,
    patternsHit,
    maxIndexSeen: detected,
  };
}

/**
 * Phase A.2 (post-deploy 2026-05-14 third iteration) — final scrub
 * pass that runs AFTER the egress filter. Phase A.0 / A.1 run BEFORE
 * the egress filter, which means they cannot see tokens minted by
 * egress itself when it masks spontaneous PII (`«PERSON_11»`,
 * `«PERSON_12»`, etc. with counter values higher than anything in
 * the tool-result token order). Those egress-minted tokens flow
 * through to the user-facing answer and surface as token-shape
 * cruft (HR-routine v152 Zusammenfassung, 2026-05-14).
 *
 * Two-stage restoration on the post-egress text:
 *
 *   1. Positional restoration. Re-use the missing-name algorithm
 *      from `restoreUnresolvedPersonTokens` — count unresolved
 *      `«TYPE_N»` tokens, compute names from tool result NOT in
 *      text, substitute positionally when counts match.
 *   2. Generic placeholder fallback. ANY remaining `«TYPE_N»` token
 *      that step 1 could not restore is replaced with a per-type
 *      German placeholder (`[Name]`, `[E-Mail]`, …). The user sees
 *      a clean placeholder instead of token cruft; the privacy
 *      property holds (no PII surface), and the semantic loss is
 *      limited to "there's another person here but we cannot
 *      determine who exactly" — which is honest signalling.
 *
 * This function ALWAYS removes every `«TYPE_N»` token from the
 * output. The caller can rely on the post-condition that the
 * returned text contains no privacy-shield token shapes.
 */
const TYPE_PLACEHOLDERS: Readonly<Record<string, string>> = {
  PERSON: '[Name]',
  EMAIL: '[E-Mail]',
  PHONE: '[Telefon]',
  IBAN: '[IBAN]',
  CARD: '[Kreditkarte]',
  ADDRESS: '[Adresse]',
  ORG: '[Organisation]',
  IP: '[IP-Adresse]',
  CRYPTO: '[Krypto-Adresse]',
  APIKEY: '[Schlüssel]',
  SSN: '[ID-Nummer]',
};

function placeholderForToken(token: string): string {
  // Token shape: «TYPE_N» — slice off the wrapper, take everything up to
  // the last underscore (which separates type from counter).
  const inner = token.slice(1, -1); // strip « »
  const lastUnderscore = inner.lastIndexOf('_');
  if (lastUnderscore <= 0) return '[Vertraulich]';
  const type = inner.slice(0, lastUnderscore);
  return TYPE_PLACEHOLDERS[type] ?? '[Vertraulich]';
}

export interface PostEgressOutcome {
  readonly text: string;
  /** Tokens substituted via positional alignment (step 1). */
  readonly restoredPositional: number;
  /** Tokens replaced with a generic placeholder (step 2). */
  readonly scrubbedToPlaceholder: number;
}

export function restoreOrScrubRemainingTokens(
  text: string,
  personTokenOrder: readonly string[],
  map: TokenizeMap,
): PostEgressOutcome {
  if (text.length === 0) {
    return { text, restoredPositional: 0, scrubbedToPlaceholder: 0 };
  }

  // Step 1 mirrors `restoreUnresolvedPersonTokens` but on the FINAL
  // text. Find every `«TYPE_N»` (any type, not just PERSON, so we
  // also catch EMAIL / IBAN cruft from egress when those types are
  // active), but only attempt positional substitution against PERSON
  // tokens (the tool-result order is person-typed).
  const tokenSpans: Array<{ span: readonly [number, number]; token: string }> = [];
  const local = new RegExp(/«[A-Z][A-Z_]*_\d+»/g.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = local.exec(text)) !== null) {
    tokenSpans.push({ span: [m.index, m.index + m[0].length], token: m[0] });
  }
  if (tokenSpans.length === 0) {
    return { text, restoredPositional: 0, scrubbedToPlaceholder: 0 };
  }

  // Compute "missing names" from the tool-result token order: real
  // names whose resolve(token) is a clean string (not a token-shape)
  // AND which are NOT present in the current text. Excluding
  // token-shape values guards against the sub-agent-hallucinated-token
  // cycle (where resolve returns the literal token string).
  const personTokenShape = /^«PERSON_\d+»$/;
  const toolResultNames: string[] = [];
  for (const t of personTokenOrder) {
    const name = map.resolve(t);
    if (name === undefined) continue;
    if (personTokenShape.test(name)) continue;
    toolResultNames.push(name);
  }
  const missing = toolResultNames.filter((n) => !text.includes(n));

  // Positional substitution candidates: any PERSON-typed token that
  // does NOT already resolve to a legit tool-result name. Three sub-
  // categories all collapse into "positional candidate":
  //   - Unresolved (map.resolve === undefined).
  //   - Token-shape cycle (resolves to another `«PERSON_N»` literal).
  //   - Egress-minted with a spontaneous-PII value (resolves to a
  //     real string that is NOT one of the tool-result names). The
  //     spontaneous value is what egress was supposed to MASK, so we
  //     do NOT reveal it via "restoration"; positional substitution
  //     against a missing tool-result name is the right answer.
  // A token whose resolved value IS one of the tool-result names is
  // a legitimate restoration target and stays out of the candidate
  // set — its resolved value gets substituted directly below.
  const toolResultNameSet = new Set(toolResultNames);
  const isPositionalCandidate = (token: string): boolean => {
    if (!/^«PERSON_\d+»$/.test(token)) return false;
    const resolved = map.resolve(token);
    if (resolved === undefined) return true;
    if (personTokenShape.test(resolved)) return true;
    return !toolResultNameSet.has(resolved);
  };

  const candidates = tokenSpans.filter((s) => isPositionalCandidate(s.token));
  const replacements = new Map<string, string>(); // span-key → replacement

  let restoredPositional = 0;
  if (candidates.length > 0 && candidates.length === missing.length) {
    // Positional 1:1 — substitute left-to-right in candidate order.
    candidates.forEach((c, i) => {
      const name = missing[i];
      if (name !== undefined) {
        replacements.set(`${String(c.span[0])}:${String(c.span[1])}`, name);
        restoredPositional += 1;
      }
    });
  }

  // Step 2: anything not positionally resolved gets a generic
  // placeholder. This covers non-PERSON tokens, count-mismatch
  // candidates, and any token that step 1 left alone.
  let scrubbedToPlaceholder = 0;
  for (const span of tokenSpans) {
    const key = `${String(span.span[0])}:${String(span.span[1])}`;
    if (replacements.has(key)) continue;
    replacements.set(key, placeholderForToken(span.token));
    scrubbedToPlaceholder += 1;
  }

  // Substitute right-to-left so earlier spans stay valid.
  const sorted = [...tokenSpans].sort((a, b) => b.span[0] - a.span[0]);
  let out = text;
  for (const span of sorted) {
    const key = `${String(span.span[0])}:${String(span.span[1])}`;
    const repl = replacements.get(key);
    if (repl === undefined) continue;
    out = out.slice(0, span.span[0]) + repl + out.slice(span.span[1]);
  }

  return { text: out, restoredPositional, scrubbedToPlaceholder };
}

/**
 * Extract the in-order, de-duplicated sequence of person-tokens from
 * a tokenised text. Exposed so `processToolResult` can capture it
 * once after `transformOne` and store it on the turn accumulator
 * without re-running the regex inside the service.
 *
 * Returns `«PERSON_N»` style tokens only — other types (EMAIL, IBAN,
 * ADDRESS, …) do not participate in self-anonymization restoration.
 */
const PERSON_TOKEN_REGEX = /«PERSON_\d+»/g;
export function extractPersonTokenOrder(text: string): readonly string[] {
  if (text.length === 0) return [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  const local = new RegExp(PERSON_TOKEN_REGEX.source, PERSON_TOKEN_REGEX.flags);
  let m: RegExpExecArray | null;
  while ((m = local.exec(text)) !== null) {
    const tok = m[0];
    if (seen.has(tok)) continue;
    seen.add(tok);
    ordered.push(tok);
  }
  return ordered;
}
