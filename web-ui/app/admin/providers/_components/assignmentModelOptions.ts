import type { AdminProviderModel, ModelClass } from '../../../_lib/api';

/**
 * Option model for the per-agent model `<select>` on /admin/providers (#1083).
 *
 * A stored model is not always one of the provider's concrete `modelId`s: the
 * platform default is a class ref (`class:frontier`), and an operator may have
 * stored a legacy alias (`opus`), a qualified id or an id discovery no longer
 * lists. A controlled `<select>` whose value matches no option silently shows
 * option 0, i.e. names a model the agent is not using. This helper guarantees
 * the stored value always has its own option, and offers the model classes as
 * first-class choices labelled with what they currently resolve to.
 *
 * Pure (no React, no i18n) so the rules are unit-testable; the component turns
 * `cls` / `target` into localized labels.
 */

/** Same order as the registry's class fallback (`CLASS_FALLBACK_ORDER`). */
export const MODEL_CLASS_ORDER: readonly ModelClass[] = ['frontier', 'balanced', 'fast'];

const CLASS_REF = /^class:(fast|balanced|frontier)$/;

/** `class:frontier` / `class:balanced` / `class:fast` — a model class ref. */
export function isClassRef(ref: string | null | undefined): ref is `class:${ModelClass}` {
  return typeof ref === 'string' && CLASS_REF.test(ref);
}

export interface ClassOption {
  /** The value stored when picked: `class:<cls>`. */
  readonly value: `class:${ModelClass}`;
  readonly cls: ModelClass;
  /** Display label of the model this class resolves to; `undefined` when the
   *  server did not say (older middleware, or nothing resolvable). */
  readonly target?: string;
}

export interface ModelOption {
  readonly value: string;
  readonly label: string;
}

export interface ModelSelect {
  /** The `<select>` value — always the value of one rendered option. */
  readonly value: string;
  /** No model stored: render the "pick a model" placeholder (value `''`). */
  readonly placeholder: boolean;
  readonly classOptions: readonly ClassOption[];
  readonly modelOptions: readonly ModelOption[];
  /** A stored non-class value that matches no listed `modelId` (alias,
   *  qualified id, custom id, dropped id). Rendered selected, never hidden. */
  readonly extraOption?: ModelOption;
}

export interface ModelSelectInput {
  readonly stored: string | null;
  /** Server-computed concrete model the stored ref resolves to. */
  readonly resolvedModel?: string | null;
  readonly models: readonly AdminProviderModel[];
  /** Server-computed class → modelId map for the selected provider. */
  readonly classDefaults?: Partial<Record<ModelClass, string>>;
}

function displayLabel(
  modelId: string | null | undefined,
  models: readonly AdminProviderModel[],
): string | undefined {
  if (modelId === null || modelId === undefined || modelId === '') return undefined;
  return models.find((m) => m.modelId === modelId)?.label ?? modelId;
}

export function buildModelSelect(input: ModelSelectInput): ModelSelect {
  const { stored, resolvedModel, models, classDefaults } = input;
  const storedClass = isClassRef(stored) ? stored.slice('class:'.length) as ModelClass : undefined;
  const served = new Set(models.map((m) => m.class));

  const classOptions: ClassOption[] = MODEL_CLASS_ORDER.filter(
    (cls) => served.has(cls) || cls === storedClass,
  ).map((cls) => {
    // The stored class shows what the runtime actually resolves (it covers the
    // nearest-class fallback); the others show the provider's class default.
    const targetId =
      cls === storedClass ? (resolvedModel ?? classDefaults?.[cls]) : classDefaults?.[cls];
    const target = displayLabel(targetId, models);
    return target === undefined
      ? { value: `class:${cls}`, cls }
      : { value: `class:${cls}`, cls, target };
  });

  const modelOptions: ModelOption[] = models.map((m) => ({ value: m.modelId, label: m.label }));

  if (stored === null) {
    return { value: '', placeholder: true, classOptions, modelOptions };
  }
  const matches = storedClass !== undefined || models.some((m) => m.modelId === stored);
  return matches
    ? { value: stored, placeholder: false, classOptions, modelOptions }
    : {
        value: stored,
        placeholder: false,
        classOptions,
        modelOptions,
        extraOption: { value: stored, label: stored },
      };
}
