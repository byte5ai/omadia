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

// Marcel-Pre-Deploy-Wunsch 2026-05-06: Builder-Code-Gen-Default auf Opus 4.7
// (vorher Sonnet 4.6). Begründung: Builder-Generation ist der Mehr-Komplex-
// Pfad (Multi-Tool-Specs, Sub-Agent-Delegation, KG-Ingest); Opus liefert
// dort robustere First-Pass-Outputs als Sonnet, der TTFT-Overhead ist im
// interaktiven Builder-Workflow akzeptabel.
//
// Codegen vs. Preview bewusst entkoppelt: Preview-Runtime ist der
// Fast-Iterations-Pfad (User-Klick → Smoke-Run); Sonnet bleibt dort
// kosteneffizient. Bestehende Drafts behalten ihren persistierten Wert;
// nur neue Drafts starten mit den neuen Defaults.
export const DEFAULT_BUILDER_CODEGEN_MODEL: BuilderModelId = 'opus';
export const DEFAULT_BUILDER_PREVIEW_MODEL: BuilderModelId = 'sonnet';

/** @deprecated — use `DEFAULT_BUILDER_CODEGEN_MODEL` or
 *  `DEFAULT_BUILDER_PREVIEW_MODEL` explizit. Beibehalten, weil
 *  `normalizeModel()` in draftStore.ts die Konstante als generischen
 *  Unknown-Value-Fallback nutzt; ein zusammenfassender Default ist dort
 *  bewusst grob (codegen-Default ist der „erwartete moderne" Wert). */
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
  /** Default model for new drafts' code-generation pass (Opus 4.7 ab
   *  2026-05-06). */
  defaultCodegen(): BuilderModelId {
    return DEFAULT_BUILDER_CODEGEN_MODEL;
  },
  /** Default model for new drafts' preview-runtime smoke (Sonnet 4.6 —
   *  cost-efficient für schnelle Iterationen). */
  defaultPreview(): BuilderModelId {
    return DEFAULT_BUILDER_PREVIEW_MODEL;
  },
};
