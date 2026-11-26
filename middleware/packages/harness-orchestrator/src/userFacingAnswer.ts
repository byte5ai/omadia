/**
 * #1956 — the persisted answer carries notes written for the next turn's
 * model, not for the user: the render provenance (`<!-- orchestrator:
 * rendered_table … -->`, #1543) in front and the attachment digest
 * (`<!-- orchestrator:rendered_attachments … -->`) behind. The session log
 * keeps them (recall needs them); everything a person reads — the web-chat
 * mirror — gets the answer without them.
 */
const ORCHESTRATOR_NOTE_RE =
  /\n?<!-- orchestrator:rendered_(?:table|attachments)\n[\s\S]*?-->\n?/g;

export function stripOrchestratorNotes(answer: string): string {
  if (!answer.includes('<!-- orchestrator:rendered_')) return answer;
  return answer.replace(ORCHESTRATOR_NOTE_RE, '\n').trim();
}
