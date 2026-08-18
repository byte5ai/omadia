/**
 * Transcription provider catalog (provider-plugin seam) — the transcription
 * twin of `LlmProviderCatalog`. A kernel-owned registry of descriptors
 * contributed by plugins' `transcription_provider` manifest blocks; the admin
 * transcription-provider route reads it to list providers, their models and
 * their data-protection policy.
 *
 * Two deliberate differences from the LLM catalog:
 *   - Entries carry the OWNING PLUGIN ID. Transcription keys live at `api_key`
 *     in the adapter plugin's own vault scope (the embedding-adapter
 *     precedent), not at a `provider:<id>/api_key` key in shared consumer
 *     scopes — so the route needs the scope, and selection (activate/
 *     deactivate) needs the plugin.
 *   - No model-registry overlay: transcription models are not LLM models and
 *     have no class/role resolution. The models live only on the descriptor.
 */
import type { TranscriptionProviderDescriptor } from './transcriptionProviderManifest.js';

export interface TranscriptionProviderCatalogEntry {
  readonly descriptor: TranscriptionProviderDescriptor;
  /** The plugin that contributed this provider — its vault scope holds the
   *  `api_key`, and activating/deactivating it is what selection means. */
  readonly pluginId: string;
}

export class TranscriptionProviderCatalog {
  private readonly entries = new Map<string, TranscriptionProviderCatalogEntry>();

  /** Register (or idempotently replace) a provider. */
  register(descriptor: TranscriptionProviderDescriptor, pluginId: string): void {
    this.entries.set(descriptor.id, { descriptor, pluginId });
  }

  get(id: string): TranscriptionProviderCatalogEntry | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  list(): ReadonlyArray<TranscriptionProviderCatalogEntry> {
    return [...this.entries.values()];
  }

  unregister(id: string): void {
    this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }
}
