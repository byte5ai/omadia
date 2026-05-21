/**
 * Privacy Shield v4 — Data-Plane Boundary: contract types.
 *
 * The single source of truth for the v4 surface. Every v4 module imports
 * from here; the orchestrator imports these (re-exported from the package
 * `index.ts`) through the privacy capability seam and never re-declares them.
 *
 * Design references:
 *   specs/001-privacy-shield-v4/contracts/dataset-store-and-digest.md
 *   specs/001-privacy-shield-v4/contracts/shape-classifier.md
 *   specs/001-privacy-shield-v4/contracts/verb-api.md
 *   specs/001-privacy-shield-v4/data-model.md
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard cap on the serialized size (in characters) of a tool result the
 * Dataset Store will retain. A larger result is truncated to whole rows at
 * intern time and the resulting Digest is flagged `truncated: true` so the
 * LLM never reasons over a dataset it believes is complete.
 *
 * There is no pre-existing tool-output limit in the middleware to reuse —
 * this is the single source of truth (research C4).
 */
export const MAX_INTERN_CHARS = 200_000;

/** Fixed placeholder shown to the LLM in place of a masked field's values.
 *  The Digest builder appends the field type, e.g. `[masked string]`. */
export const MASKED_PLACEHOLDER = '[masked]';

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** A field's resolved JSON/value type. `unknown` always yields a masked
 *  classification (deny-by-default, FR-008). */
export type FieldType =
  | 'number'
  | 'boolean'
  | 'date'
  | 'enum'
  | 'id'
  | 'string'
  | 'unknown';

/** The subset of `FieldType` that may ever be `safe-cleartext`. */
export type SafeType = 'number' | 'boolean' | 'date' | 'enum' | 'id';

/** The deny-by-default classification verdict for a field. */
export type Classification = 'safe-cleartext' | 'sensitive-masked';

/** The structural shape of an interned result. Non-tabular results are still
 *  interned; `rows` is normalized to a single-row array for `scalar`/`object`. */
export type DatasetShape = 'rows' | 'object' | 'scalar' | 'nested';

/** Per-column value statistics that drive a classification verdict. Retained
 *  on the verdict so a reviewer can audit *why* a field was masked or cleared. */
export interface FieldStats {
  /** Distinct non-null values observed for this field. */
  readonly distinctCount: number;
  /** `distinctCount === rowCount` — every row has a unique value. */
  readonly uniquePerRow: boolean;
  /** `distinctCount / rowCount`; low ⇒ enum-like, high ⇒ handle-or-name. */
  readonly cardinalityRatio: number;
  /** A PII detector returned a hit on at least one value (one-way booster). */
  readonly detectorHit: boolean;
}

/** The classification verdict for one field, keyed by JSON key path. */
export interface FieldClassification {
  /** Key path, e.g. `"employee_id"` or `"manager.name"`. */
  readonly path: string;
  readonly type: FieldType;
  readonly classification: Classification;
  readonly stats: FieldStats;
}

/** The classified schema of a dataset — identity-free, safe to show the LLM. */
export interface DatasetSchema {
  readonly fields: ReadonlyArray<FieldClassification>;
  readonly rowCount: number;
  readonly shape: DatasetShape;
}

// ---------------------------------------------------------------------------
// Dataset & Dataset Store
// ---------------------------------------------------------------------------

/** One row of an interned dataset. Non-tabular results are wrapped so the
 *  store and the Verb API always operate on a uniform row array. */
export type DatasetRow = Readonly<Record<string, unknown>>;

/** Where a dataset came from. */
export interface DatasetProvenance {
  /** Originating tool name, or the verb name for a verb-derived dataset. */
  readonly toolName: string;
  readonly turnId: string;
  /** `datasetId` of the input dataset, when produced by a verb. */
  readonly derivedFrom?: string;
  /** The source was bounded at intern time (`MAX_INTERN_CHARS`). */
  readonly truncated: boolean;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
}

/**
 * An interned, server-held tool result. `rows` is the real data — the single
 * piece of state the boundary exists to keep off the LLM wire. A `Dataset`
 * is never serialized into an LLM-bound message; only its `Digest` is.
 */
export interface Dataset {
  readonly datasetId: string;
  readonly rows: ReadonlyArray<DatasetRow>;
  readonly schema: DatasetSchema;
  readonly provenance: DatasetProvenance;
}

/** A pure function that classifies parsed rows into a `DatasetSchema`.
 *  Implemented by the Shape Classifier (US2); injected into the Dataset
 *  Store so US1 is testable with a stub. */
export type Classifier = (
  rows: ReadonlyArray<DatasetRow>,
  shape: DatasetShape,
) => DatasetSchema;

/** Return shape of `internToolResult` and of every verb. */
export interface DigestEnvelope {
  readonly datasetId: string;
  readonly digest: Digest;
}

/** The turn-scoped registry of datasets. One store instance per turn; every
 *  dataset is dropped at `finalizeTurn` (FR-003). Held inside the privacy
 *  plugin instance — never module-scope state (Constitution I). */
export interface DatasetStore {
  /** Intern a raw tool result; store the real rows behind a `datasetId`,
   *  return the identity-free Digest. */
  internToolResult(toolName: string, rawResult: unknown): DigestEnvelope;
  /** Register a verb-produced dataset; return its `datasetId` + Digest. */
  put(dataset: Dataset): DigestEnvelope;
  /** Server-side resolution of the real rows. Trusted callers only (verbs,
   *  the Materializer) — its result MUST NOT be serialized to the LLM. */
  get(datasetId: string): Dataset | undefined;
  /** Drop every dataset for the turn. Total and idempotent. */
  finalizeTurn(): void;
  /** Count of datasets interned this turn (for the Privacy Receipt). */
  readonly internedCount: number;
}

// ---------------------------------------------------------------------------
// Digest — what the LLM receives in place of raw data
// ---------------------------------------------------------------------------

/** A summary of a `safe-cleartext` field for larger results. */
export interface SafeSummary {
  readonly min?: unknown;
  readonly max?: unknown;
  /** Distinct values, only for low-cardinality enum fields. */
  readonly distinctValues?: ReadonlyArray<unknown>;
}

/** A `safe-cleartext` field as the LLM sees it — actual values or a summary. */
export interface SafeFieldDigest {
  readonly path: string;
  readonly type: SafeType;
  readonly classification: 'safe-cleartext';
  /** Inlined when `rowCount` is small; mutually exclusive with `summary`. */
  readonly values?: ReadonlyArray<unknown>;
  /** Used instead of `values` for larger results. */
  readonly summary?: SafeSummary;
}

/** A `sensitive-masked` field as the LLM sees it — a placeholder + a count,
 *  never a value, sample, prefix, suffix, or hash (Digest invariant I1). */
export interface MaskedFieldDigest {
  readonly path: string;
  readonly type: string;
  readonly classification: 'sensitive-masked';
  readonly placeholder: string;
  readonly distinctCount: number;
}

export type FieldDigest = SafeFieldDigest | MaskedFieldDigest;

/** The identity-free stand-in the LLM receives for a `Dataset`. Carried as
 *  the payload of a `tool_result` block and of every `VerbResult`. */
export interface Digest {
  readonly datasetId: string;
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly fields: ReadonlyArray<FieldDigest>;
}

// ---------------------------------------------------------------------------
// Verb API
// ---------------------------------------------------------------------------

export type VerbName =
  | 'filter'
  | 'sort'
  | 'group'
  | 'aggregate'
  | 'top_n'
  | 'select'
  | 'count'
  | 'join';

export type SortDirection = 'asc' | 'desc';

export type AggregateFn = 'count' | 'sum' | 'min' | 'max' | 'avg';

/** A single aggregate output column. */
export interface AggregateOp {
  readonly alias: string;
  readonly fn: AggregateFn;
  /** Required for sum/min/max/avg; omitted (or ignored) for count. */
  readonly field?: string;
}

/** A scalar usable in a predicate. `string` only for enum / handle fields. */
export type PredicateScalar = number | boolean | string;

/**
 * The bounded `filter` predicate grammar (research C3). A JSON tree, never a
 * string to evaluate. Every `field` MUST resolve to a `safe-cleartext` field
 * or a row handle; a reference to a `sensitive-masked` field is rejected
 * before execution (FR-014).
 */
export type Predicate =
  | {
      readonly op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
      readonly field: string;
      readonly value: PredicateScalar;
    }
  | { readonly op: 'in'; readonly field: string; readonly values: ReadonlyArray<PredicateScalar> }
  | {
      readonly op: 'between';
      readonly field: string;
      readonly lo: PredicateScalar;
      readonly hi: PredicateScalar;
    }
  | { readonly op: 'and' | 'or'; readonly clauses: ReadonlyArray<Predicate> }
  | { readonly op: 'not'; readonly clause: Predicate };

/** The result of a verb — a NEW dataset + its Digest. Structurally identical
 *  to `DigestEnvelope`; aliased for call-site clarity. */
export type VerbResult = DigestEnvelope;

// ---------------------------------------------------------------------------
// Render Directive & Materializer
// ---------------------------------------------------------------------------

export type RenderFormat = 'table' | 'list' | 'scalar';

/** The LLM's final-answer instruction to the Materializer. `columns` MAY name
 *  `sensitive-masked` fields — the Materializer renders their real values into
 *  the channel-bound output for the authenticated user (FR-016/FR-017). */
export interface RenderDirective {
  readonly datasetId: string;
  readonly columns: ReadonlyArray<string>;
  readonly format: RenderFormat;
  /** PII-free surrounding prose from the LLM. */
  readonly prose?: string;
}

// ---------------------------------------------------------------------------
// Pseudonym Projection (US7)
// ---------------------------------------------------------------------------

/** The server-held pseudonym↔real mapping for an individual-reasoning
 *  projection. Resolved back to real names at materialization (FR-021). */
export interface PseudonymMap {
  /** real value → stable pseudonym. */
  readonly forward: ReadonlyMap<string, string>;
  /** pseudonym → real value. */
  readonly reverse: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Privacy Receipt (v4 shape — US9 adapts receiptAssembler to emit this)
// ---------------------------------------------------------------------------

/** The per-turn user-facing report, re-expressed in v4 terms (FR-028). */
export interface PrivacyReceiptV4 {
  readonly datasetsInterned: number;
  readonly fieldsMasked: number;
  readonly fieldsCleartext: number;
  readonly verbsExecuted: ReadonlyArray<VerbName>;
  readonly pseudonymProjectionUsed: boolean;
}
