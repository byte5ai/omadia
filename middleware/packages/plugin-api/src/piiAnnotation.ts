/**
 * Tool-side PII field annotations — Privacy-Shield v3 (stable-id
 * tokenization).
 *
 * Motivation
 * ----------
 * An earlier slice tokenized PII with an NER sidecar (Microsoft Presidio +
 * spaCy DE/EN) that ran *after* a tool had already serialized its result to a
 * string. German names tripped that detector in three failure modes that
 * surfaced in the live HR-routine v149..v152:
 *
 *   - Partial-name leaks: NER hits "Marvin" → `«PERSON_N»` but leaves
 *     "Vomberg" plaintext, producing rows like `«PERSON_53» Vomberg`.
 *   - Counter drift: every NER hit mints a fresh token, so the same
 *     employee can end up as `«PERSON_3»` in one row and `«PERSON_47»`
 *     in another within the same tool call — restoration aligns to
 *     positions, not identities, and table cells get the wrong name.
 *   - False-positive cascades: "Krankheit" → ADDRESS,
 *     "Abwesenheitstyp" → PERSON. Allowlists patch case-by-case but
 *     never exhaustively.
 *
 * Stable-id tokenization sidesteps all three: tools whose underlying
 * data store gives them a stable identifier per entity (e.g. Odoo
 * `employee_id`, Confluence `accountId`) declare the JSON path to
 * that identifier alongside the PII-bearing field. The privacy-guard
 * mints `«PERSON_<id>»` tokens deterministically from that id, so:
 *
 *   1. The whole value is masked as a single unit (no partial leak).
 *   2. The same identifier yields the same token across rows /
 *      paragraphs / tool calls within a turn (no doubles).
 *   3. Masking no longer depends on a probabilistic detector at all.
 *
 * The NER sidecar has since been removed entirely: redaction is now the
 * Privacy Shield v4 Data-Plane Boundary (@omadia/plugin-privacy-guard), which
 * interns every tool result into a server-held Dataset Store and lets only a
 * shape-classified, masked Digest cross the LLM wire. These tool-side
 * annotations remain the precise, id-anchored layer on top of that boundary.
 *
 * Annotations live on the *tool wrapper*, never on the spec sent to
 * the public LLM. Anthropic's `messages.create({ tools })` rejects
 * unknown fields on a tool spec — and PII metadata is a runtime
 * concern of the harness, not something the model needs to see.
 *
 * Path syntax
 * -----------
 * `path` and `idPath` are step sequences. Each step is one of:
 *
 *   - `key`   — descend into an object property (`name`, `partner`).
 *   - `[]`    — spread across every element of an array. May appear at
 *               the head of the path when the tool result is itself a
 *               top-level array (Odoo `search_read` → `[{…}]`).
 *   - `[N]`   — descend into a fixed array index. The motivating case
 *               is Odoo's many2one wire format `field: [id, label]`,
 *               where `field[1]` is the label and `field[0]` the id.
 *
 * Supported shapes:
 *
 *   - `"name"`                       — top-level object field
 *   - `"user.name"`                  — nested object
 *   - `"employees[].name"`           — array of objects, one per row
 *   - `"employees[].partner.name"`   — array of nested objects
 *   - `"[].name"`                    — TOP-LEVEL array of objects
 *   - `"[].employee_id[1]"`          — top-level array + many2one label
 *   - `"emails[]"`                   — array of leaf strings
 *
 * Both `path` and `idPath` must walk through the SAME number of `[]`
 * spreads in the same order so the two leaf lists zip 1:1 — e.g.
 * `[].employee_id[1]` pairs with `[].employee_id[0]`. Fixed `[N]`
 * indices do not multiply, so they need not match in count.
 *
 * For Odoo many2one fields, use the {@link odooMany2OnePiiField} and
 * {@link odooSearchReadPiiFields} helpers below instead of spelling
 * the `[id, label]` index paths out by hand.
 *
 * Type vocabulary
 * ---------------
 * Mirrors the `«TYPE_N»` token type set the LLM directive describes
 * (`PERSON`, `EMAIL`, `PHONE`, `IBAN`, `CARD`, `ADDRESS`, `ORG`,
 * `APIKEY`). Default is `PERSON` because that is by far the most
 * common annotation in HR / CRM tool results — the place stable-id
 * tokenization pays off most.
 */

export type PIIFieldType =
  | 'PERSON'
  | 'EMAIL'
  | 'PHONE'
  | 'IBAN'
  | 'CARD'
  | 'ADDRESS'
  | 'ORG'
  | 'APIKEY';

export interface ToolPIIField {
  /** JSON path to the PII-bearing field, e.g. `"employees[].name"`. */
  readonly path: string;
  /**
   * JSON path to the stable identifier the privacy-guard uses as the
   * token DEDUP KEY, e.g. `"employees[].employee_id"`. Must walk
   * through the same `[]` spreads as `path`. The identifier is
   * stringified, so numeric ids (Odoo) and opaque strings (Confluence
   * `accountId`) both work. Same id → same token across rows; two
   * homonyms with different ids → distinct tokens. The id itself is
   * never embedded in the token name (the token stays `«TYPE_N»` with
   * a map-local counter), so it never crosses the wire.
   */
  readonly idPath: string;
  /** PII type. Defaults to `PERSON` when omitted. */
  readonly type?: PIIFieldType;
}

// ---------------------------------------------------------------------------
// Odoo many2one helpers.
//
// Odoo's `search_read` returns a top-level array of records; every
// many2one field is serialised as a two-element tuple `[id, label]`
// (an empty relation is `false`, which the walker skips gracefully).
// Spelling the `[1]` / `[0]` index paths out by hand for every PII
// field is noisy and error-prone — these helpers centralise the
// convention so an Odoo tool annotates its result with a one-liner.
// ---------------------------------------------------------------------------

export interface OdooMany2OneOptions {
  /** PII type for the many2one label. Defaults to `PERSON`. */
  readonly type?: PIIFieldType;
  /**
   * Object path to the array of Odoo records. Defaults to `''` — the
   * records ARE the top-level array, which is what `search_read`
   * returns directly. Pass e.g. `"records"` when the tool wraps the
   * rows in an envelope: `{ records: [{…}], meta: {…} }`.
   */
  readonly recordsAt?: string;
}

/**
 * Build a {@link ToolPIIField} for a single Odoo many2one field.
 *
 * `odooMany2OnePiiField("employee_id")` →
 *   `{ path: "[].employee_id[1]", idPath: "[].employee_id[0]" }`
 *
 * The label (index 1) is the PII leaf that gets tokenised; the id
 * (index 0) is the stable identifier. A record whose relation is
 * empty (`employee_id: false`) contributes no leaf on either path,
 * so the 1:1 zip stays aligned and the record is simply skipped.
 */
export function odooMany2OnePiiField(
  field: string,
  options: OdooMany2OneOptions = {},
): ToolPIIField {
  const prefix =
    options.recordsAt !== undefined && options.recordsAt.length > 0
      ? `${options.recordsAt}[]`
      : '[]';
  return {
    path: `${prefix}.${field}[1]`,
    idPath: `${prefix}.${field}[0]`,
    ...(options.type !== undefined ? { type: options.type } : {}),
  };
}

/**
 * Build a {@link ToolPIIField} list for several Odoo many2one fields
 * at once. The common case for an HR / CRM `search_read` tool:
 *
 * ```ts
 * piiFields: odooSearchReadPiiFields({
 *   employee_id: 'PERSON',
 *   user_id: 'PERSON',
 *   partner_id: 'PERSON',
 * })
 * ```
 *
 * Pass `{ recordsAt: 'records' }` as the second argument when the
 * tool wraps the rows in an envelope object.
 */
export function odooSearchReadPiiFields(
  fields: Readonly<Record<string, PIIFieldType>>,
  options: Pick<OdooMany2OneOptions, 'recordsAt'> = {},
): ToolPIIField[] {
  return Object.entries(fields).map(([field, type]) =>
    odooMany2OnePiiField(field, {
      type,
      ...(options.recordsAt !== undefined ? { recordsAt: options.recordsAt } : {}),
    }),
  );
}
