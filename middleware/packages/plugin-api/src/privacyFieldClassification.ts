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

/** One masked field the privacy guard saw in a tool result. Schema only. */
export interface FieldObservation {
  /** The tool whose result held the field, e.g. `odoo_execute`. */
  readonly toolName: string;
  /** The field path, e.g. `department_id`. */
  readonly fieldPath: string;
  readonly valueShape: FieldValueShape;
  /** The Odoo model the result was read from, when known (tool input
   *  `model`, or an envelope's `model` key), e.g. `hr.employee`. */
  readonly sourceModels: readonly string[];
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
export interface FieldSampleVerdict {
  readonly toolName: string;
  readonly fieldPath: string;
  /** Distinct values vetted (0 when the buffer held none). */
  readonly sampleCount: number;
  /** A C0 identity shape (e-mail, IBAN, phone, address, ID number) or an
   *  operator deny-list term matched at least one sampled value. */
  readonly identityHit: boolean;
  readonly c1: FieldSampleC1Verdict;
  /** Detector types that hit, e.g. `['email']`, `['person']`. */
  readonly hitTypes: readonly string[];
}

/** An Odoo model to classify from its SCHEMA only (never a value). */
export interface ModelClassificationRequest {
  /** The relation target, e.g. `x_custom.region`. */
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
