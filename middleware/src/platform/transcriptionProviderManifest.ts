/**
 * Parse + validate a plugin manifest's `transcription_provider` block into a
 * typed `TranscriptionProviderDescriptor` — the transcription twin of
 * `llmProviderManifest.ts`. Kept in the app so `@omadia/transcription-api`
 * stays free of manifest/YAML concerns (the capability contract knows nothing
 * of manifests, recordings, or operator UI).
 *
 * Throws on a malformed block so the caller can log + skip without registering
 * a half-formed provider. The `policy` block reuses the LLM seam's
 * `ProviderPolicy` shape — it drives the same AVV/EU disclosure banner on the
 * admin providers page.
 *
 * The tiny shape validators are deliberately duplicated from
 * `llmProviderManifest.ts` rather than shared: the two provider seams evolve
 * independently, and a shared helper module would couple their manifest
 * dialects for six lines of code.
 */
import type { ProviderPolicy } from '@omadia/llm-provider';

import type { TranscriptionProviderCatalog } from './transcriptionProviderCatalog.js';

/** The two capability surfaces a transcription model can serve
 *  (`TranscriptionService.transcribeFile` / `.transcribeStream`). A model
 *  whose manifest entry omits a surface is unreachable on that surface —
 *  that is how the batch-only main PR keeps the `transcribeStream` stub
 *  legally uncallable until the realtime follow-up PR declares `stream`. */
export type TranscriptionSurface = 'file' | 'stream';

export interface TranscriptionModelInfo {
  /** Global model id, by convention `<provider>:<modelId>`. */
  readonly id: string;
  /** Provider id prefix of `id` (derived, mirrors `ModelInfo.provider`). */
  readonly provider: string;
  /** The provider-side model name sent on the wire (e.g. `gpt-transcribe`). */
  readonly modelId: string;
  readonly label: string;
  /** Non-empty; declares which capability surfaces this model serves. */
  readonly surfaces: readonly TranscriptionSurface[];
}

export interface TranscriptionProviderDescriptor {
  readonly id: string;
  readonly label: string;
  /** From `default_base_url`; a per-install override is resolved by the
   *  caller via `baseUrlConfigKey` (same contract as the LLM seam). */
  readonly baseURL: string;
  readonly baseUrlConfigKey?: string;
  /** Operator-UI compliance hints (AVV/EU disclosure, keyless flag). */
  readonly policy?: ProviderPolicy;
  readonly models: readonly TranscriptionModelInfo[];
}

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

/** Parse the optional `policy` block. All fields optional; non-booleans are
 *  ignored so a typo can't flip a default (same rule as the LLM seam). */
function parsePolicy(raw: unknown): ProviderPolicy | undefined {
  if (raw === undefined) return undefined;
  const rec = asRecord(raw);
  return {
    ...(typeof rec['requires_avv_disclosure'] === 'boolean'
      ? { requiresAvvDisclosure: rec['requires_avv_disclosure'] }
      : {}),
    ...(typeof rec['eu_hosted'] === 'boolean'
      ? { euHosted: rec['eu_hosted'] }
      : {}),
    ...(typeof rec['requires_api_key'] === 'boolean'
      ? { requiresApiKey: rec['requires_api_key'] }
      : {}),
  };
}

function parseSurfaces(raw: unknown): TranscriptionSurface[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("'surfaces' must be a non-empty array");
  }
  return raw.map((s) => {
    if (s !== 'file' && s !== 'stream') {
      throw new Error(`surface '${String(s)}' must be 'file' or 'stream'`);
    }
    return s;
  });
}

function parseModel(raw: unknown): TranscriptionModelInfo {
  const rec = asRecord(raw);
  const id = reqString(rec, 'id');
  return {
    id,
    provider: id.split(':')[0] ?? '',
    modelId: reqString(rec, 'model_id'),
    label: reqString(rec, 'label'),
    surfaces: parseSurfaces(rec['surfaces']),
  };
}

/** Map a raw `transcription_provider` manifest block to a typed descriptor,
 *  or throw — the caller logs + skips. */
export function parseTranscriptionProviderManifestBlock(
  raw: unknown,
): TranscriptionProviderDescriptor {
  const rec = asRecord(raw);
  const modelsRaw = rec['models'];
  if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) {
    throw new Error("'models' must be a non-empty array");
  }
  const policy = parsePolicy(rec['policy']);
  const baseUrlConfigKey = optString(rec, 'base_url_config_key');
  return {
    id: reqString(rec, 'id'),
    label: reqString(rec, 'label'),
    baseURL: reqString(rec, 'default_base_url'),
    ...(baseUrlConfigKey !== undefined ? { baseUrlConfigKey } : {}),
    ...(policy !== undefined ? { policy } : {}),
    models: modelsRaw.map(parseModel),
  };
}

/** Read a plugin manifest's `transcription_provider` block and register the
 *  resulting provider into `catalog` under its owning plugin id. Resolves a
 *  per-install `baseURL` override from the plugin's own config scope when the
 *  descriptor declares a `base_url_config_key` (same contract as
 *  `registerPluginLlmProvider`). Returns the registered descriptor (with the
 *  resolved baseURL) so the caller can log it, or `undefined` when the
 *  manifest declares no provider. Throws on a MALFORMED block — the caller
 *  logs + skips.
 *
 *  Shared by the boot-time registration loop and the hot-install path
 *  (InstallService.onInstalled) so a provider plugin installed at runtime
 *  appears on the admin page WITHOUT a middleware restart. Idempotent:
 *  `catalog.register` replaces an existing same-id entry. */
export function registerPluginTranscriptionProvider(
  manifest: unknown,
  config: Record<string, unknown> | undefined,
  catalog: TranscriptionProviderCatalog,
  pluginId: string,
): TranscriptionProviderDescriptor | undefined {
  const block = (
    manifest as { transcription_provider?: unknown } | null | undefined
  )?.transcription_provider;
  if (block === undefined || block === null) return undefined;
  const descriptor = parseTranscriptionProviderManifestBlock(block);
  let baseURL = descriptor.baseURL;
  if (descriptor.baseUrlConfigKey !== undefined) {
    const override = (config ?? {})[descriptor.baseUrlConfigKey];
    if (typeof override === 'string' && override.trim().length > 0) {
      baseURL = override.trim();
    }
  }
  const resolved = { ...descriptor, baseURL };
  catalog.register(resolved, pluginId);
  return resolved;
}

/** Counterpart to {@link registerPluginTranscriptionProvider}: drop a plugin's
 *  contributed provider from `catalog`. Returns the unregistered provider id,
 *  or `undefined` when the manifest declares no provider OR the provider was
 *  not registered. Throws only on a malformed block (which never registered)
 *  — the caller ignores. */
export function unregisterPluginTranscriptionProvider(
  manifest: unknown,
  catalog: TranscriptionProviderCatalog,
): string | undefined {
  const block = (
    manifest as { transcription_provider?: unknown } | null | undefined
  )?.transcription_provider;
  if (block === undefined || block === null) return undefined;
  const { id } = parseTranscriptionProviderManifestBlock(block);
  if (!catalog.has(id)) return undefined;
  catalog.unregister(id);
  return id;
}
