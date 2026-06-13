import { resolveModelRef } from '@omadia/llm-provider';

import type { BuilderModel, BuilderModelId } from './types.js';

/**
 * Mapping `'haiku' | 'sonnet' | 'opus'` → Anthropic model IDs + max-tokens
 * + display labels. Single source of truth for the builder dropdowns (both
 * codegen-model and preview-model).
 *
 * The vendor model id is now sourced from the global `@omadia/llm-provider`
 * registry (the slugs are registered there as aliases), so bumping a model
 * happens in ONE place. The builder still owns its UI metadata (label,
 * description) and its per-slug output budget (`maxTokens`) — those are a
 * builder-workflow concern, distinct from the model's capability ceiling.
 * Drafts persist the choice as the literal slug (`'sonnet'`), so re-pointing
 * a slug to a new revision needs no draft migration.
 */
function vendorId(slug: BuilderModelId): string {
  const info = resolveModelRef(slug);
  if (info === undefined) {
    // A boot-time invariant: every builder slug must be a registered alias.
    throw new Error(
      `builder model slug '${slug}' is not registered in the global model registry`,
    );
  }
  // The field is `anthropicModelId` and flows into Anthropic-only client paths
  // (builderChat/builderPreview/index). Guard the slug→Anthropic contract here
  // so a future registry edit can never route a non-Anthropic id into the
  // Anthropic SDK — fail fast at boot instead.
  if (info.provider !== 'anthropic') {
    throw new Error(
      `builder model slug '${slug}' resolved to non-Anthropic provider '${info.provider}'; builder model ids must be Anthropic`,
    );
  }
  return info.modelId;
}

const MODELS: Record<BuilderModelId, BuilderModel> = {
  haiku: {
    id: 'haiku',
    label: 'Haiku 4.5',
    anthropicModelId: vendorId('haiku'),
    maxTokens: 8192,
    description: 'Schnell. Für kleine Spec-Patches und Slot-Regens.',
  },
  sonnet: {
    id: 'sonnet',
    label: 'Sonnet 4.6',
    anthropicModelId: vendorId('sonnet'),
    maxTokens: 16_384,
    description: 'Ausbalanciert. Default für Full-Agent-Generation.',
  },
  opus: {
    id: 'opus',
    label: 'Opus 4.8',
    anthropicModelId: vendorId('opus'),
    maxTokens: 16_384,
    description: 'Am kräftigsten. Für komplexe Tools und schwierige Lints.',
  },
};

// John pre-deploy request 2026-05-06: builder code-gen default switched to
// Opus 4.7 (previously Sonnet 4.6). Rationale: builder generation is the
// higher-complexity path (multi-tool specs, sub-agent delegation, KG ingest);
// Opus delivers more robust first-pass outputs than Sonnet, and the TTFT
// overhead is acceptable in the interactive builder workflow.
//
// Codegen vs. preview deliberately decoupled: preview-runtime is the
// fast-iteration path (user click → smoke run); Sonnet stays cost-efficient
// there. Existing drafts keep their persisted value; only new drafts start
// with the new defaults.
export const DEFAULT_BUILDER_CODEGEN_MODEL: BuilderModelId = 'opus';
export const DEFAULT_BUILDER_PREVIEW_MODEL: BuilderModelId = 'sonnet';

/** @deprecated — use `DEFAULT_BUILDER_CODEGEN_MODEL` or
 *  `DEFAULT_BUILDER_PREVIEW_MODEL` explicitly. Kept around because
 *  `normalizeModel()` in draftStore.ts uses this constant as a generic
 *  unknown-value fallback; a single summary default is intentionally coarse
 *  there (codegen default is the "expected modern" value). */
export const DEFAULT_BUILDER_MODEL: BuilderModelId =
  DEFAULT_BUILDER_CODEGEN_MODEL;

export const BuilderModelRegistry = {
  list(): BuilderModel[] {
    return Object.values(MODELS);
  },

  get(id: BuilderModelId): BuilderModel {
    return MODELS[id];
  },

  has(id: string): id is BuilderModelId {
    return id === 'haiku' || id === 'sonnet' || id === 'opus';
  },

  /** @deprecated — use `defaultCodegen()` or `defaultPreview()` explicitly. */
  default(): BuilderModelId {
    return DEFAULT_BUILDER_CODEGEN_MODEL;
  },
  /** Default model for new drafts' code-generation pass (Opus 4.7 since
   *  2026-05-06). */
  defaultCodegen(): BuilderModelId {
    return DEFAULT_BUILDER_CODEGEN_MODEL;
  },
  /** Default model for new drafts' preview-runtime smoke (Sonnet 4.6 —
   *  cost-efficient for fast iterations). */
  defaultPreview(): BuilderModelId {
    return DEFAULT_BUILDER_PREVIEW_MODEL;
  },
};
