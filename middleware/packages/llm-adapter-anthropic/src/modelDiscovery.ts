/**
 * Read-only discovery of the models and capabilities exposed by Anthropic's
 * Models API. This does not provide a `class` tier, `aliases`, an
 * `effortDefault`, or pricing: those fields have no API source and remain
 * human-curated in `src/platform/builtinLlmProviders.ts` and
 * `packages/harness-usage-telemetry/src/pricing.ts`.
 *
 * This primitive is not yet wired into the model registry or admin UI. Doing
 * so is a deliberate follow-up that needs a design decision for reconciling
 * curated fields with live-fetched fields, and must cover the other providers
 * rather than Anthropic alone.
 */
import type Anthropic from '@anthropic-ai/sdk';

export interface AnthropicModelCapabilities {
  readonly modelId: string;
  readonly label: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly vision: boolean;
  /** Effort levels the vendor documents for this model, INTERSECTED with
   *  omadia's own supported vocabulary (never includes 'max' — see
   *  anthropicProvider.ts's output_config.effort comment: omadia deliberately
   *  never sends 'max'). Empty array if the model has no effort capability
   *  (e.g. Haiku, which uses budget_tokens instead). */
  readonly effortLevels: ReadonlyArray<'low' | 'medium' | 'high' | 'xhigh'>;
}

type AnthropicModelRecord = {
  readonly id: string;
  readonly display_name: string;
  readonly max_input_tokens: unknown;
  readonly max_tokens: unknown;
  readonly capabilities?: unknown;
};

type UnknownRecord = Record<string, unknown>;

/** omadia's own effort vocabulary — deliberately excludes the vendor's `max`.
 *  Mirrors `EFFORT_LEVELS` in `@omadia/llm-provider-api`; kept local so this
 *  discovery primitive stays free of a runtime dependency on that package.
 *  If `EFFORT_LEVELS` ever gains a level, add it here too. */
const OMADIA_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null
    ? (value as UnknownRecord)
    : undefined;
}

function requireFiniteNumber(
  modelId: string,
  fieldName: 'max_input_tokens' | 'max_tokens',
  value: unknown,
): number {
  // Fail fast instead of allowing malformed vendor data (especially NaN) into
  // callers that reasonably treat discovery results as valid numeric limits.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `Anthropic model "${modelId}" returned invalid ${fieldName}: expected a finite number`,
    );
  }
  return value;
}

function mapAnthropicModel(
  model: AnthropicModelRecord,
): AnthropicModelCapabilities {
  const capabilities = asRecord(model.capabilities);
  const imageInput = asRecord(capabilities?.['image_input']);
  const effort = asRecord(capabilities?.['effort']);

  return {
    modelId: model.id,
    label: model.display_name,
    contextWindow: requireFiniteNumber(
      model.id,
      'max_input_tokens',
      model.max_input_tokens,
    ),
    maxTokens: requireFiniteNumber(model.id, 'max_tokens', model.max_tokens),
    vision: imageInput?.['supported'] === true,
    effortLevels: OMADIA_EFFORT_LEVELS.filter(
      (level) => asRecord(effort?.[level])?.['supported'] === true,
    ),
  };
}

export async function listAnthropicModels(
  client: Anthropic,
): Promise<AnthropicModelCapabilities[]> {
  const models: AnthropicModelCapabilities[] = [];
  for await (const model of await client.models.list()) {
    models.push(mapAnthropicModel(model));
  }
  return models;
}

export async function getAnthropicModel(
  client: Anthropic,
  modelId: string,
): Promise<AnthropicModelCapabilities> {
  return mapAnthropicModel(await client.models.retrieve(modelId));
}
