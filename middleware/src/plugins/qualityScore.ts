/**
 * Multidimensional quality score for the active draft.
 *
 * Issue #52 — ports kemia's `quality-score.ts`. Pure function (no DB,
 * no I/O) so both the backend route and the frontend panel can call
 * it. Weights and dimension structure verbatim from kemia; field map
 * adapted to omadia's spec (role/team live under `spec.skill`, not
 * `spec.persona`).
 */

import type { AgentSpecSkeleton } from './builder/types.js';

export type QualitySweetspot = 'under' | 'sweet' | 'over';

export interface QualitySuggestion {
  /** Stable code for filtering / i18n. */
  code:
    | 'missing_field'
    | 'vague_rule'
    | 'over_budget'
    | 'narrow_specificity'
    | 'thin_persona'
    | 'no_boundaries'
    | 'no_starters';
  /** Human-readable hint (German). */
  message: string;
  /** Which dimension surfaced this suggestion. */
  dimension: keyof QualityResult['dimensions'];
}

export interface QualityResult {
  /** Weighted overall score 0..100. */
  score: number;
  dimensions: {
    completeness: number;
    tokenEfficiency: number;
    ruleQuality: number;
    specificity: number;
  };
  sweetspot: QualitySweetspot;
  tokenHealth: 'ok' | 'warning' | 'critical';
  suggestions: QualitySuggestion[];
}

export interface QualityScoreOptions {
  /** Injectable token estimator. Default: `chars/4`. */
  estimateTokens?: (text: string) => number;
  /** Token thresholds (kemia defaults: 2000 / 3500 / 5000). */
  thresholds?: { target: number; warning: number; critical: number };
}

const DEFAULT_THRESHOLDS = { target: 2000, warning: 3500, critical: 5000 };

const WEIGHTS = {
  completeness: 0.3,
  tokenEfficiency: 0.2,
  ruleQuality: 0.25,
  specificity: 0.25,
};

const DEFAULT_TOKEN_ESTIMATOR = (s: string): number => Math.ceil(s.length / 4);

/**
 * Field mapping (kemia ↔ omadia):
 *
 *  kemia                              omadia
 *  --------------------------------   -------------------------------------
 *  spec.persona.jobTitle              spec.skill.role
 *  spec.persona.team                  spec.skill.tonality (closest proxy)
 *  spec.persona.dimensions            spec.persona.axes
 *  spec.role.tasks                    spec.tools.length
 *  spec.role.boundaries / custom      spec.quality.boundaries.{presets,custom}
 *  spec.role.behaviorRules            spec.playbook.when_to_use / not_for
 *  spec.starters                      spec.playbook.example_prompts
 *  spec.team / depends                spec.depends_on
 */
export function computeQualityScore(
  spec: AgentSpecSkeleton,
  opts: QualityScoreOptions = {},
): QualityResult {
  const estimateTokens = opts.estimateTokens ?? DEFAULT_TOKEN_ESTIMATOR;
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;

  const completeness = scoreCompleteness(spec);
  const tokenEfficiency = scoreTokenEfficiency(spec, estimateTokens, thresholds);
  const ruleQuality = scoreRuleQuality(spec);
  const specificity = scoreSpecificity(spec);

  const score = Math.round(
    completeness.value * WEIGHTS.completeness +
      tokenEfficiency.value * WEIGHTS.tokenEfficiency +
      ruleQuality.value * WEIGHTS.ruleQuality +
      specificity.value * WEIGHTS.specificity,
  );

  let sweetspot: QualitySweetspot;
  if (completeness.value < 40 || specificity.value < 25) {
    sweetspot = 'under';
  } else if (tokenEfficiency.value < 40) {
    sweetspot = 'over';
  } else {
    sweetspot = 'sweet';
  }

  const tokens = tokenEfficiency.tokens;
  let tokenHealth: 'ok' | 'warning' | 'critical';
  if (tokens >= thresholds.critical) tokenHealth = 'critical';
  else if (tokens >= thresholds.warning) tokenHealth = 'warning';
  else tokenHealth = 'ok';

  const suggestions: QualitySuggestion[] = [
    ...completeness.suggestions,
    ...tokenEfficiency.suggestions,
    ...ruleQuality.suggestions,
    ...specificity.suggestions,
  ];

  return {
    score: Math.min(100, Math.max(0, score)),
    dimensions: {
      completeness: completeness.value,
      tokenEfficiency: tokenEfficiency.value,
      ruleQuality: ruleQuality.value,
      specificity: specificity.value,
    },
    sweetspot,
    tokenHealth,
    suggestions,
  };
}

// ─── Completeness — 8-point scale, normalised to 100 ──────────────────────

function scoreCompleteness(spec: AgentSpecSkeleton): {
  value: number;
  suggestions: QualitySuggestion[];
} {
  const suggestions: QualitySuggestion[] = [];
  let pts = 0;

  // Persona (2 = axes non-empty AND ≥ 3 deviating axes)
  const axes = spec.persona?.axes ?? {};
  const axisCount = Object.values(axes).filter((v) => typeof v === 'number').length;
  if (axisCount >= 3) pts += 2;
  else if (axisCount > 0) pts += 1;
  else suggestions.push(thin('thin_persona', 'Persona-Achsen fehlen — mindestens 3 Achsen empfohlen.'));

  // Mission / description (1)
  if (typeof spec.description === 'string' && spec.description.trim().length > 0) {
    pts += 1;
  } else {
    suggestions.push(missing('Beschreibung (description) fehlt.'));
  }

  // Role (0.5)
  if (typeof spec.skill?.role === 'string' && spec.skill.role.trim().length > 0) {
    pts += 0.5;
  }

  // Tonality (0.5)
  if (typeof spec.skill?.tonality === 'string' && spec.skill.tonality.trim().length > 0) {
    pts += 0.5;
  }

  // Tools (1)
  if (Array.isArray(spec.tools) && spec.tools.length >= 1) {
    pts += 1;
  }

  // Behavior rules (1)
  const whenToUse = spec.playbook?.when_to_use ?? '';
  if (typeof whenToUse === 'string' && whenToUse.trim().length > 0) {
    pts += 1;
  }

  // Boundaries (1)
  const presets = spec.quality?.boundaries?.presets ?? [];
  const customLines = spec.quality?.boundaries?.custom ?? [];
  if (presets.length + customLines.length >= 1) {
    pts += 1;
  } else {
    suggestions.push({
      code: 'no_boundaries',
      message: 'Keine Boundaries definiert — Schutz vor Off-Topic-Antworten fehlt.',
      dimension: 'completeness',
    });
  }

  // Starters (0.5)
  const examples = spec.playbook?.example_prompts ?? [];
  if (Array.isArray(examples) && examples.length >= 2) {
    pts += 0.5;
  } else {
    suggestions.push({
      code: 'no_starters',
      message: 'Weniger als 2 Beispiel-Prompts — Operatoren brauchen Anknüpfungspunkte.',
      dimension: 'completeness',
    });
  }

  // Team / depends (0.5)
  if (Array.isArray(spec.depends_on) && spec.depends_on.length >= 1) {
    pts += 0.5;
  }

  return { value: Math.round((pts / 8) * 100), suggestions };
}

// ─── Token efficiency — linear; suggests "over_budget" past CRITICAL ──────

function scoreTokenEfficiency(
  spec: AgentSpecSkeleton,
  estimateTokens: (s: string) => number,
  thresholds: { target: number; warning: number; critical: number },
): {
  value: number;
  tokens: number;
  suggestions: QualitySuggestion[];
} {
  // Concatenate the operator-controlled fields kemia historically counts.
  // The compose-level prompt isn't available pure-function-side; this is a
  // close proxy.
  const parts: string[] = [];
  const pushIfNonEmpty = (s: string | undefined): void => {
    if (typeof s === 'string' && s.trim().length > 0) parts.push(s);
  };
  pushIfNonEmpty(spec.description);
  pushIfNonEmpty(spec.playbook?.when_to_use);
  for (const line of spec.playbook?.not_for ?? []) pushIfNonEmpty(line);
  for (const line of spec.quality?.boundaries?.custom ?? []) pushIfNonEmpty(line);
  pushIfNonEmpty(spec.persona?.custom_notes);
  for (const ex of spec.playbook?.example_prompts ?? []) pushIfNonEmpty(ex);

  const joined = parts.join('\n');
  const tokens = joined.length === 0 ? 0 : estimateTokens(joined);
  const suggestions: QualitySuggestion[] = [];

  // Linear with a "no content" floor:
  //   - 0 tokens → 0 (nothing to be efficient about)
  //   - 1..target → 100 (efficient)
  //   - target..critical → linear ramp 100 → 0
  //   - >= critical → 0 (over budget)
  let value: number;
  if (tokens === 0) value = 0;
  else if (tokens <= thresholds.target) value = 100;
  else if (tokens >= thresholds.critical) value = 0;
  else {
    const span = thresholds.critical - thresholds.target;
    const into = tokens - thresholds.target;
    value = Math.round(100 - (into / span) * 100);
  }

  if (tokens > thresholds.critical) {
    suggestions.push({
      code: 'over_budget',
      message: `Token-Budget überschritten (${tokens} > ${thresholds.critical}).`,
      dimension: 'tokenEfficiency',
    });
  }
  return { value: Math.min(100, Math.max(0, value)), tokens, suggestions };
}

// ─── Rule quality — heuristic penalties on when_to_use / not_for / custom ─

function scoreRuleQuality(spec: AgentSpecSkeleton): {
  value: number;
  suggestions: QualitySuggestion[];
} {
  const suggestions: QualitySuggestion[] = [];
  const lines: string[] = [];
  if (typeof spec.playbook?.when_to_use === 'string' && spec.playbook.when_to_use.length > 0) {
    lines.push(spec.playbook.when_to_use);
  }
  for (const l of spec.playbook?.not_for ?? []) lines.push(l);
  for (const l of spec.quality?.boundaries?.custom ?? []) lines.push(l);

  if (lines.length === 0) {
    // No rules at all — score is 0 (nothing to assess; AC: empty-spec ≤ 10).
    return { value: 0, suggestions: [] };
  }

  let penalty = 0;
  // 1. Vague rules (< 15 chars)
  const vague = lines.filter((l) => l.trim().length < 15);
  if (vague.length > 0) {
    penalty += Math.min(40, vague.length * 10);
    suggestions.push({
      code: 'vague_rule',
      message: `${vague.length} Regel(n) sind zu vage (< 15 Zeichen).`,
      dimension: 'ruleQuality',
    });
  }

  // 2. Only-DONTs penalty: when there's no when_to_use BUT lots of not_for
  if (
    (!spec.playbook?.when_to_use || spec.playbook.when_to_use.trim().length === 0) &&
    (spec.playbook?.not_for ?? []).length > 0
  ) {
    penalty += 10;
  }

  return { value: Math.min(100, Math.max(0, 100 - penalty)), suggestions };
}

// ─── Specificity — description length + tool descriptions + boundaries +
//                   example_prompts count ────────────────────────────────

function scoreSpecificity(spec: AgentSpecSkeleton): {
  value: number;
  suggestions: QualitySuggestion[];
} {
  const suggestions: QualitySuggestion[] = [];
  let pts = 0;

  // Description length (up to 40 pts)
  const dLen = (spec.description ?? '').trim().length;
  if (dLen >= 200) pts += 40;
  else if (dLen >= 80) pts += 25;
  else if (dLen >= 30) pts += 10;
  else if (dLen > 0) pts += 5;
  else
    suggestions.push({
      code: 'narrow_specificity',
      message: 'Beschreibung sehr kurz oder leer — mehr Kontext für den Agent fehlt.',
      dimension: 'specificity',
    });

  // Boundaries count (up to 30 pts)
  const presets = spec.quality?.boundaries?.presets ?? [];
  const customLines = spec.quality?.boundaries?.custom ?? [];
  const totalBoundaries = presets.length + customLines.length;
  pts += Math.min(30, totalBoundaries * 8);

  // example_prompts count (up to 20 pts)
  const examples = spec.playbook?.example_prompts ?? [];
  pts += Math.min(20, examples.length * 5);

  // Tools count (up to 10 pts)
  const tools = Array.isArray(spec.tools) ? spec.tools.length : 0;
  pts += Math.min(10, tools * 3);

  return { value: Math.min(100, Math.max(0, pts)), suggestions };
}

function missing(message: string): QualitySuggestion {
  return { code: 'missing_field', message, dimension: 'completeness' };
}

function thin(
  code: 'thin_persona',
  message: string,
): QualitySuggestion {
  return { code, message, dimension: 'completeness' };
}
