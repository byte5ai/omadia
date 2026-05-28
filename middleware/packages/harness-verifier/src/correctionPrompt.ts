import type { ClaimVerdict, VerifierVerdict } from './claimTypes.js';

/**
 * Produces a correction hint appended to the orchestrator's system prompt
 * for a retry after the verifier blocked the first answer. The hint lists
 * every contradicted claim with the actual value we measured, so the
 * orchestrator can reformulate without re-running the same hallucination.
 *
 * Deliberately German — matches the orchestrator's primary response
 * language; switching languages mid-prompt confuses the model.
 */

export function buildCorrectionPrompt(
  verdict: VerifierVerdict,
): string | undefined {
  if (verdict.status !== 'blocked') return undefined;

  const postconditionItems = verdict.contradictions.filter(isPostcondition);
  const citationItems = verdict.contradictions.filter(isCitationMissing);
  const replayItems = verdict.contradictions.filter(
    (v) => !isPostcondition(v) && !isCitationMissing(v) && isReplay(v),
  );
  const dataItems = verdict.contradictions.filter(
    (v) =>
      !isPostcondition(v) && !isCitationMissing(v) && !isReplay(v),
  );

  const sections: string[] = ['# Verifier hat Widersprüche erkannt', ''];

  if (citationItems.length > 0) {
    sections.push(
      '## Fehlende Citations',
      '',
      'Du hast in diesem Turn die Wissens-Datenbank (knowledge graph) abgefragt, aber deine Antwort enthält keinen `[ref:nodeId]`-Marker. Jede Aussage, die du aus den Graph-Ergebnissen ableitest, muss mit der nodeId der Quelle versehen sein — sonst ist sie für den User nicht nachvollziehbar.',
      '',
      '**Jetzt bitte:** schreibe die Antwort neu und hänge nach jeder graph-basierten Aussage `[ref:<nodeId>]` an (die nodeIds findest du in den vorherigen `query_knowledge_graph`-Tool-Results). Wenn eine Aussage nicht aus dem Graph kommt (z.B. allgemeines Wissen oder eine direkte Tool-Antwort), brauchst du dort keine Citation. Der Channel-Layer entfernt die Marker vor der Anzeige — du musst dir um die Optik keine Sorgen machen, der Marker dient nur der Verifizierung.',
      '',
    );
  }

  if (postconditionItems.length > 0) {
    sections.push(
      '## Tool-Output nicht spec-konform',
      '',
      'Ein Tool-Call hat ein Ergebnis zurückgeliefert, das nicht seinem deklarierten Output-Schema entspricht. Die Antwort darf sich auf diesen Wert NICHT verlassen.',
      '',
      '**Jetzt bitte:** rufe das gleiche Tool mit korrigierten Argumenten erneut auf (z.B. fehlende Felder ergänzen, Filter präzisieren) ODER nutze ein anderes Tool, das die benötigten Daten liefern kann. Wenn das Tool strukturell broken ist und kein Re-Call hilft, sag dem User ehrlich: "Tool X liefert kein verwertbares Ergebnis für Y".',
      '',
      ...postconditionItems.map(formatPostcondition),
      '',
    );
  }

  if (replayItems.length > 0) {
    sections.push(
      '## Replay aus Kontext-Block erkannt',
      '',
      'Deine Antwort behauptete einen Fehler / eine Absenz / bat um Wiederholung, obwohl der aktuelle Turn dafür keine Evidenz liefert. Das ist typischerweise eine Kopie aus dem FTS-Kontext-Block (früherer gescheiterter Turn), nicht aus der aktuellen Realität.',
      '',
      '**Jetzt bitte:** prüfe die aktuelle User-Message Zeile für Zeile (inkl. eines `[attachments-info]`-Blocks, falls vorhanden) UND mache wenn nötig einen echten Tool-Call — wiederhole NICHT die Alt-Aussage. Wenn nach einem echten Versuch wirklich nichts da ist, sag das explizit mit Quellenangabe ("Tool X gab für Y leer zurück").',
      '',
      ...replayItems.map(formatContradiction),
      '',
    );
  }

  if (dataItems.length > 0) {
    sections.push(
      '## Falsche / widerlegte Daten',
      '',
      'Die folgenden Aussagen wurden durch Re-Query widerlegt. Formuliere die Antwort neu und nutze ausschließlich die verifizierten Werte. Falls eine Angabe unklar bleibt, sag das ehrlich statt zu raten.',
      '',
      ...dataItems.map(formatContradiction),
      '',
      'Wichtig: Führe für diese Widersprüche KEINE erneuten Tool-Calls aus, um sie zu "prüfen" — die Werte oben stammen bereits aus einer unabhängigen Re-Query gegen die Quelle. Nutze sie direkt.',
    );
  }

  return sections.join('\n');
}

function isPostcondition(v: ClaimVerdict): boolean {
  if (v.status !== 'contradicted') return false;
  return v.claim.type === 'tool_postcondition';
}

function isCitationMissing(v: ClaimVerdict): boolean {
  if (v.status !== 'contradicted') return false;
  return v.claim.type === 'citation_missing';
}

function isReplay(v: ClaimVerdict): boolean {
  if (v.status !== 'contradicted') return false;
  return v.source === 'unknown' || v.claim.id.startsWith('c_replay');
}

function formatPostcondition(v: ClaimVerdict): string {
  if (v.status !== 'contradicted') return '';
  // claim.id format: `c_postcond_<callId>` — strip the prefix for display.
  const callId = v.claim.id.replace(/^c_postcond_/, '');
  const detail = v.detail ? ` — Issues: ${v.detail}` : '';
  return `- ${v.claim.text} (callId=${callId})${detail}`;
}

function formatContradiction(v: ClaimVerdict): string {
  if (v.status !== 'contradicted') return '';
  const truthStr = formatTruth(v.truth);
  const detail = v.detail ? ` — ${v.detail}` : '';
  return `- Behauptet: "${v.claim.text}" → Tatsächlich: ${truthStr}${detail}`;
}

function formatTruth(truth: unknown): string {
  if (truth === null || truth === undefined) return '(Eintrag nicht gefunden)';
  if (typeof truth === 'number') return String(truth);
  if (typeof truth === 'string') {
    return truth.length <= 200 ? truth : `${truth.slice(0, 200)}…`;
  }
  try {
    return JSON.stringify(truth);
  } catch {
    return String(truth);
  }
}
