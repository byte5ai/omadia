/**
 * Multi-family persona baseline profiles (data asset).
 *
 * Each model family ships a `BaseProfile` describing how the model
 * behaves along the 12 persona dimensions *before* omadia configures
 * anything. The compile algorithm (kemia + omadia's `personaDelta`)
 * uses this as the reference point: only deltas relative to the base
 * are emitted as instructions.
 *
 * Issue #58 ports the kemia data set 1:1 (`byte5ai/kemia@main:src/lib/base-personas.ts`)
 * **without** touching omadia's `BuilderModelId`, the model picker, the
 * runtime routing, or any inference call. The registry is a data asset
 * prepared for future multi-provider expansion; today the runtime still
 * resolves only the three Claude families via `personaDelta.ts`.
 *
 * Key adaptation: kemia uses camelCase axis keys (`riskTolerance`),
 * omadia uses snake_case (`risk_tolerance`). The conversion is mechanical
 * and lives in this file's profile literals.
 *
 * @see Issue #58
 */

import type { PersonaAxes } from './builder/agentSpec.js';

/**
 * Confidence tier — how much kemia trusts a profile's numeric values.
 *
 *  • `qualitative-from-sources` — values inferred from official model
 *    docs (model spec, constitution, safety docs). Defensible per
 *    dimension, not an authoritative number.
 *  • `empirical` — values measured by kemia's probing benchmark.
 *  • `estimated` — initial educated guess pending empirical measurement.
 */
export type ProfileConfidence =
  | 'qualitative-from-sources'
  | 'empirical'
  | 'estimated';

/**
 * Stable family identifier, matches kemia's `ModelFamilyId` string union.
 * Kept as a string so the registry can grow without a TypeScript change
 * downstream — the runtime falls back to `unknown` for unrecognized ids.
 */
export type PersonaFamilyId =
  | 'anthropic-claude'
  | 'openai-gpt'
  | 'google-gemini'
  | 'meta-llama'
  | 'mistral'
  | 'alibaba-qwen'
  | 'deepseek'
  | 'moonshot-kimi'
  | 'zhipu-glm'
  | '01ai-yi'
  | 'google-gemma'
  | 'microsoft-phi'
  | 'unknown';

export interface BaseProfile {
  family: PersonaFamilyId;
  /** All 12 axes set — every profile is "complete" for delta math. */
  dimensions: Required<PersonaAxes>;
  confidence: ProfileConfidence;
  /** URLs to model spec, paper, constitution, or probing run id. */
  sources: string[];
  /** Quirks or constraints worth surfacing in UI tooltips. */
  notes?: string;
  /** Compliance hints (e.g. `cn-content-policy`). Free-form strings. */
  regulatoryConstraints?: string[];
  /** ISO date the profile was last updated. */
  updatedAt: string;
}

// ─── Tier A — Qualitative-from-sources ────────────────────────────────

const CLAUDE: BaseProfile = {
  family: 'anthropic-claude',
  dimensions: {
    formality: 35,
    directness: 65,
    warmth: 80,
    humor: 55,
    sarcasm: 15,
    conciseness: 45,
    proactivity: 70,
    autonomy: 50,
    risk_tolerance: 30,
    creativity: 65,
    drama: 35,
    philosophy: 65,
  },
  confidence: 'qualitative-from-sources',
  sources: [
    'https://www.anthropic.com/news/claudes-constitution',
    'https://docs.anthropic.com/en/release-notes/system-prompts',
    'https://arxiv.org/abs/2212.08073',
  ],
  notes:
    "Constitutional AI training resists overrides on core ethical traits. Pushing warmth or directness extremely low fights the model.",
  updatedAt: '2026-04-26',
};

const GPT: BaseProfile = {
  family: 'openai-gpt',
  dimensions: {
    formality: 50,
    directness: 70,
    warmth: 55,
    humor: 45,
    sarcasm: 10,
    conciseness: 55,
    proactivity: 60,
    autonomy: 55,
    risk_tolerance: 40,
    creativity: 55,
    drama: 30,
    philosophy: 50,
  },
  confidence: 'qualitative-from-sources',
  sources: [
    'https://model-spec.openai.com/',
    'https://platform.openai.com/docs/guides/text-generation',
  ],
  notes:
    'Model Spec is highly explicit. Behavior is consistent and strongly steerable, but core honesty/safety traits are non-negotiable.',
  updatedAt: '2026-04-26',
};

const GEMINI: BaseProfile = {
  family: 'google-gemini',
  dimensions: {
    formality: 50,
    directness: 60,
    warmth: 60,
    humor: 40,
    sarcasm: 10,
    conciseness: 50,
    proactivity: 55,
    autonomy: 45,
    risk_tolerance: 25,
    creativity: 60,
    drama: 35,
    philosophy: 55,
  },
  confidence: 'qualitative-from-sources',
  sources: [
    'https://ai.google.dev/gemini-api/docs/safety-guidance',
    'https://ai.google.dev/gemini-api/docs/safety-settings',
  ],
  notes:
    "Safety classifiers are configurable via API but constitutional traits aren't. Lowest risk tolerance among Tier A; expect refusals on edge cases other models would handle.",
  updatedAt: '2026-04-26',
};

// ─── Tier B — Estimated, awaiting probing benchmark ───────────────────

const NEUTRAL_TIER_B: Required<PersonaAxes> = {
  formality: 50,
  directness: 55,
  warmth: 50,
  humor: 40,
  sarcasm: 10,
  conciseness: 50,
  proactivity: 50,
  autonomy: 50,
  risk_tolerance: 50,
  creativity: 50,
  drama: 40,
  philosophy: 45,
};

const LLAMA: BaseProfile = {
  family: 'meta-llama',
  dimensions: { ...NEUTRAL_TIER_B, directness: 60, risk_tolerance: 50 },
  confidence: 'estimated',
  sources: ['https://www.llama.com/responsible-use-guide/'],
  notes:
    'Estimated; awaits empirical probing. Llama is more shapeable than Tier A — most dimensions respond cleanly to system-prompt instruction.',
  updatedAt: '2026-04-26',
};

const MISTRAL: BaseProfile = {
  family: 'mistral',
  dimensions: { ...NEUTRAL_TIER_B, conciseness: 60, directness: 60 },
  confidence: 'estimated',
  sources: ['https://docs.mistral.ai/'],
  notes:
    'Estimated; awaits empirical probing. Mistral models are notably terse and direct by default.',
  updatedAt: '2026-04-26',
};

const QWEN: BaseProfile = {
  family: 'alibaba-qwen',
  dimensions: { ...NEUTRAL_TIER_B, formality: 55 },
  confidence: 'estimated',
  sources: ['https://qwen.readthedocs.io/'],
  notes:
    'Estimated; awaits empirical probing. Subject to CN content regulations on politically sensitive topics — orthogonal to persona, not configurable via omadia.',
  regulatoryConstraints: ['cn-content-policy'],
  updatedAt: '2026-04-26',
};

const DEEPSEEK: BaseProfile = {
  family: 'deepseek',
  dimensions: { ...NEUTRAL_TIER_B, philosophy: 55, conciseness: 55 },
  confidence: 'estimated',
  sources: [
    'https://github.com/deepseek-ai/DeepSeek-V3',
    'https://github.com/deepseek-ai/DeepSeek-R1',
  ],
  notes:
    'Estimated; awaits empirical probing. R1 reasoning traces are visible by default. Subject to CN content regulations.',
  regulatoryConstraints: ['cn-content-policy'],
  updatedAt: '2026-04-26',
};

const KIMI: BaseProfile = {
  family: 'moonshot-kimi',
  dimensions: { ...NEUTRAL_TIER_B, formality: 55, warmth: 55 },
  confidence: 'estimated',
  sources: ['https://platform.moonshot.ai/docs/'],
  notes:
    'Estimated; awaits empirical probing. Long context strength. Subject to CN content regulations.',
  regulatoryConstraints: ['cn-content-policy'],
  updatedAt: '2026-04-26',
};

const GLM: BaseProfile = {
  family: 'zhipu-glm',
  dimensions: { ...NEUTRAL_TIER_B },
  confidence: 'estimated',
  sources: ['https://github.com/THUDM/GLM-4'],
  notes:
    'Estimated; awaits empirical probing. Subject to CN content regulations.',
  regulatoryConstraints: ['cn-content-policy'],
  updatedAt: '2026-04-26',
};

const YI: BaseProfile = {
  family: '01ai-yi',
  dimensions: { ...NEUTRAL_TIER_B },
  confidence: 'estimated',
  sources: ['https://github.com/01-ai/Yi'],
  notes:
    'Estimated; awaits empirical probing. Subject to CN content regulations.',
  regulatoryConstraints: ['cn-content-policy'],
  updatedAt: '2026-04-26',
};

const GEMMA: BaseProfile = {
  family: 'google-gemma',
  dimensions: { ...NEUTRAL_TIER_B, risk_tolerance: 35, warmth: 55 },
  confidence: 'estimated',
  sources: ['https://ai.google.dev/gemma/docs'],
  notes:
    'Estimated; awaits empirical probing. Inherits some Gemini safety priors — somewhat lower risk tolerance than peers.',
  updatedAt: '2026-04-26',
};

const PHI: BaseProfile = {
  family: 'microsoft-phi',
  dimensions: {
    ...NEUTRAL_TIER_B,
    formality: 55,
    risk_tolerance: 35,
    warmth: 45,
  },
  confidence: 'estimated',
  sources: [
    'https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/concepts/models-featured#microsoft',
  ],
  notes:
    'Estimated; awaits empirical probing. Trained to be corporate-safe — conservative defaults, lower risk tolerance.',
  updatedAt: '2026-04-26',
};

// ─── Fallback ─────────────────────────────────────────────────────────

const UNKNOWN: BaseProfile = {
  family: 'unknown',
  dimensions: {
    formality: 50,
    directness: 50,
    warmth: 50,
    humor: 50,
    sarcasm: 0,
    conciseness: 50,
    proactivity: 50,
    autonomy: 50,
    risk_tolerance: 50,
    creativity: 50,
    drama: 50,
    philosophy: 50,
  },
  confidence: 'estimated',
  sources: [],
  notes:
    "Unrecognized model. The persona compiler emits as if no base shaping exists. Output may be inconsistent — consider adding this model's family to basePersonas.ts.",
  updatedAt: '2026-04-26',
};

// ─── Registry ─────────────────────────────────────────────────────────

export const BASE_PROFILES: Readonly<Record<PersonaFamilyId, BaseProfile>> = {
  'anthropic-claude': CLAUDE,
  'openai-gpt': GPT,
  'google-gemini': GEMINI,
  'meta-llama': LLAMA,
  mistral: MISTRAL,
  'alibaba-qwen': QWEN,
  deepseek: DEEPSEEK,
  'moonshot-kimi': KIMI,
  'zhipu-glm': GLM,
  '01ai-yi': YI,
  'google-gemma': GEMMA,
  'microsoft-phi': PHI,
  unknown: UNKNOWN,
};

/**
 * Resolve a base profile by family id. Unrecognized strings fall back
 * to the `unknown` profile — kemia's chosen behavior, and the safe one
 * for a runtime that may receive a model id ahead of a profile entry.
 *
 * This function is the only public entry point — callers should never
 * index `BASE_PROFILES` directly with a `string` because TypeScript
 * cannot guarantee the key is one of the listed `PersonaFamilyId`s.
 */
export function getBaseProfile(family: string): BaseProfile {
  return BASE_PROFILES[family as PersonaFamilyId] ?? UNKNOWN;
}
