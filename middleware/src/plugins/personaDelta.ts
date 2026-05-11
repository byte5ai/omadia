import {
  CORE_PERSONA_AXES,
  EXTENDED_PERSONA_AXES,
  type PersonaAxes,
} from './builder/agentSpec.js';

/**
 * Phase 3 / OB-67 Slice 8 — model-family persona defaults + delta-compute.
 *
 * Each Anthropic model family (Sonnet 4.6, Opus 4.7, Haiku 4.5) ships
 * with its own baseline behaviour: Sonnet defaults to balanced and
 * mildly diplomatic, Opus is more expansive + reflective, Haiku is
 * tighter and more direct. When the operator sets `persona.directness:
 * 50` we should NOT emit a "be moderately direct" instruction — that's
 * already the family default. Only deviations matter.
 *
 * The defaults below are heuristic — confidence tier "estimated"
 * (qualitative-from-sources, no controlled measurement). They are good
 * enough to drive delta-emission for Phase 3; Phase-4 / harness-persona
 * may refine them empirically once Builder-ops data accumulates.
 *
 * Threshold model (Kemia convention):
 *   - |delta| ≤ 15 → "neutral"     → no emission
 *   - |delta| 16–29 → "slightly"   → soft emission ("a bit more direct")
 *   - |delta| ≥ 30 → "strong"      → assertive emission ("very direct")
 *
 * Pure functions, no I/O.
 */

/**
 * Anthropic model-family identifiers as we group them in the orchestrator.
 * The Builder lets users pick `haiku | sonnet | opus`; the runtime maps
 * those onto the actual model id (sonnet → claude-sonnet-4-6, …) but
 * persona-delta only cares about the family tier.
 */
export type PersonaModelFamily = 'sonnet' | 'opus' | 'haiku';

/**
 * Per-family baseline. Every axis carries a 0–100 estimate of the
 * model's natural-default behaviour. Values are the result of qualitative
 * comparison ("Opus is noticeably more expansive than Haiku at the same
 * prompt") — refine with empirical data later.
 */
export const FAMILY_DEFAULTS: Record<PersonaModelFamily, Required<PersonaAxes>> = {
  sonnet: {
    formality: 50,
    directness: 55,
    warmth: 60,
    humor: 35,
    sarcasm: 15,
    conciseness: 45,
    proactivity: 45,
    autonomy: 50,
    risk_tolerance: 40,
    creativity: 55,
    drama: 35,
    philosophy: 45,
  },
  opus: {
    formality: 55,
    directness: 50,
    warmth: 55,
    humor: 40,
    sarcasm: 15,
    conciseness: 35,
    proactivity: 50,
    autonomy: 60,
    risk_tolerance: 45,
    creativity: 65,
    drama: 40,
    philosophy: 60,
  },
  haiku: {
    formality: 45,
    directness: 60,
    warmth: 50,
    humor: 30,
    sarcasm: 10,
    conciseness: 65,
    proactivity: 35,
    autonomy: 45,
    risk_tolerance: 35,
    creativity: 45,
    drama: 30,
    philosophy: 35,
  },
};

export const NEUTRAL_THRESHOLD = 15;
export const STRONG_THRESHOLD = 30;

export type DeltaMagnitude = 'neutral' | 'slightly' | 'strong';
export type DeltaDirection = 'lower' | 'higher';

export interface PersonaAxisDelta {
  axis: keyof PersonaAxes;
  /** Operator-set value 0–100. */
  value: number;
  /** Family-default for this axis. */
  base: number;
  /** Signed delta (value - base). */
  delta: number;
  /** Bucketed magnitude — drives compose strength. */
  magnitude: DeltaMagnitude;
  /** Direction relative to base. Only meaningful when magnitude !== 'neutral'. */
  direction: DeltaDirection;
}

/**
 * Compute deltas for every axis the operator has set. Axes that are
 * unset (undefined in `persona.axes`) are skipped — the operator
 * intentionally chose to inherit the family default. Axes whose delta
 * is within `NEUTRAL_THRESHOLD` are also skipped at the call site
 * (compose) — they are still returned here for telemetry / preview.
 */
export function computePersonaDeltas(
  axes: PersonaAxes | undefined,
  family: PersonaModelFamily,
): PersonaAxisDelta[] {
  if (!axes) return [];
  const base = FAMILY_DEFAULTS[family];
  const out: PersonaAxisDelta[] = [];

  for (const axis of [...CORE_PERSONA_AXES, ...EXTENDED_PERSONA_AXES]) {
    const value = axes[axis];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const baseValue = base[axis];
    const delta = value - baseValue;
    const abs = Math.abs(delta);
    const magnitude: DeltaMagnitude =
      abs <= NEUTRAL_THRESHOLD
        ? 'neutral'
        : abs >= STRONG_THRESHOLD
          ? 'strong'
          : 'slightly';
    out.push({
      axis,
      value,
      base: baseValue,
      delta,
      magnitude,
      direction: delta < 0 ? 'lower' : 'higher',
    });
  }
  return out;
}

/**
 * Return only the deltas that are worth emitting (magnitude !== 'neutral').
 * Useful at the compose call site so the XML section stays terse.
 */
export function significantDeltas(
  deltas: readonly PersonaAxisDelta[],
): PersonaAxisDelta[] {
  return deltas.filter((d) => d.magnitude !== 'neutral');
}
