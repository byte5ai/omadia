import {
  listModels,
  resolveModelRef,
  type ModelInfo,
} from '@omadia/llm-provider';

import type { BuilderModel, BuilderModelId } from './types.js';

const SLUG_FALLBACK: Readonly<
  Record<'haiku' | 'sonnet' | 'opus', Omit<BuilderModel, 'description'>>
> = {
  haiku: {
    id: 'anthropic:claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5-20251001',
    modelClass: 'fast',
    vision: true,
    maxTokens: 8192,
    aliases: ['haiku'],
  },
  sonnet: {
    id: 'anthropic:claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    modelClass: 'balanced',
    vision: true,
    maxTokens: 16_384,
    aliases: ['sonnet'],
  },
  opus: {
    id: 'anthropic:claude-opus-4-8',
    label: 'Opus 4.8',
    provider: 'anthropic',
    modelId: 'claude-opus-4-8',
    modelClass: 'frontier',
    vision: true,
    maxTokens: 16_384,
    aliases: ['opus'],
  },
};

function describeClass(modelClass: string): string {
  switch (modelClass) {
    case 'fast':
      return 'Schnell. Für kleine Spec-Patches und Slot-Regens.';
    case 'frontier':
      return 'Am kräftigsten. Für komplexe Tools und schwierige Lints.';
    default:
      return 'Ausbalanciert. Solide Wahl für Full-Agent-Generation.';
  }
}

function infoToBuilderModel(info: ModelInfo): BuilderModel {
  return {
    id: info.id,
    label: info.label,
    provider: info.provider,
    modelId: info.modelId,
    modelClass: info.class,
    vision: info.vision,
    maxTokens: info.maxTokens,
    description: describeClass(info.class),
    aliases: info.aliases ?? [],
  };
}

function fallbackBuilderModel(
  slug: 'haiku' | 'sonnet' | 'opus',
): BuilderModel {
  const base = SLUG_FALLBACK[slug];
  return { ...base, description: describeClass(base.modelClass) };
}

function isSlug(ref: string): ref is 'haiku' | 'sonnet' | 'opus' {
  return ref === 'haiku' || ref === 'sonnet' || ref === 'opus';
}

export const DEFAULT_BUILDER_CODEGEN_MODEL: BuilderModelId = 'opus';
export const DEFAULT_BUILDER_PREVIEW_MODEL: BuilderModelId = 'sonnet';

export const DEFAULT_BUILDER_MODEL: BuilderModelId =
  DEFAULT_BUILDER_CODEGEN_MODEL;

export const BuilderModelRegistry = {
  list(): BuilderModel[] {
    const registered = listModels();
    if (registered.length > 0) return registered.map(infoToBuilderModel);
    return (['haiku', 'sonnet', 'opus'] as const).map(fallbackBuilderModel);
  },

  get(id: BuilderModelId): BuilderModel {
    const info = resolveModelRef(id);
    if (info !== undefined) return infoToBuilderModel(info);
    if (isSlug(id)) return fallbackBuilderModel(id);
    throw new Error(
      `Builder-Modell '${id}' ist in keinem konfigurierten LLM-Provider registriert. ` +
        `Wähle ein Modell aus der Modelle-Seite oder installiere den passenden Provider.`,
    );
  },

  resolve(id: BuilderModelId): { provider: string; modelId: string } {
    const m = this.get(id);
    return { provider: m.provider, modelId: m.modelId };
  },

  has(id: string): boolean {
    return resolveModelRef(id) !== undefined || isSlug(id);
  },

  default(): BuilderModelId {
    return DEFAULT_BUILDER_CODEGEN_MODEL;
  },
  defaultCodegen(): BuilderModelId {
    return DEFAULT_BUILDER_CODEGEN_MODEL;
  },
  defaultPreview(): BuilderModelId {
    return DEFAULT_BUILDER_PREVIEW_MODEL;
  },
};
