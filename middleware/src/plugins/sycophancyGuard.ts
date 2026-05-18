/**
 * Anti-sycophancy rule packages by domain risk level.
 *
 * Sycophancy (LLM bias toward user validation) is dangerous in professional
 * contexts. Based on Chandra et al. (2026), Sharma et al. (2023).
 *
 * Three risk tiers with escalating countermeasures:
 * - low:    FAQ, smalltalk — gentle fact-checking
 * - medium: advisory, code — balanced critical thinking
 * - high:   finance, medical, legal — mandatory devil's advocate
 *
 * Stored as a single enum on the AgentSpec (`quality.sycophancy`).
 * `compileSycophancyGuard` turns the persisted level into a system-prompt
 * fragment that `dynamicAgentRuntime` injects between persona and skill.
 *
 * Ported 1:1 from kemia (`byte5ai/kemia` @ `main` — src/lib/sycophancy-guard.ts).
 */

export type SycophancyLevel = 'off' | 'low' | 'medium' | 'high';

export interface SycophancyPackage {
  level: SycophancyLevel;
  /** i18n key in the "Sycophancy" namespace */
  labelKey: string;
  descriptionKey: string;
  /** Rules compiled into the system prompt */
  rules: string[];
}

export const SYCOPHANCY_PACKAGES: Record<Exclude<SycophancyLevel, 'off'>, SycophancyPackage> = {
  low: {
    level: 'low',
    labelKey: 'levelLow',
    descriptionKey: 'descLow',
    rules: [
      "Before agreeing with a user's claim, verify it against your knowledge. If you cannot verify it, say so.",
      "Do not use empty affirmations like 'Great question!' or 'You're absolutely right!' unless the statement is objectively correct.",
      "If a user's request contains a factual error, correct it politely before proceeding.",
    ],
  },
  medium: {
    level: 'medium',
    labelKey: 'levelMedium',
    descriptionKey: 'descMedium',
    rules: [
      'When making recommendations, always mention at least one alternative approach and its trade-offs.',
      'If a user proposes a solution, evaluate it critically. Name potential downsides before confirming.',
      "Never validate a user's emotional framing of a technical or factual question. Respond to the substance.",
      "When uncertain, express your confidence level explicitly (e.g., 'I'm fairly confident...' vs. 'I believe but cannot verify...').",
      "Do not mirror the user's assumed conclusion. Form your own assessment independently.",
    ],
  },
  high: {
    level: 'high',
    labelKey: 'levelHigh',
    descriptionKey: 'descHigh',
    rules: [
      'MANDATORY: For every recommendation or assessment, provide at least one counterargument — even if the user did not ask for one.',
      "MANDATORY: If a user presents a conclusion, play devil's advocate. Challenge assumptions explicitly before agreeing.",
      'MANDATORY: Never begin a response with agreement. Start with your independent analysis.',
      'When the user pushes back on your assessment, do NOT retract unless they provide new evidence. Hold your position if it is well-founded.',
      'Flag when a question has regulatory, legal, or financial implications. State that your response is informational only and cannot replace professional advice.',
      'If the user seems to be seeking confirmation rather than information, name this pattern explicitly and offer an objective assessment instead.',
      'Distinguish clearly between facts, professional consensus, and your inference. Label each.',
    ],
  },
};

/**
 * Compile sycophancy guard rules into system-prompt text.
 *
 * Returns the empty string for `off` and for an `undefined` level (legacy
 * specs without the field). Callers in `dynamicAgentRuntime` test the
 * return for non-emptiness before pushing into the `parts` assembly.
 */
export function compileSycophancyGuard(level: SycophancyLevel | undefined): string {
  if (!level || level === 'off') return '';

  const pkg = SYCOPHANCY_PACKAGES[level];
  if (!pkg) return '';

  const header =
    level === 'high'
      ? "## Anti-Sycophancy Protocol (STRICT — High-Risk Domain)"
      : level === 'medium'
        ? '## Critical Thinking Guidelines'
        : '## Accuracy Guidelines';

  const rules = pkg.rules.map((r) => `- ${r}`).join('\n');
  return `${header}\n${rules}`;
}

/**
 * Heuristic: does the persona suggest sycophancy risk?
 *
 * High empathy + low assertiveness = elevated risk. Returns a 0-100 score.
 * Mapped to omadia's persona axes: empathy → `warmth`, assertiveness → `directness`.
 */
export function estimateSycophancyRisk(persona: {
  empathy?: number;
  assertiveness?: number;
  formality?: number;
  humor?: number;
}): number {
  const empathy = persona.empathy ?? 50;
  const assertiveness = persona.assertiveness ?? 50;

  const risk = Math.round(empathy * 0.6 + (100 - assertiveness) * 0.4);

  return Math.min(100, Math.max(0, risk));
}

/** Threshold above which we warn if no sycophancy package is active. */
export const SYCOPHANCY_WARNING_THRESHOLD = 65;
