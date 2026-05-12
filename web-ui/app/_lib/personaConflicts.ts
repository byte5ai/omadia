// -----------------------------------------------------------------------------
// Phase 3 / OB-67 — Persona × Quality conflict detector.
//
// Pure function with no side effects so it can be unit-tested in isolation
// and called on every Slider onChange. Conflict shapes follow
// docs/harness-platform/specs/persona-ui-v1.md §6.4.
//
// "Hard" conflicts surface as a dismissible-but-persistent banner over
// the persona pillar; "soft" conflicts render inline under each affected
// slider. Empty result = silence (no banner, no inline icons).
// -----------------------------------------------------------------------------

import type { QualityConfig } from './builderTypes';
import { PERSONA_AXIS_NEUTRAL, type PersonaConfig } from './personaTypes';

export type ConflictSeverity = 'soft' | 'hard';

export interface PersonaConflictWarning {
  /** 'hard' = banner over the pillar; 'soft' = inline at slider level. */
  severity: ConflictSeverity;
  /** Stable opaque id for React keys + dismiss-tracking. */
  id: string;
  /** Dotted source paths involved in the conflict (e.g.
   *  `'quality.sycophancy'`, `'persona.directness'`). The pillar uses
   *  these to attach inline-icons to the right Slider components. */
  axes: string[];
  /** Operator-readable explanation; rendered verbatim in the banner /
   *  hover-text. Includes the recommended fix wherever a clear one
   *  exists ("→ directness ≥ 50 ODER sycophancy=medium"). */
  message: string;
}

/**
 * Spec §6.4 trigger rules — order matters only for the dismissal-id
 * stability (each rule has its own opaque `id`). Rule rationale lives in
 * the spec; keep the rule body terse.
 */
export function detectPersonaConflicts(
  quality: QualityConfig | undefined,
  persona: PersonaConfig | undefined,
): PersonaConflictWarning[] {
  const out: PersonaConflictWarning[] = [];
  const sycophancy = quality?.sycophancy;
  const ax = persona?.axes ?? {};
  const directness = ax.directness ?? PERSONA_AXIS_NEUTRAL;
  const warmth = ax.warmth ?? PERSONA_AXIS_NEUTRAL;
  const formality = ax.formality ?? PERSONA_AXIS_NEUTRAL;
  const humor = ax.humor ?? PERSONA_AXIS_NEUTRAL;
  const sarcasm = ax.sarcasm ?? PERSONA_AXIS_NEUTRAL;

  // ── Hard: Devil's-Advocate vs. diplomatic ────────────────────────────
  if (sycophancy === 'high' && directness <= 30) {
    out.push({
      severity: 'hard',
      id: 'sycophancy-high__directness-low',
      axes: ['quality.sycophancy', 'persona.directness'],
      message:
        'Sycophancy=high erzwingt Devil\'s-Advocate-Rules; directness ≤ 30 ' +
        'sagt „diplomatisch". Modell wird eines der beiden ignorieren. ' +
        'Empfehlung: directness ≥ 50 oder sycophancy=medium.',
    });
  }

  // ── Soft: amplification (Devil's-Advocate + very direct) ─────────────
  if (sycophancy === 'high' && directness >= 70) {
    out.push({
      severity: 'soft',
      id: 'sycophancy-high__directness-high',
      axes: ['quality.sycophancy', 'persona.directness'],
      message:
        'Verstärkung — kritische Bewertung + ohne Höflichkeitspuffer ' +
        'kann streitlustig wirken.',
    });
  }

  // ── Soft hint: directness alone does not lift sycophancy=off ────────
  if (sycophancy === 'off' && directness >= 90) {
    out.push({
      severity: 'soft',
      id: 'sycophancy-off__directness-veryhigh',
      axes: ['quality.sycophancy', 'persona.directness'],
      message:
        'Hinweis: directness ≥ 90 hebt das Modell-Default-Schmeichel-' +
        'Verhalten allein nicht auf. Für anti-Sycophancy bewusst ein ' +
        'sycophancy-Level wählen.',
    });
  }

  // ── Soft: stylistic cluster (formal + humorous) ─────────────────────
  if (formality >= 80 && humor >= 70) {
    out.push({
      severity: 'soft',
      id: 'formality-high__humor-high',
      axes: ['persona.formality', 'persona.humor'],
      message:
        'Sehr formell + sehr humorvoll wirkt stilistisch inkonsistent.',
    });
  }

  // ── Soft: sarcasm + warmth contradict each other ────────────────────
  if (sarcasm >= 70 && warmth >= 70) {
    out.push({
      severity: 'soft',
      id: 'sarcasm-high__warmth-high',
      axes: ['persona.sarcasm', 'persona.warmth'],
      message: 'Hoher Sarkasmus + hohe Wärme — Antworten wirken widersprüchlich.',
    });
  }

  return out;
}

/**
 * Quick checker for the Workspace-Tab badge — does the operator need to
 * see the persona pillar because something diverges? Returns the count
 * of hard conflicts (hard = badge red, soft conflicts only ≠ no badge).
 */
export function countHardConflicts(
  warnings: readonly PersonaConflictWarning[],
): number {
  return warnings.filter((w) => w.severity === 'hard').length;
}
