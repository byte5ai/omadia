/**
 * Stable-id tokenization — Privacy-Shield v3, slice 1.
 *
 * Tool-aware pre-pass that runs BEFORE the NER detectors (Presidio,
 * regex) inside `processToolResult`. Tools that declare `piiFields`
 * annotations (see `@omadia/plugin-api`'s `piiAnnotation.ts`) hand the
 * walker their structured result and a list of (path, idPath, type)
 * tuples; the walker:
 *
 *   1. Resolves each `path` to a list of "leaf positions" — pairs of
 *      `(parent, key)` so the leaf can be overwritten in place.
 *   2. Resolves the parallel `idPath` to a list of stable identifiers
 *      drawn from the same array spreads.
 *   3. For each (leaf, id) pair: when the leaf is a non-empty string
 *      and the id is non-null/undefined, mints a whole-value token
 *      via `map.tokenFor(leafValue, displayType)` and writes the
 *      token back into the JSON at the leaf position.
 *
 * The slice-1 walker uses `tokenFor`'s value-keyed dedup, so the same
 * leaf value within a turn always yields the same token (no row
 * doubling for the same employee name). The `idPath` is consumed for
 * shape-alignment validation but the id value itself is NOT yet baked
 * into the token name — that escalation lives in slice 1.5 once we
 * have telemetry on homonym cases (`"Müller" + employee_id=12` vs
 * `"Müller" + employee_id=88` would collapse in slice 1; in slice 1.5
 * they get distinct stable-id tokens).
 *
 * Failure modes (slice 1):
 *
 *   - Shape mismatch (path and idPath disagree on `[]` spread count,
 *     or the parallel arrays have different lengths): the annotation
 *     is skipped, the rest of the result remains untouched, a
 *     `skipped` counter increments. NER then runs on the unmodified
 *     value as a defense-in-depth net.
 *   - Non-string leaf: skipped silently. PII annotations target
 *     string fields; numbers and booleans aren't tokenization targets.
 *   - Missing path segment: skipped silently. A tool that sometimes
 *     omits a field doesn't break the walker.
 *
 * The walker never throws — every defensive branch returns a no-op
 * outcome so tokenisation failures degrade to "NER does what it
 * always did". That's the slice-1 safety property: stable-id is
 * strictly additive on the privacy-guard pipeline.
 */

import type { PIIFieldType, ToolPIIField } from '@omadia/plugin-api';

import type { TokenizeMap } from './tokenizeMap.js';

export interface StableIdTokenizationOutcome {
  /** Deep-cloned tool result with annotated leaves rewritten to tokens. */
  readonly value: unknown;
  /** Number of leaf string fields actually replaced with stable tokens. */
  readonly replaced: number;
  /**
   * Number of annotations skipped because the (path, idPath) pair did
   * not align in shape against the raw result. Telemetry signal — when
   * non-zero, the operator should re-check the tool's PII annotations
   * against the live response shape.
   */
  readonly skipped: number;
}

interface PathSegment {
  readonly key: string;
  /** `true` when the segment ended with `[]`, signalling an array spread. */
  readonly isArray: boolean;
}

interface LeafAddress {
  readonly parent: Record<string, unknown>;
  readonly key: string;
}

/**
 * Entry point. Walks `raw` once per annotation; never mutates the
 * input. Annotations of arity zero or with malformed paths are skipped
 * defensively.
 *
 * When the input is anything other than a plain object (string,
 * number, null, array at top level), the call returns `{value, 0, 0}`
 * — slice-1 schema only models top-level-object payloads, which is
 * what every Odoo / Confluence tool currently emits.
 */
export function applyStableIdTokenization(
  raw: unknown,
  annotations: readonly ToolPIIField[],
  map: TokenizeMap,
): StableIdTokenizationOutcome {
  if (annotations.length === 0) {
    return { value: raw, replaced: 0, skipped: 0 };
  }
  if (!isPlainObject(raw)) {
    return { value: raw, replaced: 0, skipped: 0 };
  }

  // Deep-clone via JSON round-trip. The walker mutates the clone, not
  // the caller's reference. JSON-clone is sufficient because every
  // tool result this walker sees is already JSON-serialisable (it's
  // about to be `JSON.stringify`ed for the LLM).
  const work = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;

  let replaced = 0;
  let skipped = 0;

  for (const ann of annotations) {
    const type: PIIFieldType = ann.type ?? 'PERSON';
    const pathSegs = parsePath(ann.path);
    const idSegs = parsePath(ann.idPath);
    if (pathSegs.length === 0 || idSegs.length === 0) {
      skipped += 1;
      continue;
    }
    if (countArraySpreads(pathSegs) !== countArraySpreads(idSegs)) {
      skipped += 1;
      continue;
    }
    const addresses = collectAddresses(work, pathSegs);
    const ids = collectValues(work, idSegs);
    if (addresses.length !== ids.length) {
      skipped += 1;
      continue;
    }
    for (let i = 0; i < addresses.length; i += 1) {
      const addr = addresses[i];
      const id = ids[i];
      if (!addr) continue;
      if (id === null || id === undefined) continue;
      const leaf = addr.parent[addr.key];
      if (typeof leaf !== 'string' || leaf.length === 0) continue;
      // Slice-1: value-keyed dedup. The id is validated above
      // (shape-aligned, non-null) but its concrete value does not yet
      // alter the token name. Slice 1.5 will swap this to a true
      // stable-id mint that disambiguates homonyms.
      const token = map.tokenFor(leaf, typeToDetectorHint(type));
      addr.parent[addr.key] = token;
      replaced += 1;
    }
  }

  return { value: work, replaced, skipped };
}

/**
 * Parse a dotted path like `"employees[].partner.name"` into segments.
 * Empty input or empty segments produce an empty array — caller treats
 * that as "malformed annotation, skip".
 */
function parsePath(path: string): readonly PathSegment[] {
  if (path.length === 0) return [];
  const parts = path.split('.');
  const out: PathSegment[] = [];
  for (const raw of parts) {
    if (raw.length === 0) return [];
    if (raw.endsWith('[]')) {
      const key = raw.slice(0, -2);
      if (key.length === 0) return [];
      out.push({ key, isArray: true });
    } else {
      out.push({ key: raw, isArray: false });
    }
  }
  return out;
}

function countArraySpreads(segs: readonly PathSegment[]): number {
  let n = 0;
  for (const s of segs) if (s.isArray) n += 1;
  return n;
}

/**
 * Walk `obj` along `segs`, returning the writable `(parent, key)`
 * positions of every leaf the path resolves to. Missing intermediate
 * segments yield an empty slice for that branch — never throws.
 */
function collectAddresses(
  obj: unknown,
  segs: readonly PathSegment[],
): readonly LeafAddress[] {
  if (segs.length === 0) return [];
  const head = segs[0];
  if (!head) return [];
  const rest = segs.slice(1);

  if (head.isArray) {
    if (!isPlainObject(obj)) return [];
    const arr = obj[head.key];
    if (!Array.isArray(arr)) return [];
    if (rest.length === 0) {
      // `field[]` with no further segment — slice 1 does not support
      // arrays of leaves directly; only arrays of objects with a
      // subsequent key. Skip silently.
      return [];
    }
    const out: LeafAddress[] = [];
    for (const item of arr) {
      out.push(...collectAddresses(item, rest));
    }
    return out;
  }

  if (!isPlainObject(obj)) return [];
  if (rest.length === 0) {
    return [{ parent: obj, key: head.key }];
  }
  return collectAddresses(obj[head.key], rest);
}

/**
 * Walk `obj` along `segs`, returning the leaf VALUES the path resolves
 * to. Mirror of `collectAddresses` for the read side (used to pluck
 * stable ids out of `idPath`).
 */
function collectValues(obj: unknown, segs: readonly PathSegment[]): readonly unknown[] {
  if (segs.length === 0) return [];
  const head = segs[0];
  if (!head) return [];
  const rest = segs.slice(1);

  if (head.isArray) {
    if (!isPlainObject(obj)) return [];
    const arr = obj[head.key];
    if (!Array.isArray(arr)) return [];
    if (rest.length === 0) return arr; // raw array-of-leaves
    const out: unknown[] = [];
    for (const item of arr) {
      out.push(...collectValues(item, rest));
    }
    return out;
  }

  if (!isPlainObject(obj)) return [];
  if (rest.length === 0) return [obj[head.key]];
  return collectValues(obj[head.key], rest);
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Map the public `PIIFieldType` literal to the detector-hint string
 * the existing `TokenizeMap.tokenFor` knows about (`pii.name`,
 * `pii.email`, …). Keeps the token's display type aligned with the
 * NER detector taxonomy so a stable-id-minted token and an
 * NER-minted token of the same type are visually indistinguishable
 * to the LLM.
 */
function typeToDetectorHint(type: PIIFieldType): string {
  switch (type) {
    case 'PERSON':
      return 'pii.name';
    case 'EMAIL':
      return 'pii.email';
    case 'PHONE':
      return 'pii.phone';
    case 'IBAN':
      return 'pii.iban';
    case 'CARD':
      return 'pii.credit_card';
    case 'ADDRESS':
      return 'pii.address';
    case 'ORG':
      return 'pii.organization';
    case 'APIKEY':
      return 'pii.api_key';
    default:
      // Exhaustiveness guard — TS will catch a new variant at compile
      // time, but at runtime fall back to a generic name hint.
      return 'pii.name';
  }
}
