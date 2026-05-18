/**
 * Tool-side PII field annotations — Privacy-Shield v3 (stable-id
 * tokenization, slice 1).
 *
 * Motivation
 * ----------
 * The Slice-3 NER detector (Presidio) tokenizes PII *after* a tool has
 * already serialized its result to a string. German names trip
 * Presidio in three failure modes that surfaced in the live HR-routine
 * v149..v152:
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
 * mints `«PERSON_<id>»` tokens *before* NER runs, so:
 *
 *   1. The whole value is masked as a single unit (no partial leak).
 *   2. The same identifier yields the same token across rows /
 *      paragraphs / tool calls within a turn (no doubles).
 *   3. NER becomes defense-in-depth for unannotated free-text only;
 *      false positives stay confined to the prose surface.
 *
 * Annotations live on the *tool wrapper*, never on the spec sent to
 * the public LLM. Anthropic's `messages.create({ tools })` rejects
 * unknown fields on a tool spec — and PII metadata is a runtime
 * concern of the harness, not something the model needs to see.
 *
 * Path syntax
 * -----------
 * `path` and `idPath` use a dotted notation with `[]` as the
 * array-spread marker. Supported shapes (slice 1):
 *
 *   - `"name"`                            — top-level field
 *   - `"user.name"`                       — nested object
 *   - `"employees[].name"`                — array of objects, one per row
 *   - `"employees[].partner.name"`        — array of nested objects
 *
 * Not supported in slice 1: array indices (`employees[0].name`),
 * wildcards across object keys, or non-uniform shapes. Both `path`
 * and `idPath` must walk through the same `[]` spreads in the same
 * order — `employees[].name` pairs with `employees[].employee_id`,
 * not `employees[].partner.id`.
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
   * JSON path to the stable identifier the privacy-guard should use
   * when minting tokens, e.g. `"employees[].employee_id"`. Must walk
   * through the same `[]` spreads as `path`. The identifier is
   * stringified before being embedded in the token name, so numeric
   * ids (Odoo) and opaque strings (Confluence `accountId`) both work.
   */
  readonly idPath: string;
  /** PII type. Defaults to `PERSON` when omitted. */
  readonly type?: PIIFieldType;
}
