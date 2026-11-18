/**
 * #131 — strip `[ref:<nodeId>]` citation markers from an answer string
 * before it lands in the markdown renderer. The orchestrator's verifier
 * uses the markers to prove KG-evidence-grounded claims; the user just
 * sees the prose.
 *
 * Pure function — no I/O, no side effects — so callers can pipe the
 * source through it inline (`<Markdown source={stripCitationMarkers(raw)} />`)
 * without memoising. Idempotent: stripping twice is a no-op.
 *
 * NodeId shape is loose on purpose: plugins mint their own prefixes
 * (`n_invoice_42`, `confluence-page-89`, `odoo:res.partner:42`) and real
 * graph ids carry `:` and `.` (`turn:<scope>:<ISO time>`), so the id is
 * anything up to the closing bracket that is not whitespace. The
 * verifier's detection regex (`harness-verifier/src/verifierPipeline.ts`)
 * and the channel-SDK stripper (`harness-channel-sdk/src/citationMarkers.ts`)
 * use the same pattern, so the three stay in lock-step.
 */
const CITATION_MARKER_REGEX = /[ \t]?\[ref:[^\]\s]+\]/gi;

export function stripCitationMarkers(source: string): string {
  return source.replace(CITATION_MARKER_REGEX, '');
}
