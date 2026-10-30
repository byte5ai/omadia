/**
 * Suggestions for the privacy guard's `non_personal_fields` setting (#1556
 * follow-up). The privacy guard OBSERVES which masked fields its tools return
 * and vets samples of their values; the kernel resolves what an Odoo relation
 * field points to, classifies, stores and shows the candidates. An admin
 * confirms every entry — nothing is ever added to the list automatically.
 *
 * Everything in these types is schema-only: tool names, field paths, model
 * names, counts and verdicts. No type here carries a field VALUE; the value
 * sample stays inside the privacy guard (bounded, in memory, never
 * persisted) and only its verdict crosses this contract.
 */

/** How a masked field's values are shaped. `m2o`: Odoo many2one pairs
 *  `[id, "label"]` (Odoo's `false` for unset ignored); `text`: plain strings;
 *  `mixed`: anything else (never a candidate). */
export type FieldValueShape = 'm2o' | 'text' | 'mixed';

/**
 * A field within one source: the tool, the scope its rows belong to — an Odoo
 * model (`hr.employee`), an uploaded dataset's id for `query_dataset`, or `-`
 * when the result names none — and the field path. The unit a scoped
 * `non_personal_fields` entry clears (decision Marcel, 2026-10-30).
 */
export interface FieldKey {
  readonly toolName: string;
  readonly scope: string;
  readonly fieldPath: string;
}

/** One masked field the privacy guard saw in a tool result, per scope.
 *  Schema only. */
export interface FieldObservation extends FieldKey {
  readonly valueShape: FieldValueShape;
  /** The field's label where the source has one (an Odoo field string, a
   *  CSV header is the path itself); schema, never a value. */
  readonly label?: string;
  /** How many interned results carried the field since the last drain. */
  readonly seenCount: number;
  /** ISO-8601 of the first and last sighting since the last drain. */
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

/** What the name detector (C1) said about a field's sampled values. */
export type FieldSampleC1Verdict = 'hit' | 'near-miss' | 'clean' | 'unavailable';

/** The verdict of vetting a field's buffered value sample. Values never leave
 *  the privacy guard; this is all the kernel learns. */
export interface FieldSampleVerdict extends FieldKey {
  /** Distinct values vetted (0 when the buffer held none). */
  readonly sampleCount: number;
  /** A C0 identity shape (e-mail, IBAN, phone, address, ID number) or an
   *  operator deny-list term matched at least one sampled value. */
  readonly identityHit: boolean;
  readonly c1: FieldSampleC1Verdict;
  /** Detector types that hit, e.g. `['email']`, `['person']`. */
  readonly hitTypes: readonly string[];
}

/** A model or source to classify from its SCHEMA only (never a value): an
 *  Odoo relation target, or — for a source without relation metadata (an
 *  uploaded dataset, an MCP tool) — the source itself, named
 *  `<tool>:<scope>` with its fields. */
export interface ModelClassificationRequest {
  /** The relation target (`x_custom.region`) or the source name. */
  readonly model: string;
  /** The model's display name when known (`ir.model` name). */
  readonly modelLabel?: string;
  /** Field paths that point to it, with their labels and help texts. */
  readonly fields: readonly {
    readonly path: string;
    readonly label?: string;
    readonly help?: string;
  }[];
}

export type ModelPersonalVerdict = 'personal' | 'non-personal' | 'uncertain';

export interface ModelClassificationResult {
  readonly model: string;
  readonly verdict: ModelPersonalVerdict;
  /** 0..1 as the model reported it; `uncertain` when it gave none. */
  readonly confidence: number;
  /** One short sentence, schema-based, no values. */
  readonly reason: string;
}
