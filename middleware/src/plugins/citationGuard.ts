/**
 * #131 — Citation-Guard system-prompt fragment.
 *
 * Mandates that every assertion grounded in knowledge-graph evidence
 * carries an inline `[ref:<nodeId>]` marker so the verifier can attribute
 * the claim to its source. The verifier-pipeline (see
 * `harness-verifier/src/verifierPipeline.ts#buildCitationMissingVerdicts`)
 * checks the answer for these markers when the runTrace shows a
 * `query_knowledge_graph` call; an answer with KG evidence but no
 * markers fails the verifier with a `citation_missing` claim and the
 * existing correctionPrompt retry loop fires.
 *
 * Pattern parallel to `compileSycophancyGuard` and the
 * Math-Delegation rule shipped by `@omadia/plugin-deterministic-tools`:
 * a small German prompt section the kernel splices into every system
 * prompt. Always-on — no per-agent toggle.
 *
 * The channel layer (web-ui markdown renderer, Teams card renderer)
 * strips the `[ref:...]` markers before the user sees the answer.
 */

export const CITATION_GUARD_HEADING = '## Knowledge-Graph Citation-Pflicht';

const BODY = `Wenn du in diesem Turn Daten aus der Wissens-Datenbank (Tool \`query_knowledge_graph\`) verwendest, MUSST du jede daraus abgeleitete Aussage mit einem \`[ref:<nodeId>]\`-Marker versehen. Die nodeId kommt aus den \`nodeId\`-Feldern der Tool-Results.

Beispiel:
- ❌ "Die Rechnung INV/2026/0042 ist offen."  (keine Quelle → wird vom Verifier zurückgewiesen)
- ✅ "Die Rechnung INV/2026/0042 ist offen [ref:n_invoice_42]."

Wenn eine Aussage NICHT aus dem Graph stammt (allgemeines Wissen, direkte Tool-Antwort, vom User mitgegebene Information), brauchst du dort keine Citation.

Der Channel-Layer entfernt \`[ref:...]\`-Marker vor der Darstellung beim User — du musst dir um die Optik keine Sorgen machen. Die Marker dienen ausschließlich der internen Verifizierung.

Ohne Citations wird die Antwort blockiert und du wirst aufgefordert, sie mit Marker neu zu schreiben (Cost: ein zusätzlicher Turn). Daher gleich beim ersten Versuch ergänzen.`;

/**
 * Returns the citation-guard prompt section. Always-on — no per-agent
 * configuration. The orchestrator simply concatenates the result into
 * the compiled system prompt next to sycophancy + boundaries.
 *
 * Returns an empty string when called with the explicit `'off'` level
 * to support a future Per-Agent override pattern; today there is no
 * such override and the call site passes nothing.
 */
export function compileCitationGuard(level: 'on' | 'off' = 'on'): string {
  if (level === 'off') return '';
  return `${CITATION_GUARD_HEADING}\n\n${BODY}`;
}
