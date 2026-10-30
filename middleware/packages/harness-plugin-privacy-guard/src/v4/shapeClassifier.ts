/**
 * Privacy Shield v4 — Shape Classifier (US2).
 *
 * Deny-by-default classification. Every field of an interned result is
 * decided `safe-cleartext` or `sensitive-masked` from JSON shape + per-column
 * value statistics ALONE — no domain, tool, or schema knowledge (FR-005), so
 * the classifier is generic across every current and future tool (FR-025).
 * The one exception is opt-in and the operator's: a field listed in
 * `non_personal_fields` for its source tool may clear as a `label` (#1556).
 *
 * The allowlist (S1–S5) is the ONLY path to `safe-cleartext`; anything not
 * positively recognized is masked (FR-008). A PII detector, when supplied,
 * acts as a one-way booster: a hit forces `sensitive-masked`, a miss never
 * promotes (D4).
 *
 * Contract: specs/001-privacy-shield-v4/contracts/shape-classifier.md
 */

import {
  type Classification,
  type Classifier,
  type ClassifierContext,
  type DatasetRow,
  type DatasetSchema,
  type DatasetShape,
  type FieldClassification,
  type FieldStats,
  type FieldType,
} from './types.js';
import type { FieldSource } from '../nonPersonalFields.js';

// ---------------------------------------------------------------------------
// Tunable thresholds (contract §5; T014 tunes the defaults empirically)
// ---------------------------------------------------------------------------

export interface ClassifierThresholds {
  /** Max distinct values for a string field to count as a low-cardinality
   *  enum (S4). */
  readonly enumMaxDistinct: number;
  /** Max `distinctCount / rowCount` for the S4 enum rule. */
  readonly enumMaxRatio: number;
}

export const DEFAULT_THRESHOLDS: ClassifierThresholds = {
  enumMaxDistinct: 12,
  enumMaxRatio: 0.1,
};

/**
 * A one-way PII booster. Returns `true` when a value looks like PII. A hit
 * forces `sensitive-masked`; a miss has NO effect — it never promotes a field
 * to `safe-cleartext` (D4). An optional injection point; when omitted (the
 * default) the classifier is shape + value-statistics only.
 */
export type DetectorBooster = (value: string) => boolean;

/**
 * #1556 — the operator's `non_personal_fields` rule: does `path`, in rows that
 * came from `sources` (tool + scope), hold labels that are no personal data (a
 * department, a job position)? True only when every source is covered. See
 * `nonPersonalFields.ts`.
 */
export type NonPersonalFieldRule = (sources: readonly FieldSource[], path: string) => boolean;

export interface ShapeClassifierOptions {
  readonly thresholds?: Partial<ClassifierThresholds>;
  readonly detector?: DetectorBooster;
  readonly nonPersonal?: NonPersonalFieldRule;
}

// ---------------------------------------------------------------------------
// Value-shape recognition
// ---------------------------------------------------------------------------

/** ISO-8601 date or datetime (S3). */
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is `s` an opaque identifier usable as a row handle (S5)? Conservative —
 * the deny-by-default tiebreak means an ambiguous string is NOT a handle.
 * A handle has no whitespace and is a UUID, all digits, or an alphanumeric
 * code carrying at least one digit. A whitespace-free word with no digit
 * (e.g. a first name "Marvin") is deliberately NOT a handle.
 */
function isTokenShaped(s: string): boolean {
  if (s.length === 0 || /\s/.test(s)) return false;
  if (UUID.test(s)) return true;
  if (/^\d+$/.test(s)) return true;
  return /^[A-Za-z0-9._-]+$/.test(s) && /\d/.test(s);
}

/** A string is "enum-like" only when it is a single whitespace-free token —
 *  this keeps multi-word human text ("Marvin Vomberg") out of the S4 enum
 *  allowlist even when it is low-cardinality. */
function isEnumLike(s: string): boolean {
  return s.length > 0 && !/\s/.test(s);
}

/** Stable key for distinct-value counting across heterogeneous types. */
function distinctKey(v: unknown): string {
  try {
    return typeof v === 'string' ? `s:${v}` : `j:${JSON.stringify(v)}`;
  } catch {
    return `x:${String(v)}`;
  }
}

// ---------------------------------------------------------------------------
// Per-field classification
// ---------------------------------------------------------------------------

function resolveType(
  present: ReadonlyArray<unknown>,
  distinctCount: number,
  cardinalityRatio: number,
  thresholds: ClassifierThresholds,
): FieldType {
  if (present.length === 0) return 'unknown';
  if (present.every((v) => typeof v === 'number')) return 'number';
  if (present.every((v) => typeof v === 'boolean')) return 'boolean';
  if (present.every((v) => typeof v === 'string')) {
    const strs = present as ReadonlyArray<string>;
    if (strs.every((s) => ISO_DATE.test(s))) return 'date';
    // S4 — low-cardinality enum of single-token values.
    if (
      distinctCount > 0 &&
      distinctCount <= thresholds.enumMaxDistinct &&
      cardinalityRatio <= thresholds.enumMaxRatio &&
      strs.every(isEnumLike)
    ) {
      return 'enum';
    }
    // S5 — opaque identifier / row handle.
    if (strs.every(isTokenShaped)) return 'id';
    return 'string';
  }
  // Arrays, objects, mixed/heterogeneous types — never positively recognized.
  return 'unknown';
}

const SAFE_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  'number',
  'boolean',
  'date',
  'enum',
  'id',
  'label',
]);

/** An Odoo many2one pair `[id, "label"]`. */
function isLabelPair(v: unknown): v is readonly [number, string] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'string';
}

/** The text a detector reads in a value: a string, or a pair's label. */
function detectableText(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  return isLabelPair(v) ? v[1] : undefined;
}

/**
 * #1556 — the `label` type, reached ONLY through an operator rule: every
 * present value is a string or a many2one pair. The shape alone never gets
 * here — a pair can hold a person (`partner_id: [12, "Jonas Weber"]`) as well
 * as a department, so without the operator's word it stays `unknown`.
 */
function isOperatorLabel(present: ReadonlyArray<unknown>): boolean {
  // Odoo sends `false` for an unset many2one: no value, not a reason to mask.
  const values = present.filter((v) => v !== false);
  return values.length > 0 && values.every((v) => typeof v === 'string' || isLabelPair(v));
}

function classifyField(
  path: string,
  column: ReadonlyArray<unknown>,
  rowCount: number,
  thresholds: ClassifierThresholds,
  detector: DetectorBooster | undefined,
  operatorCleared: boolean,
): FieldClassification {
  const present = column.filter((v) => v !== null && v !== undefined);
  const distinctCount = new Set(present.map(distinctKey)).size;
  const cardinalityRatio = rowCount > 0 ? distinctCount / rowCount : 0;
  const uniquePerRow = rowCount > 0 && distinctCount === rowCount;

  let detectorHit = false;
  if (detector !== undefined) {
    for (const v of present) {
      const text = detectableText(v);
      if (text !== undefined && text.length > 0 && detector(text)) {
        detectorHit = true;
        break;
      }
    }
  }

  const stats: FieldStats = {
    distinctCount,
    uniquePerRow,
    cardinalityRatio,
    detectorHit,
  };

  // #1556 — an operator rule outranks the shape rules for its field, but not
  // the detector below: a value the detector flags still masks the field.
  // A detector hit makes it no label at all, so neither the receipt nor a
  // later verb can treat the field as cleared.
  const type =
    operatorCleared && !detectorHit && isOperatorLabel(present)
      ? 'label'
      : resolveType(present, distinctCount, cardinalityRatio, thresholds);

  // Deny-by-default: a detector hit always masks; otherwise only the
  // allowlist clears a field.
  const classification: Classification =
    !detectorHit && SAFE_TYPES.has(type) ? 'safe-cleartext' : 'sensitive-masked';

  return { path, type, classification, stats };
}

// ---------------------------------------------------------------------------
// Schema classification
// ---------------------------------------------------------------------------

/** Union of field paths across every row, in first-seen order. */
function collectFieldPaths(rows: ReadonlyArray<DatasetRow>): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        paths.push(key);
      }
    }
  }
  return paths;
}

function classify(
  rows: ReadonlyArray<DatasetRow>,
  shape: DatasetShape,
  thresholds: ClassifierThresholds,
  detector: DetectorBooster | undefined,
  nonPersonal: NonPersonalFieldRule | undefined,
  context: ClassifierContext | undefined,
): DatasetSchema {
  const paths = collectFieldPaths(rows);
  const sources = context?.sources ?? [];
  const fields = paths.map((path) =>
    classifyField(
      path,
      rows.map((r) => r[path]),
      rows.length,
      thresholds,
      detector,
      nonPersonal !== undefined &&
        sources.length > 0 &&
        (context?.labelPaths === undefined || context.labelPaths.has(path)) &&
        nonPersonal(sources, path),
    ),
  );
  return { fields, rowCount: rows.length, shape };
}

/**
 * Create a Shape Classifier. The returned function is the `Classifier`
 * injected into the Dataset Store (US1) and the Digest builder (US3).
 */
export function createShapeClassifier(
  opts: ShapeClassifierOptions = {},
): Classifier {
  const thresholds: ClassifierThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...opts.thresholds,
  };
  const detector = opts.detector;
  const nonPersonal = opts.nonPersonal;
  return (rows, shape, context) =>
    classify(rows, shape, thresholds, detector, nonPersonal, context);
}
