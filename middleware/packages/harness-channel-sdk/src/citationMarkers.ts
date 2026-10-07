/**
 * #131 — `[ref:<id>]` citation markers are verifier input, never user text.
 *
 * The orchestrator's model attributes knowledge-graph-grounded statements with
 * them, the answer verifier checks them, and every channel must remove them
 * before a person reads the answer. Real ids carry `:` and `.`
 * (`turn:<scope>:<ISO time>`, `odoo:res.partner:42`), so a marker's id is
 * anything up to the closing bracket that is not whitespace — the same shape
 * the verifier's detector accepts (`harness-verifier/src/verifierPipeline.ts`).
 *
 * Pure and idempotent.
 */
const CITATION_MARKER_REGEX = /[ \t]?\[ref:[^\]\s]+\]/gi;

export function stripCitationMarkers(text: string): string {
  return text.replace(CITATION_MARKER_REGEX, '');
}
