/**
 * Frontend mirror of `middleware/src/plugins/builder/culturePresets.ts`.
 *
 * Lets `PersonaPillar` show the culture/industry dropdown + diff modal
 * without a server round-trip. Kept in sync manually until a shared
 * package lands — the snapshot tests in `culturePresets.test.ts` flag
 * drift on the middleware side; the count assertion in
 * `CulturePresetDropdown.test.tsx` flags drift on the UI side.
 *
 * @see Issue #59
 */

import type { PersonaAxes } from './personaTypes';

export type CulturePresetId =
  | 'saas-startup'
  | 'enterprise-corporate'
  | 'healthcare'
  | 'legal'
  | 'ecommerce'
  | 'creative-agency';

export interface CulturePreset {
  id: CulturePresetId;
  labelKey: string;
  labelDe: string;
  descriptionDe: string;
  dimensions: Partial<PersonaAxes>;
}

export const CULTURE_PRESETS: readonly CulturePreset[] = [
  {
    id: 'saas-startup',
    labelKey: 'culture.saas-startup',
    labelDe: 'SaaS-Startup',
    descriptionDe: 'Locker, direkt, schnell',
    dimensions: {
      formality: 30,
      directness: 75,
      warmth: 55,
      humor: 40,
      conciseness: 75,
      proactivity: 80,
      autonomy: 70,
      risk_tolerance: 60,
      creativity: 65,
    },
  },
  {
    id: 'enterprise-corporate',
    labelKey: 'culture.enterprise-corporate',
    labelDe: 'Konzern / Großunternehmen',
    descriptionDe: 'Formell, prozesstreu, vorsichtig',
    dimensions: {
      formality: 85,
      directness: 45,
      warmth: 50,
      humor: 10,
      sarcasm: 0,
      conciseness: 40,
      proactivity: 50,
      autonomy: 30,
      risk_tolerance: 15,
      creativity: 25,
    },
  },
  {
    id: 'healthcare',
    labelKey: 'culture.healthcare',
    labelDe: 'Gesundheitswesen',
    descriptionDe: 'Formell, warm, risikoarm',
    dimensions: {
      formality: 75,
      directness: 60,
      warmth: 80,
      humor: 5,
      sarcasm: 0,
      conciseness: 50,
      proactivity: 40,
      autonomy: 20,
      risk_tolerance: 10,
      creativity: 15,
      drama: 5,
    },
  },
  {
    id: 'legal',
    labelKey: 'culture.legal',
    labelDe: 'Recht / Compliance',
    descriptionDe: 'Sehr formell, präzise, abwägend',
    dimensions: {
      formality: 90,
      directness: 70,
      warmth: 30,
      humor: 0,
      sarcasm: 0,
      conciseness: 30,
      proactivity: 35,
      autonomy: 15,
      risk_tolerance: 5,
      creativity: 10,
      philosophy: 60,
    },
  },
  {
    id: 'ecommerce',
    labelKey: 'culture.ecommerce',
    labelDe: 'E-Commerce',
    descriptionDe: 'Warm, lösungsorientiert, proaktiv',
    dimensions: {
      formality: 45,
      directness: 55,
      warmth: 75,
      humor: 30,
      conciseness: 65,
      proactivity: 70,
      autonomy: 50,
      risk_tolerance: 40,
      creativity: 50,
      drama: 25,
    },
  },
  {
    id: 'creative-agency',
    labelKey: 'culture.creative-agency',
    labelDe: 'Kreativagentur',
    descriptionDe: 'Locker, originell, mutig',
    dimensions: {
      formality: 20,
      directness: 60,
      warmth: 65,
      humor: 55,
      sarcasm: 30,
      conciseness: 50,
      proactivity: 75,
      autonomy: 75,
      risk_tolerance: 70,
      creativity: 85,
      drama: 50,
    },
  },
];

export function getCulturePreset(id: string): CulturePreset | undefined {
  return CULTURE_PRESETS.find((p) => p.id === id);
}

export interface CultureDiffEntry {
  axis: keyof PersonaAxes;
  before: number | undefined;
  after: number;
}

/**
 * Compute the diff list for the confirm modal — axes the preset would
 * change, with the existing value (or 'unset' indicator) and the new
 * preset value. Unchanged axes are omitted.
 */
export function diffCulturePreset(
  existing: PersonaAxes | undefined,
  presetId: string,
): CultureDiffEntry[] {
  const preset = getCulturePreset(presetId);
  if (!preset) return [];
  const out: CultureDiffEntry[] = [];
  for (const [axis, after] of Object.entries(preset.dimensions)) {
    if (typeof after !== 'number') continue;
    const before = existing?.[axis as keyof PersonaAxes];
    if (before === after) continue;
    out.push({ axis: axis as keyof PersonaAxes, before, after });
  }
  return out;
}

/** Apply preset overlay — preset values overwrite existing axes; unset axes pass through. */
export function applyCulturePreset(
  existing: PersonaAxes | undefined,
  presetId: string,
): PersonaAxes {
  const preset = getCulturePreset(presetId);
  if (!preset) return { ...(existing ?? {}) };
  return { ...(existing ?? {}), ...preset.dimensions };
}
