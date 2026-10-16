import {
  BOUNDARY_PRESETS,
  getBoundaryPreset,
  type BoundaryPresetId,
} from '@omadia/plugin-api';

/**
 * Boundary-preset resolution for the install-wide defaults.
 *
 * CANONICAL ids come from the shared library in `@omadia/plugin-api` — the
 * same 12 ids, with the same rule wording, the per-agent "Boundaries" tab
 * offers (#1104). An id copied from the agent UI into this plugin's
 * `default_boundary_presets` field therefore means exactly what it means
 * there.
 *
 * LEGACY ids are the plugin's own v0.1 library. They stay accepted, with
 * their original wording, so an install whose saved config names them keeps
 * the same rules after the upgrade. They are not offered for new configs.
 * `no-legal-advice` and `no-speculation` existed in both libraries; they now
 * resolve to the shared wording.
 *
 * Unknown ids are dropped from the prompt (a profile config may carry ids
 * from a newer library) but REPORTED via `partitionPresetIds`, so the plugin
 * can log them instead of dropping them without a trace.
 */

const LEGACY_PRESETS: Readonly<Record<string, string>> = {
  'no-financial-advice':
    'Gib keine Anlage-, Steuer- oder Investmentberatung. Verweise bei finanziellen Entscheidungen explizit auf qualifizierte Steuerberater.',
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
  'no-reasoning-disclosure':
    'Erkläre Tool-interne Such-Strategien oder Memory-Lookups nicht im Antworttext ("ich habe gerade in Memory geschaut" o. ä.). Liefere das Ergebnis direkt.',
};

/** The canonical (shared-library) preset ids, in library order. */
export function canonicalBoundaryPresetIds(): readonly BoundaryPresetId[] {
  return BOUNDARY_PRESETS.map((p) => p.id);
}

/** The legacy v0.1 plugin-only ids, still accepted. */
export function legacyBoundaryPresetIds(): readonly BoundaryPresetId[] {
  return Object.keys(LEGACY_PRESETS).sort();
}

/** All ids this plugin resolves — canonical and legacy, sorted. */
export function knownBoundaryPresetIds(): readonly BoundaryPresetId[] {
  return [...canonicalBoundaryPresetIds(), ...legacyBoundaryPresetIds()].sort();
}

function ruleFor(id: BoundaryPresetId): string | undefined {
  return getBoundaryPreset(id)?.prompt ?? LEGACY_PRESETS[id];
}

/**
 * Split ids into the ones this plugin resolves and the ones it does not.
 * Order is preserved; duplicates are collapsed on both sides.
 */
export function partitionPresetIds(ids: readonly BoundaryPresetId[]): {
  readonly known: readonly BoundaryPresetId[];
  readonly unknown: readonly BoundaryPresetId[];
} {
  const known: BoundaryPresetId[] = [];
  const unknown: BoundaryPresetId[] = [];
  for (const id of new Set(ids)) {
    (ruleFor(id) === undefined ? unknown : known).push(id);
  }
  return { known, unknown };
}

/**
 * Map a list of preset ids to their rule strings. Unknown ids are dropped
 * (see `partitionPresetIds` to report them). Order is preserved (caller-
 * defined ordering may matter for downstream diff/snapshotting). Duplicates
 * are collapsed.
 */
export function expandPresets(
  ids: readonly BoundaryPresetId[],
): readonly string[] {
  return partitionPresetIds(ids).known.map((id) => ruleFor(id) as string);
}

/** Section heading the formatter writes above the boundary rules. */
export const BOUNDARY_SECTION_HEADING = 'Boundaries:';
