/**
 * Frontend mirror of `middleware/src/plugins/builder/boundaryPresets.ts`.
 *
 * Lets the Builder UI render the structured Boundaries section without
 * a round-trip to the server. Stays in sync with the middleware module
 * manually until a shared package lands — the count/structure assertion
 * in `boundaryPresets.test.ts` flags drift on the middleware side, and
 * the equivalent (this file) flags drift on the UI side.
 *
 * @see Issue #54
 */

export type BoundaryCategory = 'data' | 'scope' | 'authority' | 'communication';

export interface BoundaryPreset {
  id: string;
  category: BoundaryCategory;
  /** i18n leaf under `builder.persona.boundaries.presets.*`. */
  labelKey: string;
}

export const BOUNDARY_PRESETS: readonly BoundaryPreset[] = [
  // data
  { id: 'no-financial-data', category: 'data', labelKey: 'presetNoFinancial' },
  { id: 'no-pii', category: 'data', labelKey: 'presetNoPii' },
  { id: 'no-medical-data', category: 'data', labelKey: 'presetNoMedical' },
  { id: 'no-legal-advice', category: 'data', labelKey: 'presetNoLegal' },
  // scope
  { id: 'own-domain-only', category: 'scope', labelKey: 'presetOwnDomain' },
  { id: 'no-code-execution', category: 'scope', labelKey: 'presetNoCode' },
  { id: 'no-external-links', category: 'scope', labelKey: 'presetNoExternal' },
  // authority
  { id: 'no-discount-authority', category: 'authority', labelKey: 'presetNoDiscount' },
  { id: 'no-commitments', category: 'authority', labelKey: 'presetNoCommitments' },
  { id: 'no-personnel-decisions', category: 'authority', labelKey: 'presetNoPersonnel' },
  // communication
  { id: 'no-speculation', category: 'communication', labelKey: 'presetNoSpeculation' },
  { id: 'no-competitor-discussion', category: 'communication', labelKey: 'presetNoCompetitor' },
] as const;

export const KNOWN_BOUNDARY_PRESET_IDS: ReadonlySet<string> = new Set(
  BOUNDARY_PRESETS.map((p) => p.id),
);

export function findUnknownBoundaryPresets(presetIds: readonly string[]): string[] {
  return presetIds.filter((id) => !KNOWN_BOUNDARY_PRESET_IDS.has(id));
}
