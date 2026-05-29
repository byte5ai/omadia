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
 * (`n_invoice_42`, `confluence-page-89`, `odoo://res.partner/7`) and a
 * tight regex here would break with the next backend addition. The
 * verifier's detection regex (`harness-verifier/src/verifierPipeline.ts`)
 * uses the same loose pattern, so the two stay in lock-step.
 */
const CITATION_MARKER_REGEX = /\s?\[ref:[\w-]+\]/gi;

export function stripCitationMarkers(source: string): string {
  return source.replace(CITATION_MARKER_REGEX, '');
}
