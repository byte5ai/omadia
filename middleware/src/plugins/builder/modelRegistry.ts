import type { BuilderModel, BuilderModelId } from './types.js';

/**
 * Mapping `'haiku' | 'sonnet' | 'opus'` → Anthropic model IDs + max-tokens
 * + display labels. Single source of truth for the builder dropdowns (both
 * codegen-model and preview-model).
 *
 * Model IDs follow the convention documented in the repo's global CLAUDE.md
 * (Claude 4.x line). Bumping a model here is safe: drafts persist the choice
 * as the literal slug (`'sonnet'`), so re-pointing it to the next Sonnet
 * revision needs no draft migration.
 */
const MODELS: Record<BuilderModelId, BuilderModel> = {
  haiku: {
    id: 'haiku',
    label: 'Haiku 4.5',
    anthropicModelId: 'claude-haiku-4-5-20251001',
    maxTokens: 8192,
    description: 'Schnell. Für kleine Spec-Patches und Slot-Regens.',
  },
  sonnet: {
    id: 'sonnet',
    label: 'Sonnet 4.6',
    anthropicModelId: 'claude-sonnet-4-6',
    maxTokens: 16_384,
    description: 'Ausbalanciert. Default für Full-Agent-Generation.',
  },
  opus: {
    id: 'opus',
    label: 'Opus 4.7',
    anthropicModelId: 'claude-opus-4-7',
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
