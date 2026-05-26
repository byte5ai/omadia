/**
 * Privacy Shield v4 — Pseudonym Projection (US7).
 *
 * The gated fallback for the rare case where the LLM must reason in prose
 * about specific individuals. `sensitive-masked` field values are replaced by
 * stable, realistic pseudonyms; the pseudonym↔real map is held server-side and
 * resolved back at materialization (FR-020/FR-021). A generated pseudonym
 * never equals a real value in the dataset (research C5).
 *
 * This module is the mechanism. Wiring it into a concrete prose-reasoning
 * flow is gated on research C6 (scope the real demand from transcripts before
 * over-building) and is therefore intentionally left to a follow-up.
 *
 * Contract: specs/001-privacy-shield-v4/contracts/verb-api.md §5
 */

import type { Dataset, DatasetRow, PseudonymMap } from './types.js';

// Realistic German-style name pools — the dataset domain is German HR.
const FIRST_NAMES: ReadonlyArray<string> = [
  'Lukas', 'Mia', 'Felix', 'Emma', 'Jonas', 'Hannah', 'Paul', 'Lena',
  'Tim', 'Sophie', 'Finn', 'Clara', 'Noah', 'Laura', 'Elias', 'Marie',
  'Ben', 'Julia', 'Leon', 'Nina', 'Jan', 'Sarah', 'Max', 'Eva',
];
const LAST_NAMES: ReadonlyArray<string> = [
  'Becker', 'Schulz', 'Hoffmann', 'Wagner', 'Richter', 'Klein', 'Wolf',
  'Schröder', 'Neumann', 'Schwarz', 'Braun', 'Krüger', 'Hofmann', 'Hartmann',
  'Lange', 'Werner', 'Krause', 'Lehmann', 'Köhler', 'Maier', 'Frank',
  'Albrecht', 'Vogel', 'Sommer',
];

/** Deterministic stream of "First Last" pseudonym candidates. */
function* pseudonymCandidates(): Generator<string> {
  for (const last of LAST_NAMES) {
    for (const first of FIRST_NAMES) {
      yield `${first} ${last}`;
    }
  }
}

/**
 * Build a stable pseudonym map for a set of real values. Each distinct real
 * value gets one pseudonym; pseudonyms are distinct and none equals any real
 * value in the set (C5). Deterministic — the same input set yields the same
 * mapping, so a pseudonym is stable for an individual within a turn.
 */
export function createPseudonymMap(
  realValues: Iterable<string>,
): PseudonymMap {
  const reals = [...new Set(realValues)]
    .filter((v) => v.length > 0)
    .sort();
  const realSet = new Set(reals);
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  const candidates = pseudonymCandidates();

  for (const real of reals) {
    let pseudonym: string | undefined;
    for (;;) {
      const next = candidates.next();
      if (next.done === true) {
        throw new Error(
          '[privacy-shield-v4] pseudonym pool exhausted — dataset too large',
        );
      }
      const candidate = next.value;
      if (!realSet.has(candidate) && !reverse.has(candidate)) {
        pseudonym = candidate;
        break;
      }
    }
    forward.set(real, pseudonym);
    reverse.set(pseudonym, real);
  }
  return { forward, reverse };
}

/**
 * Project a Dataset for individual-level prose: every `sensitive-masked`
 * string value is replaced by its stable pseudonym. Safe fields are
 * untouched. Returns the projected rows plus the server-held map.
 */
export function projectDataset(dataset: Dataset): {
  rows: DatasetRow[];
  map: PseudonymMap;
} {
  const maskedPaths = dataset.schema.fields
    .filter((f) => f.classification === 'sensitive-masked')
    .map((f) => f.path);

  const reals = new Set<string>();
  for (const row of dataset.rows) {
    for (const path of maskedPaths) {
      const value = row[path];
      if (typeof value === 'string' && value.length > 0) reals.add(value);
    }
  }
  const map = createPseudonymMap(reals);

  const rows = dataset.rows.map((row): DatasetRow => {
    const out: Record<string, unknown> = { ...row };
    for (const path of maskedPaths) {
      const value = row[path];
      if (typeof value === 'string') {
        out[path] = map.forward.get(value) ?? value;
      }
    }
    return out;
  });
  return { rows, map };
}

/**
 * Resolve pseudonyms back to real values in a block of text — the inverse of
 * `projectDataset`, applied at materialization. Longest pseudonyms first so a
 * shorter pseudonym cannot partially rewrite a longer one.
 */
export function resolvePseudonyms(text: string, map: PseudonymMap): string {
  const pairs = [...map.reverse.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  );
  let result = text;
  for (const [pseudonym, real] of pairs) {
    result = result.split(pseudonym).join(real);
  }
  return result;
}
