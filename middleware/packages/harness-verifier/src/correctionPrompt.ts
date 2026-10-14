import { contradictionBasis, type ClaimVerdict, type VerifierVerdict } from './claimTypes.js';

/**
 * Produces a correction hint appended to the orchestrator's system prompt
 * for a retry after the verifier blocked the first answer. The hint names
 * every contradicted claim and the kind of correction it needs, so the
 * orchestrator can reformulate without repeating them.
 *
 * It carries nothing the verifier found out itself — no `truth`, no `detail`
 * (measured values, knowledge-graph snippets, lookup details, a
 * postcondition's schema issues). The checks run with the verifier's own
 * access (a tenant-wide knowledge-graph lookup, the verifier plugin's Odoo
 * reader), not with the grants of the user whose turn they check, and the
 * hint goes to that turn's model and from there into an answer for that
 * user. What remains is the claims — the answer's own words — the tool names
 * and call ids of the turn's own trace, and fixed text. The orchestrator
 * masks the hint through the turn's prompt map before it reaches the model,
 * like the user's message (#361): the claims are cut from the restored
 * answer. Behind a Privacy Shield the verifier wrapper sends no retry at all
 * when the turn's masking would still alter the hint — a claim span that
 * carries a detected value (`privacySafeCorrection`) — so the retry's model
 * never gets a placeholder-bearing hint, and the hint is masked once, by the
 * retry's own turn.
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
  const unresolvedCitation = citationItems.some((v) => basisOf(v) === 'citation_unresolved');
  const missingCitation = citationItems.some((v) => basisOf(v) !== 'citation_unresolved');
  // A live-data claim without its fetching call (the Odoo cross-check); a
  // failure / absence claim in a turn without calls stays a replay below.
  const notCalledItems = verdict.contradictions.filter(
    (v) => basisOf(v) === 'tool_not_called' && !isReplay(v),
  );
  const replayItems = verdict.contradictions.filter(
    (v) => !isPostcondition(v) && !isCitationMissing(v) && isReplay(v),
  );
  const dataItems = verdict.contradictions.filter(
    (v) => basisOf(v) === 'evidence' && !isReplay(v),
  );

  // Neutral on purpose: most withholds are not contradictions, and the model
  // must not tell the user a source contradicted it when none did.
  const sections: string[] = ['# Verifier hat die Antwort zurückgehalten', ''];

  if (citationItems.length > 0) {
    sections.push(
      '## Fehlende Citations',
      '',
      ...(missingCitation
        ? [
            'Du hast in diesem Turn die Wissens-Datenbank (knowledge graph) abgefragt, aber deine Antwort enthält keinen `[ref:<id>]`-Marker. Jede Aussage, die du aus den Graph-Ergebnissen ableitest, muss die Quelle nennen — sonst ist sie für den User nicht nachvollziehbar.',
            '',
          ]
        : []),
      ...(unresolvedCitation
        ? [
            'Mindestens ein `[ref:…]`-Marker deiner Antwort nennt eine Quelle, die kein `query_knowledge_graph`-Ergebnis dieses Turns geliefert hat. Erfinde keine Quellen.',
            '',
          ]
        : []),
      '**Jetzt bitte:** schreibe die Antwort neu und hänge nach jeder graph-basierten Aussage `[ref:<id>]` an. Die Quelle ist der Wert eines `id`- oder `turnId`-Feldes aus den `query_knowledge_graph`-Ergebnissen. Stelle dafür dieselben Abfragen wie zuvor — sie werden aus dem ersten Durchlauf beantwortet, eine neue Abfrage brauchst du dafür nicht. Belegt kein Ergebnis eine Aussage, lass die Aussage weg oder sag ausdrücklich, dass sie sich nicht belegen lässt — und setze dort keinen Marker. Wenn eine Aussage nicht aus dem Graph kommt (z.B. allgemeines Wissen oder eine direkte Tool-Antwort), brauchst du dort keine Citation. Der Channel-Layer entfernt die Marker vor der Anzeige, sie dienen nur der Verifizierung.',
      '',
    );
  }

  if (notCalledItems.length > 0) {
    sections.push(
      '## Live-Daten nicht abgerufen',
      '',
      'Die folgenden Aussagen brauchen Live-Daten aus dem Quellsystem, aber dieser Turn hat kein Tool aufgerufen, das sie liefern könnte. Sie stammen vermutlich aus dem Kontext eines früheren Turns.',
      '',
      '**Jetzt bitte:** rufe das zuständige Tool auf, bevor du diese Angaben machst. Liefert es sie nicht, lass sie weg oder sag ehrlich, was das Tool zurückgegeben hat.',
      '',
      ...notCalledItems.map(formatContradiction),
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
      'Deine Antwort behauptete einen fehlgeschlagenen oder fehlenden Zugriff / eine Absenz / bat um Wiederholung, obwohl kein Zugriffsversuch in diesem Turn das belegt. Das ist typischerweise eine Kopie aus dem FTS-Kontext-Block (früherer gescheiterter Turn), nicht aus der aktuellen Realität.',
      '',
      '**Jetzt bitte:** prüfe die aktuelle User-Message Zeile für Zeile (inkl. eines `[attachments-info]`-Blocks, falls vorhanden) UND mache wenn nötig einen echten Tool-Call — wiederhole NICHT die Alt-Aussage. Wenn nach einem echten Versuch wirklich nichts da ist, sag das explizit mit Quellenangabe ("Tool X gab für Y leer zurück"). Sag "kein Zugriff" oder "nicht erreichbar" nur, wenn ein Tool-Call dieses Turns tatsächlich mit einem Fehler zurückkam.',
      '',
      ...replayItems.map(formatContradiction),
      '',
    );
  }

  if (dataItems.length > 0) {
    sections.push(
      '## Falsche / widerlegte Daten',
      '',
      'Eine unabhängige Prüfung gegen die Quelle hat die folgenden Aussagen deiner Antwort widerlegt. Wiederhole sie nicht. Formuliere die Antwort neu und stütze jede Angabe ausschließlich auf die Tool-Ergebnisse dieses Turns; belegen sie eine Angabe nicht, lass sie weg oder sag ehrlich, dass sie sich nicht bestätigen ließ — rate nicht.',
      '',
      ...dataItems.map(formatContradiction),
      '',
      'Wichtig: Führe für diese Widersprüche KEINE erneuten Tool-Calls aus, um sie zu "prüfen" — die Prüfung gegen die Quelle ist bereits gelaufen.',
    );
  }

  return sections.join('\n');
}

function basisOf(v: ClaimVerdict): ReturnType<typeof contradictionBasis> | undefined {
  return v.status === 'contradicted' ? contradictionBasis(v) : undefined;
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
  // The issues stay out: they are read off the tool's raw output.
  const callId = v.claim.id.replace(/^c_postcond_/, '');
  return `- ${v.claim.text} (callId=${callId})`;
}

/** A contradicted claim in its own words — never the truth or detail the
 *  check produced (see the module comment). */
function formatContradiction(v: ClaimVerdict): string {
  if (v.status !== 'contradicted') return '';
  return `- "${v.claim.text}"`;
}
