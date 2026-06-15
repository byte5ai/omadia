/**
 * Parse + validate a plugin manifest's `llm_provider` block (provider-plugin
 * seam) into a typed `LlmProviderDescriptor`. Kept out of `@omadia/llm-provider`
 * so the model-registry package stays free of manifest/YAML concerns; the kernel
 * (index.ts) calls this at manifest-load and registers the result into the
 * `LlmProviderCatalog`.
 *
 * Throws on a malformed block so the caller can log + skip without registering a
 * half-formed provider. Model invariants (id === `<provider>:<modelId>`, unique
 * ids, one class-default per (provider,class)) are enforced downstream by
 * `registerExternalModels`; this layer only enforces shape + required fields.
 */
import type {
  LlmProviderCatalog,
  LlmProviderDescriptor,
  ModelInfo,
  ProviderQuirks,
} from '@omadia/llm-provider';

function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error('expected an object');
  }
  return v as Record<string, unknown>;
}

function reqString(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`'${key}' must be a non-empty string`);
  }
  return v;
}

function optString(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`'${key}' must be a string`);
  return v;
}

function reqNumber(rec: Record<string, unknown>, key: string): number {
  const v = rec[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`'${key}' must be a number`);
  }
  return v;
}

function reqBool(rec: Record<string, unknown>, key: string): boolean {
  const v = rec[key];
  if (typeof v !== 'boolean') throw new Error(`'${key}' must be a boolean`);
  return v;
}

const MODEL_CLASSES = new Set(['fast', 'balanced', 'frontier']);

function parseModel(raw: unknown): ModelInfo {
  const rec = asRecord(raw);
  const cls = reqString(rec, 'class');
  if (!MODEL_CLASSES.has(cls)) {
    throw new Error(`model class '${cls}' must be fast|balanced|frontier`);
  }
  const aliasesRaw = rec['aliases'];
  let aliases: string[] | undefined;
  if (aliasesRaw !== undefined) {
    if (!Array.isArray(aliasesRaw) || aliasesRaw.some((a) => typeof a !== 'string')) {
      throw new Error("'aliases' must be an array of strings");
    }
    aliases = aliasesRaw as string[];
  }
  return {
    id: reqString(rec, 'id'),
    provider: reqString(rec, 'id').split(':')[0] ?? '',
    modelId: reqString(rec, 'model_id'),
    label: reqString(rec, 'label'),
    class: cls as ModelInfo['class'],
    maxTokens: reqNumber(rec, 'max_tokens'),
    contextWindow: reqNumber(rec, 'context_window'),
    vision: reqBool(rec, 'vision'),
    ...(rec['class_default'] === true ? { classDefault: true } : {}),
    ...(aliases !== undefined ? { aliases } : {}),
  };
}

function parseQuirks(raw: unknown): ProviderQuirks | undefined {
  if (raw === undefined) return undefined;
  const rec = asRecord(raw);
  const maxTokensField = optString(rec, 'max_tokens_field');
  if (
    maxTokensField !== undefined &&
    maxTokensField !== 'max_tokens' &&
    maxTokensField !== 'max_completion_tokens'
  ) {
    throw new Error(
      "'quirks.max_tokens_field' must be 'max_tokens' or 'max_completion_tokens'",
    );
  }
  const extraBody = rec['extra_body'];
  if (extraBody !== undefined) asRecord(extraBody); // shape check only
  return {
    ...(maxTokensField !== undefined
      ? { maxTokensField: maxTokensField as 'max_tokens' | 'max_completion_tokens' }
      : {}),
    ...(rec['drop_tool_choice'] === true ? { dropToolChoice: true } : {}),
    ...(rec['check_base_resp'] === true ? { checkBaseResp: true } : {}),
    ...(extraBody !== undefined
      ? { extraBody: extraBody as Record<string, unknown> }
      : {}),
  };
}

/** Map a raw `llm_provider` manifest block to a typed descriptor, or throw. */
export function parseLlmProviderManifestBlock(
  raw: unknown,
): LlmProviderDescriptor {
  const rec = asRecord(raw);
  const wireFormat = reqString(rec, 'wire_format');
  if (wireFormat !== 'openai-compatible' && wireFormat !== 'anthropic') {
    throw new Error(
      `wire_format '${wireFormat}' unsupported — use 'openai-compatible' or 'anthropic'`,
    );
  }
  const modelsRaw = rec['models'];
  if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) {
    throw new Error("'models' must be a non-empty array");
  }
  // Quirks are openai-only; ignore any declared on an anthropic-wire provider.
  const quirks =
    wireFormat === 'openai-compatible' ? parseQuirks(rec['quirks']) : undefined;
  return {
    id: reqString(rec, 'id'),
    label: reqString(rec, 'label'),
    wireFormat,
    baseURL: reqString(rec, 'default_base_url'),
    ...(optString(rec, 'base_url_config_key') !== undefined
      ? { baseUrlConfigKey: optString(rec, 'base_url_config_key') }
      : {}),
    ...(quirks !== undefined ? { quirks } : {}),
    models: modelsRaw.map(parseModel),
  };
}

/** Read a plugin manifest's `llm_provider` block and register the resulting
 *  provider (and its models) into `catalog`. Resolves a per-install `baseURL`
 *  override from the plugin's own config scope when the descriptor declares a
 *  `base_url_config_key`. Returns the registered descriptor (with the resolved
 *  baseURL) so the caller can log it, or `undefined` when the manifest declares
 *  no provider. Throws on a MALFORMED block — the caller logs + skips.
 *
 *  Shared by the boot-time registration loop and the hot-install path
 *  (InstallService.onInstalled) so a provider plugin installed at runtime lands
 *  in the catalog + model registry — and thus the admin Providers page —
 *  WITHOUT a middleware restart. Idempotent: `catalog.register` replaces an
 *  existing same-id entry (disposing the old models). */
export function registerPluginLlmProvider(
  manifest: unknown,
  config: Record<string, unknown> | undefined,
  catalog: LlmProviderCatalog,
): LlmProviderDescriptor | undefined {
  const block = (manifest as { llm_provider?: unknown } | null | undefined)
    ?.llm_provider;
  if (block === undefined || block === null) return undefined;
  const descriptor = parseLlmProviderManifestBlock(block);
  let baseURL = descriptor.baseURL;
  if (descriptor.baseUrlConfigKey !== undefined) {
    const override = (config ?? {})[descriptor.baseUrlConfigKey];
    if (typeof override === 'string' && override.trim().length > 0) {
      baseURL = override.trim();
    }
  }
  const resolved = { ...descriptor, baseURL };
  catalog.register(resolved);
  return resolved;
}

/** Counterpart to {@link registerPluginLlmProvider}: drop a plugin's contributed
 *  provider (and its models) from `catalog`. Returns the unregistered provider
 *  id, or `undefined` when the manifest declares no provider OR the provider was
 *  not registered. Throws only on a malformed block (which never registered) —
 *  the caller ignores. */
export function unregisterPluginLlmProvider(
  manifest: unknown,
  catalog: LlmProviderCatalog,
): string | undefined {
  const block = (manifest as { llm_provider?: unknown } | null | undefined)
    ?.llm_provider;
  if (block === undefined || block === null) return undefined;
  const { id } = parseLlmProviderManifestBlock(block);
  if (!catalog.has(id)) return undefined;
  catalog.unregister(id);
  return id;
}
