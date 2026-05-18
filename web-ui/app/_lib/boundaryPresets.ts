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
  labelKey: string;
  /** German label fallback; the i18n bundle resolves `labelKey` when available. */
  labelDe: string;
}

export const BOUNDARY_PRESETS: readonly BoundaryPreset[] = [
  // data
  { id: 'no-financial-data', category: 'data', labelKey: 'presetNoFinancial', labelDe: 'Keine Finanzdaten' },
  { id: 'no-pii', category: 'data', labelKey: 'presetNoPii', labelDe: 'Keine personenbezogenen Daten (PII)' },
  { id: 'no-medical-data', category: 'data', labelKey: 'presetNoMedical', labelDe: 'Keine medizinischen Daten' },
  { id: 'no-legal-advice', category: 'data', labelKey: 'presetNoLegal', labelDe: 'Keine Rechtsberatung' },
  // scope
  { id: 'own-domain-only', category: 'scope', labelKey: 'presetOwnDomain', labelDe: 'Nur eigene Domäne' },
  { id: 'no-code-execution', category: 'scope', labelKey: 'presetNoCode', labelDe: 'Keine Code-Ausführung' },
  { id: 'no-external-links', category: 'scope', labelKey: 'presetNoExternal', labelDe: 'Keine externen Links' },
  // authority
  { id: 'no-discount-authority', category: 'authority', labelKey: 'presetNoDiscount', labelDe: 'Keine Rabatt-Befugnis' },
  { id: 'no-commitments', category: 'authority', labelKey: 'presetNoCommitments', labelDe: 'Keine bindenden Zusagen' },
  { id: 'no-personnel-decisions', category: 'authority', labelKey: 'presetNoPersonnel', labelDe: 'Keine Personalentscheidungen' },
  // communication
  { id: 'no-speculation', category: 'communication', labelKey: 'presetNoSpeculation', labelDe: 'Keine Spekulationen' },
  { id: 'no-competitor-discussion', category: 'communication', labelKey: 'presetNoCompetitor', labelDe: 'Keine Wettbewerber-Diskussion' },
] as const;

export const KNOWN_BOUNDARY_PRESET_IDS: ReadonlySet<string> = new Set(
  BOUNDARY_PRESETS.map((p) => p.id),
);

export function findUnknownBoundaryPresets(presetIds: readonly string[]): string[] {
  return presetIds.filter((id) => !KNOWN_BOUNDARY_PRESET_IDS.has(id));
}

export const BOUNDARY_CATEGORY_LABELS_DE: Readonly<Record<BoundaryCategory, string>> = {
  data: 'Daten',
  scope: 'Geltungsbereich',
  authority: 'Befugnisse',
  communication: 'Kommunikation',
};
