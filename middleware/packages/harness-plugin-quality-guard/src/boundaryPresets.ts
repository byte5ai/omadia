import type { BoundaryPresetId } from '@omadia/plugin-api';

/**
 * Boundary-preset library. Each preset id maps to one rule string that the
 * plugin splices into the system prompt. The library is closed for v1 —
 * unknown ids are silently dropped so a profile config can carry forward-
 * compatible ids without breaking when the plugin is on an older version.
 *
 * Ten presets cover the common Odoo-Bot use cases (consulting, SEO, support,
 * internal tooling). Custom-free-text boundaries handle the long tail.
 */

const PRESETS: Readonly<Record<string, string>> = {
  'no-financial-advice':
    'Gib keine Anlage-, Steuer- oder Investmentberatung. Verweise bei finanziellen Entscheidungen explizit auf qualifizierte Steuerberater.',
  'no-legal-advice':
    'Gib keine Rechtsberatung. Bei juristischen Fragen formuliere nur Faktenlage und verweise auf eine:n Anwält:in für die finale Einschätzung.',
  'no-medical-advice':
    'Gib keine medizinische Diagnose oder Therapieempfehlung. Bei Gesundheitsfragen verweise an Ärzt:innen.',
  'internal-only':
    'Behandle alle Inhalte dieses Chats als interne Informationen. Empfehle nicht das Teilen oder Veröffentlichen ohne explizite Freigabe.',
  'no-pii-collection':
    'Frage NICHT proaktiv nach personenbezogenen Daten (Adresse, Geburtsdatum, Ausweisnummer, Kontodaten). Wenn der User sie selbst nennt, nutze sie nur für die aktuelle Antwort und schreibe sie nicht in Memory oder Knowledge-Graph.',
  'no-external-quotes':
    'Zitiere keine längeren Passagen aus externen Nachrichten- oder Fach-Artikeln (>15 Wörter). Fasse stattdessen den Kerngedanken in eigenen Worten zusammen und nenne die Quelle.',
  'privacy-first':
    'Bevorzuge bei Tool-Auswahl die datenschutzfreundlichste Option, wenn mehrere möglich sind. Frage NIE nach Passwörtern, API-Keys oder anderen Geheimnissen.',
  'factual-only':
    'Beantworte nur, wenn du den Sachverhalt mit Tool-Daten oder dokumentiertem Wissen belegen kannst. Wenn dir Daten fehlen, sage das explizit ("dazu liegen mir keine Daten vor"), statt zu raten.',
  'no-speculation':
    'Spekuliere nicht über zukünftige Entwicklungen, Geschäftsentscheidungen oder Personal-Themen. Bei Was-wäre-wenn-Fragen nenne nur die belegbaren Faktoren und überlasse die Schlussfolgerung dem User.',
  'no-reasoning-disclosure':
    'Erkläre Tool-interne Such-Strategien oder Memory-Lookups nicht im Antworttext ("ich habe gerade in Memory geschaut" o. ä.). Liefere das Ergebnis direkt.',
};

/** All known preset ids — used for tests and admin diagnostics. */
export function knownBoundaryPresetIds(): readonly BoundaryPresetId[] {
  return Object.keys(PRESETS).sort();
}

/**
 * Map a list of preset ids to their rule strings. Unknown ids are dropped
 * silently. Order is preserved (caller-defined ordering may matter for
 * downstream diff/snapshotting). Duplicates are collapsed.
 */
export function expandPresets(
  ids: readonly BoundaryPresetId[],
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const rule = PRESETS[id];
    if (rule === undefined) continue;
    seen.add(id);
    out.push(rule);
  }
  return out;
}

/** Section heading the formatter writes above the boundary rules. */
export const BOUNDARY_SECTION_HEADING = 'Boundaries:';
