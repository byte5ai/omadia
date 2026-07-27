/**
 * Phase 2.3 — Health-Score Pure-Function (OB-65).
 *
 * Translates an asset-level diff (snapshot vs. live) into a 0-100 health
 * score plus operator-readable suggestions. Heuristic, NOT authoritative;
 * the UI surfaces this with a tooltip making clear it's a guidance signal,
 * not an automatic reject-trigger.
 *
 * Design notes:
 * - Pure function, zero IO. Trivially testable + safe to call from both the
 *   cron worker (computes + persists) and the UI (preview without writes).
 * - Score weighted by asset-path patterns. First match wins. Default
 *   fallback weight 0.1 ("noise") so rapid churn in low-signal files
 *   (e.g. operator-curated knowledge logs) doesn't scare the operator.
 * - Identical paths are excluded — only added/removed/modified matter.
 * - Suggestion-IDs are stable so the UI can dedupe and React keys are
 *   well-behaved. Don't rename them without coordinating UI + Notion.
 *
 * Issue #499 — context-quality decomposition. `computeContextQualityScore`
 * below decomposes the drift-style single number into the seven
 * context-quality criteria validated by arXiv:2607.14275 ("AI Agents Do
 * Not Fail Alone: The Context Fails First"), each predicting a specific
 * failure mode. Four are deterministic (guardrail coverage, tool schema
 * quality, grounding attachment, token efficiency); the remaining three
 * (role clarity, instruction consistency, and the judgment half of
 * grounding sufficiency) are judgment-heavy and require an LLM-juror pass
 * that is NOT implemented in this slice — they're returned with
 * `evaluated: false` and a rationale explaining why. This is intentionally
 * additive: `computeHealthScore` (drift score) is untouched for backward
 * compat; the new function is a separate pure function on the agent spec.
 */

import { validateSpecForCodegen, type AgentSpec } from '../plugins/builder/agentSpec.js';
import {
  BOUNDARY_PRESETS,
  getBoundaryPreset,
  type BoundaryCategory,
} from '../plugins/builder/boundaryPresets.js';
import { validateSpec } from '../plugins/builder/manifestLinter.js';
import { composePersonaSection } from '../plugins/personaCompose.js';
import type { PersonaModelFamily } from '../plugins/personaDelta.js';
import type { AssetDiff } from './snapshotService.js';

export interface AssetWeight {
  /** Path patterns (substring match) → weight 0-1. Order matters: first
   *  match wins. Default fallback weight is 0.1 ("noise"). */
  pattern: string;
  weight: number;
}

export const DEFAULT_ASSET_WEIGHTS: ReadonlyArray<AssetWeight> = [
  { pattern: 'agent.md', weight: 1.0 },
  { pattern: 'knowledge/spec.json', weight: 0.8 },
  { pattern: 'plugins/', weight: 0.6 },
  { pattern: 'knowledge/', weight: 0.4 },
];

/** Implicit weight for any asset path not matched by an explicit pattern. */
export const FALLBACK_ASSET_WEIGHT = 0.1;

export interface HealthScoreInput {
  /** Result of `SnapshotService.diff(base=snapshot, target=live)`. */
  diffs: ReadonlyArray<AssetDiff>;
  /** Optional override; defaults to DEFAULT_ASSET_WEIGHTS. */
  weights?: ReadonlyArray<AssetWeight>;
}

export type DivergedAssetStatus = 'added' | 'removed' | 'modified';

export interface DivergedAsset {
  path: string;
  status: DivergedAssetStatus;
  weight: number;
}

export type SuggestionSeverity = 'info' | 'warn' | 'critical';

export interface HealthSuggestion {
  /** Stable ID — UI dedupes, React keys, telemetry filtering. */
  id: string;
  severity: SuggestionSeverity;
  message: string;
}

export interface HealthScoreResult {
  /** 0-100, integer. 100 = no drift, 0 = every weighted asset diverged. */
  score: number;
  /** Per-asset signal — drives the Suggestion-list and the UI tooltip. */
  divergedAssets: ReadonlyArray<DivergedAsset>;
  /** Operator-readable suggestions. Stable IDs for React keys. */
  suggestions: ReadonlyArray<HealthSuggestion>;
}

function weightFor(
  path: string,
  weights: ReadonlyArray<AssetWeight>,
): number {
  for (const w of weights) {
    if (path.includes(w.pattern)) return w.weight;
  }
  return FALLBACK_ASSET_WEIGHT;
}

function isDivergedStatus(
  s: AssetDiff['status'],
): s is DivergedAssetStatus {
  return s === 'added' || s === 'removed' || s === 'modified';
}

export function computeHealthScore(input: HealthScoreInput): HealthScoreResult {
  const weights = input.weights ?? DEFAULT_ASSET_WEIGHTS;

  const diverged: DivergedAsset[] = [];
  for (const d of input.diffs) {
    if (!isDivergedStatus(d.status)) continue;
    diverged.push({
      path: d.path,
      status: d.status,
      weight: weightFor(d.path, weights),
    });
  }

  // Score = 100 - sum(weights) * 100 / max(totalAddressableWeight, 1).
  // The "max addressable weight" is the maximum weight any single asset
  // could carry (i.e. the heaviest weight pattern). This anchors the
  // ratio so a single agent.md-drift drops the score by ~100 (every
  // critical asset diverged), while a single noise-file drift drops it
  // only marginally — independent of how many assets exist.
  const maxWeight = Math.max(
    FALLBACK_ASSET_WEIGHT,
    ...weights.map((w) => w.weight),
  );
  const summed = diverged.reduce((acc, d) => acc + d.weight, 0);
  const rawScore = 100 - (summed * 100) / maxWeight;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  const suggestions = buildSuggestions(diverged, score);

  return { score, divergedAssets: diverged, suggestions };
}

function buildSuggestions(
  diverged: ReadonlyArray<DivergedAsset>,
  score: number,
): HealthSuggestion[] {
  const out: HealthSuggestion[] = [];
  const seen = new Set<string>();
  const push = (s: HealthSuggestion): void => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    out.push(s);
  };

  for (const d of diverged) {
    if (d.path.includes('agent.md')) {
      push({
        id: 'agent-md-modified',
        severity: 'critical',
        message: 'Persona/Quality drifted — Snapshot aktualisieren',
      });
    } else if (d.path.includes('plugins/')) {
      push({
        id: 'plugins-modified',
        severity: 'critical',
        message: 'Pin-Drift — Plugin neu vendored seit Snapshot',
      });
    } else if (d.path.includes('knowledge/')) {
      push({
        id: 'knowledge-modified',
        severity: 'warn',
        message: 'Operator-Knowledge drifted seit letztem Deploy',
      });
    }
  }

  if (score < 30) {
    push({
      id: 'score-critical',
      severity: 'critical',
      message: 'Live-State unterscheidet sich substantiell vom letzten Deploy',
    });
  } else if (score < 70) {
    push({
      id: 'score-warn',
      severity: 'warn',
      message: 'Erheblicher Drift — Re-Snapshot empfohlen',
    });
  }

  return out;
}

// ─── Issue #499 — context-quality criteria decomposition ──────────────────

/** The seven criteria validated by arXiv:2607.14275, mapped 1:1 to the
 *  omadia subsystem that produces the signal (see the issue's table). */
export type ContextQualityCriterionId =
  | 'role_clarity'
  | 'guardrail_coverage'
  | 'instruction_consistency'
  | 'tool_schema_quality'
  | 'grounding_sufficiency'
  | 'injection_hardening'
  | 'token_efficiency';

/** The failure mode each criterion is a leading indicator for. */
export type PredictedFailureMode =
  | 'incoherent_behavior'
  | 'manipulation_susceptible'
  | 'instruction_drift'
  | 'tool_misuse'
  | 'hallucination'
  | 'prompt_injection'
  | 'cost_overrun';

export interface ContextQualityCriterionResult {
  id: ContextQualityCriterionId;
  label: string;
  /** 0-100, or `null` when `evaluated` is false (criterion not assessed
   *  in this build — e.g. pending the LLM-juror pass). */
  score: number | null;
  /** `true` for the deterministic checks; `false` for judgment-heavy
   *  criteria until issue #499 item 3 (LLM-juror pass) lands. */
  evaluated: boolean;
  /** Operator-readable explanation of the score, or of why it's absent. */
  rationale: string;
  /** The failure mode this criterion predicts. */
  predictedFailureMode: PredictedFailureMode;
  /** Actionable next step to raise the score. */
  fixHint: string;
}

export interface ContextQualityResult {
  /** 0-100 aggregate — unweighted mean over the *evaluated* criteria only,
   *  kept alongside the per-criterion breakdown for backward compat with
   *  the single-number health-score surface. Un-evaluated criteria are
   *  excluded rather than defaulted to 0 so a missing LLM-juror pass
   *  doesn't silently drag the number down. */
  score: number;
  criteria: ContextQualityCriterionResult[];
}

export interface ContextQualityOptions {
  /** Injectable token estimator for the persona-delta budget check.
   *  Default: `chars/4`. */
  estimateTokens?: (text: string) => number;
  /** Token thresholds for the persona <persona> section specifically —
   *  much smaller than a full-prompt budget, hence separate defaults
   *  from `qualityScore.ts`'s whole-spec thresholds. */
  personaTokenThresholds?: { target: number; warning: number; critical: number };
  /** Model family used to resolve persona-axis baselines. Scoring is
   *  family-agnostic in intent, so this only matters at the margin. */
  personaFamily?: PersonaModelFamily;
}

const DEFAULT_CONTEXT_TOKEN_ESTIMATOR = (s: string): number => Math.ceil(s.length / 4);
const DEFAULT_PERSONA_TOKEN_THRESHOLDS = { target: 250, warning: 450, critical: 700 };
const DEFAULT_PERSONA_FAMILY: PersonaModelFamily = 'sonnet';

const JUROR_PASS_PENDING_RATIONALE =
  'Judgment-heavy criterion — requires the LLM-juror pass (issue #499 item 3), which is ' +
  'gated behind a config flag and not implemented in this slice. No deterministic proxy ' +
  'exists for this signal today.';

const TOTAL_BOUNDARY_CATEGORIES = new Set(BOUNDARY_PRESETS.map((p) => p.category)).size;

/**
 * Decompose Builder/live agent-spec quality into the seven context-quality
 * criteria. Pure function — no IO — so it can run at Builder build-time
 * (`builderQuality.ts`) and, once wired (issue #499 item 5, deferred), from
 * the drift worker against a live profile's parsed spec.
 */
export function computeContextQualityScore(
  spec: AgentSpec,
  opts: ContextQualityOptions = {},
): ContextQualityResult {
  const criteria: ContextQualityCriterionResult[] = [
    notYetEvaluated(
      'role_clarity',
      'Role clarity',
      'incoherent_behavior',
      'Sharpen spec.skill.role, spec.description, and persona.axes — role clarity is ' +
        'judged by the LLM-juror pass once enabled.',
    ),
    scoreGuardrailCoverage(spec),
    notYetEvaluated(
      'instruction_consistency',
      'Instruction consistency',
      'instruction_drift',
      'Review playbook.when_to_use / not_for / quality.boundaries.custom for contradictions ' +
        '— instruction consistency is judged by the LLM-juror pass once enabled.',
    ),
    scoreToolSchemaQuality(spec),
    scoreGroundingAttached(spec),
    notYetEvaluated(
      'injection_hardening',
      'Injection hardening',
      'prompt_injection',
      'Audit sanitizer/shield coverage of every input surface the agent exposes — no ' +
        'deterministic check is wired yet.',
    ),
    scoreTokenEfficiency(spec, opts),
  ];

  const evaluated = criteria.filter(
    (c): c is ContextQualityCriterionResult & { score: number } =>
      c.evaluated && c.score !== null,
  );
  const score =
    evaluated.length === 0
      ? 0
      : Math.round(evaluated.reduce((sum, c) => sum + c.score, 0) / evaluated.length);

  return { score, criteria };
}

function notYetEvaluated(
  id: ContextQualityCriterionId,
  label: string,
  predictedFailureMode: PredictedFailureMode,
  fixHint: string,
): ContextQualityCriterionResult {
  return {
    id,
    label,
    score: null,
    evaluated: false,
    rationale: JUROR_PASS_PENDING_RATIONALE,
    predictedFailureMode,
    fixHint,
  };
}

/** Guardrail coverage — boundary-preset category coverage + custom lines.
 *  Deterministic proxy for manipulation resistance. */
function scoreGuardrailCoverage(spec: AgentSpec): ContextQualityCriterionResult {
  const presetIds = spec.quality?.boundaries?.presets ?? [];
  const customLines = (spec.quality?.boundaries?.custom ?? []).filter(
    (l) => l.trim().length > 0,
  );

  const categories = new Set<BoundaryCategory>();
  for (const id of presetIds) {
    const preset = getBoundaryPreset(id);
    if (preset) categories.add(preset.category);
  }

  // Up to 80 pts for category spread, up to 20 pts for custom lines — a
  // handful of well-chosen presets across categories outweighs a pile of
  // custom lines in one category, matching the paper's "coverage, not
  // volume" framing.
  const categoryScore = (categories.size / TOTAL_BOUNDARY_CATEGORIES) * 80;
  const customBonus = Math.min(20, customLines.length * 10);
  const score = Math.round(Math.min(100, categoryScore + customBonus));

  const rationale =
    presetIds.length === 0 && customLines.length === 0
      ? 'No boundary presets or custom guardrail lines configured (quality.boundaries) — ' +
        'the agent has no manipulation-resistance guardrails.'
      : `${String(categories.size)}/${String(TOTAL_BOUNDARY_CATEGORIES)} boundary categories ` +
        `covered${categories.size > 0 ? ` (${[...categories].join(', ')})` : ''}; ` +
        `${String(customLines.length)} custom guardrail line(s).`;

  const fixHint =
    score >= 100
      ? 'Guardrail coverage spans all boundary categories — no action needed.'
      : 'Add boundary presets from the missing categories (data / scope / authority / ' +
        'communication) via quality.boundaries.presets, or add custom guardrail lines.';

  return {
    id: 'guardrail_coverage',
    label: 'Guardrail coverage',
    score,
    evaluated: true,
    rationale,
    predictedFailureMode: 'manipulation_susceptible',
    fixHint,
  };
}

/** Tool schema quality — manifestLinter.validateSpec's tool-id checks
 *  (uniqueness + snake_case syntax) PLUS agentSpec.validateSpecForCodegen's
 *  cross-namespace checks. manifestLinter only looks at spec.tools[] in
 *  isolation; spec.external_reads[] shares the same toolkit id namespace at
 *  runtime, so a tools[] id colliding with an external_reads id (or an
 *  external_reads id in the reserved namespace) passes manifestLinter clean
 *  but breaks at codegen/install (last-write-wins tool registration). This
 *  is exactly the codegen gate the builder actually runs before activation,
 *  so cross-checking it here keeps the score honest about what will really
 *  fail. Deterministic proxy for correct tool use: a malformed or colliding
 *  tool id is a direct precursor to tool-misuse at runtime. */
function scoreToolSchemaQuality(spec: AgentSpec): ContextQualityCriterionResult {
  const tools = spec.tools ?? [];
  const externalReads = spec.external_reads ?? [];
  const totalEntries = tools.length + externalReads.length;

  const lint = validateSpec(spec);
  const toolViolations = lint.violations.filter(
    (v) => v.kind === 'tool_id_duplicate' || v.kind === 'tool_id_invalid_syntax',
  );

  const codegenIssues = validateSpecForCodegen(spec);
  const namespaceViolations = codegenIssues.filter(
    (i) => i.code === 'external_read_id_collides_with_tool' || i.code === 'reserved_tool_id',
  );

  const totalViolations = toolViolations.length + namespaceViolations.length;

  let score: number;
  let rationale: string;
  if (totalEntries === 0) {
    score = 100;
    rationale = 'No tools or external_reads declared — nothing to validate.';
  } else if (totalViolations === 0) {
    score = 100;
    rationale =
      `${String(tools.length)} tool(s) and ${String(externalReads.length)} external_reads ` +
      "entry(ies) declared, all pass manifestLinter's tool-id checks (unique, snake_case) " +
      'and the codegen namespace/reserved-id checks.';
  } else {
    score = Math.max(0, 100 - totalViolations * 25);
    const descriptions = [
      ...toolViolations.map((v) => `${v.kind} (${v.path})`),
      ...namespaceViolations.map((v) => `${v.code} (${v.toolId ?? 'unknown id'})`),
    ];
    rationale =
      `${String(totalViolations)} of ${String(totalEntries)} tool/external_reads entries fail ` +
      `schema or namespace checks: ${descriptions.join('; ')}.`;
  }

  const fixHint =
    totalViolations > 0
      ? 'Fix the tool-id syntax/duplicate violations from manifestLinter.validateSpec and the ' +
        'namespace-collision/reserved-id violations from agentSpec.validateSpecForCodegen — ' +
        'malformed or colliding ids crash codegen or collide at install.'
      : 'Tool and external_reads schemas are clean.';

  return {
    id: 'tool_schema_quality',
    label: 'Tool schema quality',
    score,
    evaluated: true,
    rationale,
    predictedFailureMode: 'tool_misuse',
    fixHint,
  };
}

/** Grounding sufficiency — deterministic "is a knowledge source attached
 *  AND actually resolvable" proxy (permissions.graph.entity_systems /
 *  external_reads). An external_reads entry whose service isn't in
 *  serviceTypeRegistry, or whose providing plugin is missing from
 *  depends_on, throws at codegen time (see manifestLinter's
 *  external_read_unknown_service / external_read_integration_missing) —
 *  such an entry isn't a real grounding source, so it's excluded from the
 *  attachment count rather than trusted at face value. This still only
 *  checks attachment/resolvability, not whether the source actually
 *  covers the agent's domain — that judgment is deferred to the
 *  LLM-juror pass (issue #499 item 3). */
function scoreGroundingAttached(spec: AgentSpec): ContextQualityCriterionResult {
  const entitySystems = spec.permissions?.graph?.entity_systems ?? [];
  const externalReads = spec.external_reads ?? [];
  const hasGraph = entitySystems.length > 0;

  const lint = validateSpec(spec);
  const brokenExternalReadPaths = new Set(
    lint.violations
      .filter(
        (v) =>
          v.kind === 'external_read_unknown_service' ||
          v.kind === 'external_read_integration_missing',
      )
      .map((v) => v.path),
  );
  const workingExternalReads = externalReads.filter(
    (_, i) => !brokenExternalReadPaths.has(`/external_reads/${String(i)}/service`),
  );
  const brokenCount = externalReads.length - workingExternalReads.length;
  const hasWorkingExternalReads = workingExternalReads.length > 0;
  const attached = hasGraph || hasWorkingExternalReads;

  const sources: string[] = [];
  if (hasGraph) sources.push(`knowledge-graph entity systems (${entitySystems.join(', ')})`);
  if (hasWorkingExternalReads) {
    sources.push(`${String(workingExternalReads.length)} working external_reads binding(s)`);
  }

  const rationale = attached
    ? `Knowledge source attached: ${sources.join(' + ')}` +
      (brokenCount > 0
        ? `; ${String(brokenCount)} external_reads binding(s) reference an unresolvable ` +
          "service and don't count."
        : '.') +
      ' This checks attachment/resolvability only, not sufficiency of domain coverage.'
    : brokenCount > 0
      ? `${String(brokenCount)} external_reads binding(s) reference an unknown service or a ` +
        'missing depends_on entry — none of them resolve, so no knowledge source is actually ' +
        'attached (see manifestLinter.validateSpec for details).'
      : 'No knowledge source attached — permissions.graph.entity_systems and external_reads ' +
        'are both empty. The agent has nothing to ground answers in beyond model priors.';

  const fixHint = attached
    ? 'A grounding source is attached and resolves. Whether it actually covers the agent\'s ' +
      'domain requires the LLM-juror pass.'
    : brokenCount > 0
      ? "Fix the external_reads service name(s) or add the missing plugin to depends_on " +
        '(see manifestLinter.validateSpec violations) so the binding actually resolves.'
      : 'Attach a knowledge-graph entity system (permissions.graph.entity_systems) or an ' +
        'external_reads binding so the agent can ground answers in real data.';

  return {
    id: 'grounding_sufficiency',
    label: 'Grounding sufficiency',
    score: attached ? 100 : 0,
    evaluated: true,
    rationale,
    predictedFailureMode: 'hallucination',
    fixHint,
  };
}

/** Token efficiency — persona-delta token budget. Composes the actual
 *  `<persona>` system-prompt section via `personaCompose.ts` (the same
 *  function the runtime uses) and scores its token cost against a
 *  small-budget threshold; this is deliberately narrower than
 *  `qualityScore.ts`'s whole-spec token dimension — it isolates the
 *  persona-configuration cost specifically, per the issue's proposal. */
function scoreTokenEfficiency(
  spec: AgentSpec,
  opts: ContextQualityOptions,
): ContextQualityCriterionResult {
  const estimateTokens = opts.estimateTokens ?? DEFAULT_CONTEXT_TOKEN_ESTIMATOR;
  const thresholds = opts.personaTokenThresholds ?? DEFAULT_PERSONA_TOKEN_THRESHOLDS;
  const family = opts.personaFamily ?? DEFAULT_PERSONA_FAMILY;

  const personaSection = composePersonaSection({ persona: spec.persona, family });
  const tokens = personaSection.length === 0 ? 0 : estimateTokens(personaSection);

  let score: number;
  if (tokens === 0) score = 100;
  else if (tokens <= thresholds.target) score = 100;
  else if (tokens >= thresholds.critical) score = 0;
  else {
    const span = thresholds.critical - thresholds.target;
    const into = tokens - thresholds.target;
    score = Math.round(100 - (into / span) * 100);
  }
  score = Math.min(100, Math.max(0, score));

  const rationale =
    tokens === 0
      ? 'No persona delta configured — the persona system-prompt section is empty, so ' +
        'there is no token overhead to budget.'
      : `Persona-section token budget: ~${String(tokens)} tokens (target ≤ ${String(thresholds.target)}, ` +
        `critical ≥ ${String(thresholds.critical)}).`;

  const fixHint =
    tokens <= thresholds.target
      ? 'Persona-section token budget is healthy.'
      : 'Trim persona.custom_notes or reduce the number of significant axis deltas — every ' +
        'persona token is paid on every turn.';

  return {
    id: 'token_efficiency',
    label: 'Token efficiency',
    score,
    evaluated: true,
    rationale,
    predictedFailureMode: 'cost_overrun',
    fixHint,
  };
}
