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
/** Known slug→Anthropic vendor id, used as a fallback when the registry can't
 *  resolve the slug. Anthropic is now an installable provider PLUGIN that
 *  registers its models (with the opus/sonnet/haiku aliases) into the runtime
 *  overlay at boot — it is no longer a static core model. So the registry may
 *  not resolve these slugs at module-load time (this file is imported before the
 *  boot-time provider registration). The builder is Anthropic-by-design, so this
 *  stable map keeps it working before/without the anthropic plugin overlay
 *  instead of throwing at import (which would abort middleware startup). */
const SLUG_FALLBACK: Readonly<Record<BuilderModelId, string>> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
};

/** Resolve a builder slug to its Anthropic vendor id — registry first (so a
 *  model bump in the anthropic plugin flows through), then the stable fallback.
 *  Resolved LAZILY (per get/list call), never at module load, and never throws. */
function vendorId(slug: BuilderModelId): string {
  const info = resolveModelRef(slug);
  if (info !== undefined && info.provider === 'anthropic') return info.modelId;
  return SLUG_FALLBACK[slug];
}

/** UI metadata per slug (label/maxTokens/description) — a builder-workflow
 *  concern, distinct from the model's capability ceiling. The Anthropic vendor
 *  id is attached lazily by `builderModel()` so there is no load-time registry
 *  dependency. */
const MODEL_META: Readonly<
  Record<BuilderModelId, Omit<BuilderModel, 'anthropicModelId'>>
> = {
  haiku: {
    id: 'haiku',
    label: 'Haiku 4.5',
    maxTokens: 8192,
    description: 'Schnell. Für kleine Spec-Patches und Slot-Regens.',
  },
  sonnet: {
    id: 'sonnet',
    label: 'Sonnet 4.6',
    maxTokens: 16_384,
    description: 'Ausbalanciert. Default für Full-Agent-Generation.',
  },
  opus: {
    id: 'opus',
    label: 'Opus 4.8',
    maxTokens: 16_384,
    description: 'Am kräftigsten. Für komplexe Tools und schwierige Lints.',
  },
};

function builderModel(id: BuilderModelId): BuilderModel {
  return { ...MODEL_META[id], anthropicModelId: vendorId(id) };
}

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
    return (Object.keys(MODEL_META) as BuilderModelId[]).map(builderModel);
  },

  get(id: BuilderModelId): BuilderModel {
    return builderModel(id);
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
