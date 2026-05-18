/**
 * Culture / industry presets for quick persona calibration.
 *
 * Orthogonal to F3 personaTemplates: a template sets identity + axes;
 * a culture preset overlays axes only. Selection is one-shot — the
 * UI assembles the full merged persona and sends a single
 * `setPersonaConfig` call. Preset id itself is NOT persisted.
 *
 * Ported 1:1 from `byte5ai/kemia@main:src/lib/culture-presets.ts`.
 * The kemia axis names are camelCase (`riskTolerance`); the omadia
 * schema uses snake_case (`risk_tolerance`) — converted mechanically
 * in the literals below.
 *
 * @see Issue #59
 */

import type { PersonaAxes } from './agentSpec.js';

export type CulturePresetId =
  | 'saas-startup'
  | 'enterprise-corporate'
  | 'healthcare'
  | 'legal'
  | 'ecommerce'
  | 'creative-agency';

export interface CulturePreset {
  id: CulturePresetId;
  /** i18n key in the "Persona" namespace. */
  labelKey: string;
  /** Short German description (fallback when no i18n bundle is loaded). */
  descriptionDe: string;
  /** Partial overlay — only the named axes are overwritten. */
  dimensions: Partial<PersonaAxes>;
}

export const CULTURE_PRESETS: readonly CulturePreset[] = [
  {
    id: 'saas-startup',
    labelKey: 'culture.saas-startup',
    descriptionDe: 'SaaS-Startup — locker, direkt, schnell',
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
    descriptionDe: 'Konzern / Großunternehmen — formell, prozesstreu, vorsichtig',
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
    descriptionDe: 'Gesundheitswesen — formell, warm, risikoarm',
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
    descriptionDe: 'Recht / Compliance — sehr formell, präzise, abwägend',
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
    descriptionDe: 'E-Commerce — warm, lösungsorientiert, proaktiv',
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
    descriptionDe: 'Kreativagentur — locker, originell, mutig',
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

/**
 * Apply a culture preset overlay on top of existing axes. Preset
 * dimensions overwrite the existing axis value; unset axes pass through
 * unchanged. Returns a new object — never mutates the input.
 */
export function applyCulturePreset(
  existing: PersonaAxes | undefined,
  presetId: string,
): PersonaAxes {
  const preset = getCulturePreset(presetId);
  if (!preset) return { ...(existing ?? {}) };
  return { ...(existing ?? {}), ...preset.dimensions };
}
