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

// ---------------------------------------------------------------------------
// #361 — prompt-span pseudonyms (text-span variant of `createPseudonymMap`).
//
// Free-text prompt masking substitutes DETECTED spans, which are typed
// (email, IBAN, phone, address, amount, date, person) — a "Lukas Becker"
// name surrogate would be shape-wrong for an IBAN and would degrade the
// LLM answer the masking is trying to preserve. Each type therefore draws
// from its own realistic surrogate pool. Same invariants as
// `createPseudonymMap`: deterministic per input set, bijective, and no
// surrogate ever equals a real value or appears in the input text (C5).
// ---------------------------------------------------------------------------

/** A real value + its PII type, as detected in a prompt. */
export interface PromptSpanValue {
  readonly value: string;
  readonly type: string;
}

/** Deterministic per-type surrogate candidate streams. Every generator is
 *  unbounded via a numeric suffix/variation, so the pool cannot exhaust. */
function* personCandidates(): Generator<string> {
  yield* pseudonymCandidates();
  // Overflow beyond the finite name pool: numbered variants.
  for (let i = 2; ; i++) {
    for (const last of LAST_NAMES) {
      for (const first of FIRST_NAMES) yield `${first} ${last} ${String(i)}`;
    }
  }
}

function* emailCandidates(): Generator<string> {
  for (let i = 0; ; i++) {
    const first = FIRST_NAMES[i % FIRST_NAMES.length]!.toLowerCase();
    const last =
      LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length]!.toLowerCase();
    yield i < FIRST_NAMES.length * LAST_NAMES.length
      ? `${first}.${last}@example.net`
      : `${first}.${last}${String(i)}@example.net`;
  }
}

/** Valid-looking DE IBAN shape with a varying account part. Deliberately
 *  NOT checksum-valid — it must never collide with a real account, only
 *  look shape-plausible to the model. */
function* ibanCandidates(): Generator<string> {
  for (let i = 0; ; i++) {
    yield `DE00500105170${String(1000 + (i % 9000))}${String(2000 + i).padStart(4, '0')}`;
  }
}

function* phoneCandidates(): Generator<string> {
  for (let i = 0; ; i++) {
    yield `+49 30 5559${String(i % 10000).padStart(4, '0')}`;
  }
}

function* addressCandidates(): Generator<string> {
  for (let i = 0; ; i++) {
    yield `Musterstraße ${String(1 + (i % 199))}, ${String(10000 + ((i * 37) % 89999))} Musterstadt`;
  }
}

function* amountCandidates(): Generator<string> {
  for (let i = 0; ; i++) {
    yield `€${String(10000 + ((i * 1111) % 90000))}`;
  }
}

function* dateCandidates(): Generator<string> {
  for (let i = 0; ; i++) {
    yield `${String(1 + (i % 28)).padStart(2, '0')}.${String(1 + (i % 12)).padStart(2, '0')}.${String(1970 + (i % 40))}`;
  }
}

/** Unknown category from a future detector — neutral placeholder, still
 *  bijective and restorable. */
function* genericCandidates(type: string): Generator<string> {
  for (let i = 0; ; i++) {
    yield `PLATZHALTER-${type.toUpperCase()}-${String(i + 1)}`;
  }
}

function surrogateCandidates(type: string): Generator<string> {
  switch (type) {
    case 'person':
      return personCandidates();
    case 'email':
      return emailCandidates();
    case 'iban':
      return ibanCandidates();
    case 'phone':
      return phoneCandidates();
    case 'address':
      return addressCandidates();
    case 'amount':
      return amountCandidates();
    case 'date':
      return dateCandidates();
    default:
      return genericCandidates(type);
  }
}

/**
 * Build (or extend) a pseudonym map for detected prompt spans. Guarantees:
 *   - stable: a value already in `existing` keeps its surrogate;
 *   - bijective: no two real values share a surrogate;
 *   - collision-free: a surrogate never equals a real value in the set OR
 *     any real value from an earlier call this turn (`existing`), never
 *     appears as a substring of `avoidText` (the full prompt), and never
 *     collides with an existing surrogate.
 * Deterministic for the same inputs, so a person/value is stable within a
 * turn across multiple mask calls (message + ingested attachment tail).
 */
export function createPromptPseudonymMap(
  spanValues: Iterable<PromptSpanValue>,
  avoidText: string,
  existing?: PseudonymMap,
): PseudonymMap {
  const forward = new Map<string, string>(existing?.forward ?? []);
  const reverse = new Map<string, string>(existing?.reverse ?? []);

  // Deduplicate by value, deterministic order (sorted by value).
  const pending = new Map<string, string>();
  for (const { value, type } of spanValues) {
    if (value.length === 0 || forward.has(value)) continue;
    if (!pending.has(value)) pending.set(value, type);
  }
  // Collision domain = ALL real values seen so far this turn: the current
  // call's pending values AND every real already in `existing` from earlier
  // calls (message, ingested tail, recalled context). Without the latter, a
  // later call could mint a surrogate equal to a real value masked earlier
  // in the turn — answer-side restore would then corrupt that span.
  const realSet = new Set(pending.keys());
  for (const real of forward.keys()) realSet.add(real);

  for (const [value, type] of [...pending.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    let surrogate: string | undefined;
    for (const candidate of surrogateCandidates(type)) {
      if (
        !reverse.has(candidate) &&
        !realSet.has(candidate) &&
        !avoidText.includes(candidate)
      ) {
        surrogate = candidate;
        break;
      }
    }
    // Unreachable: every stream is unbounded — but keep the invariant loud.
    if (surrogate === undefined) {
      throw new Error('[privacy-shield-v4] prompt surrogate pool exhausted');
    }
    forward.set(value, surrogate);
    reverse.set(surrogate, value);
  }
  return { forward, reverse };
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
