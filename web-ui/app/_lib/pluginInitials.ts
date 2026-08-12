/**
 * OM-31 — plugin tile initials that actually distinguish plugins.
 *
 * The old rule (first letter of word 1 + first letter of word 2) collapses the
 * omadia catalog into collisions, because almost every plugin name ends in the
 * same noun:
 *
 *   "MiniMax LLM Provider"  → ML      "Mistral LLM Provider"  → ML
 *   "GEO Analyst"           → GA      "GitHub Assistent"      → GA
 *
 * Two fixes, layered:
 *   1. drop the category nouns before picking letters, so the letters come from
 *      the part of the name that actually identifies the plugin;
 *   2. where the whole list is known, disambiguate what still collides by
 *      appending a third character.
 *
 * `deriveInitials` MUST stay a pure, deterministic function of one name —
 * `PluginIcon` renders in both server and client components, and a
 * context-dependent result would hydrate differently on the two sides.
 */

/** Category nouns that carry no identity: nearly every plugin has one. */
const STOP_WORDS = new Set([
  'llm',
  'provider',
  'plugin',
  'integration',
  'agent',
  'assistent',
  'assistant',
  'analyst',
  'connector',
  'channel',
]);

const FALLBACK = '??';

/** Strip punctuation, split on whitespace. Unicode-aware so "Öffnungszeiten"
 *  and non-Latin names keep their letters. */
function words(name: string): string[] {
  return name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** The identity-bearing words: everything that is not a category noun. Falls
 *  back to the full list when a name consists ONLY of stop words (e.g. the
 *  literal "LLM Provider"), because two letters beat none. */
function significantWords(name: string): string[] {
  const all = words(name);
  const significant = all.filter((w) => !STOP_WORDS.has(w.toLowerCase()));
  return significant.length > 0 ? significant : all;
}

/**
 * The second character for a one-word name.
 *
 * Prefers an INTERNAL capital ("MiniMax" → M, "GitHub" → H) so camel-cased
 * product names stay apart: without this, "MiniMax LLM Provider" and
 * "Mistral LLM Provider" both collapse to "MI" once the category nouns are
 * dropped — the stop-word filter alone does not fix that pair. Falls back to
 * the plain second character ("Mistral" → I).
 */
function secondChar(word: string): string {
  const chars = [...word];
  for (let i = 1; i < chars.length; i++) {
    const c = chars[i] ?? '';
    if (c !== c.toLowerCase() && c === c.toUpperCase()) return c;
  }
  return chars[1] ?? '';
}

/**
 * Two-character initials for a single plugin name. Pure and deterministic.
 *
 * One significant word → first char + `secondChar` ("MiniMax" → MM,
 *                        "Mistral" → MI).
 * Several            → first character of the first two ("Google Workspace" → GW).
 * Nothing usable     → "??".
 */
export function deriveInitials(name: string): string {
  const significant = significantWords(name);
  if (significant.length === 0) return FALLBACK;
  if (significant.length === 1) {
    const only = significant[0] ?? '';
    const head = [...only][0] ?? '';
    if (!head) return FALLBACK;
    return `${head}${secondChar(only)}`.toUpperCase();
  }
  const first = [...(significant[0] ?? '')][0] ?? '';
  const second = [...(significant[1] ?? '')][0] ?? '';
  const pair = `${first}${second}`;
  return pair.length > 0 ? pair.toUpperCase() : FALLBACK;
}

/** Progressively longer candidates for one name: the 2-char base, then the
 *  base plus a 3rd character taken from the identifying word. */
function candidates(name: string): string[] {
  const base = deriveInitials(name);
  if (base === FALLBACK) return [FALLBACK];
  const significant = significantWords(name);
  const out = [base];
  const head = [...(significant[0] ?? '')];
  const tail = [...(significant[1] ?? '')];

  if (significant.length === 1) {
    // "Mistral" → MI, MIS, MIST
    for (let n = 3; n <= 4 && n <= head.length; n++) {
      out.push(head.slice(0, n).join('').toUpperCase());
    }
  } else {
    // "MiniMax LLM Provider" → MM, MIM, MINM (grow the identifying word)
    for (let n = 2; n <= 3 && n <= head.length; n++) {
      const grown = `${head.slice(0, n).join('')}${tail[0] ?? ''}`;
      out.push(grown.toUpperCase());
    }
  }
  return out;
}

/**
 * Collision-aware initials for a KNOWN set of names.
 *
 * Use this wherever the full list is in hand (store grid, plugin DnD board);
 * `deriveInitials` remains the correct single-name fallback for the detail
 * page. Deterministic: names are processed in a stable sorted order, so the
 * same set always yields the same map regardless of input order.
 *
 * If every candidate for a name is taken, a numeric suffix guarantees
 * uniqueness rather than silently emitting a duplicate.
 */
export function deriveInitialsForSet(
  names: readonly string[],
): Map<string, string> {
  const result = new Map<string, string>();
  const taken = new Set<string>();

  for (const name of [...new Set(names)].sort()) {
    let chosen: string | undefined;
    for (const candidate of candidates(name)) {
      if (!taken.has(candidate)) {
        chosen = candidate;
        break;
      }
    }
    if (!chosen) {
      const base = deriveInitials(name);
      let n = 2;
      while (taken.has(`${base}${n}`)) n++;
      chosen = `${base}${n}`;
    }
    taken.add(chosen);
    result.set(name, chosen);
  }
  return result;
}

/** Stable non-cryptographic hash of a plugin id → a tint bucket. Gives tiles
 *  visually distinct accents so a grid of same-shaped names is scannable, and
 *  is deterministic across server and client renders. */
export function toneIndex(id: string, buckets: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % Math.max(1, buckets);
}
