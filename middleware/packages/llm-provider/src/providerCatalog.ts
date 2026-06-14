/**
 * LLM provider catalog (provider-plugin seam).
 *
 * A kernel-owned registry of provider descriptors contributed by plugins. The
 * kernel populates it at manifest-load (before any plugin activates) from each
 * plugin's `llm_provider` manifest block, then publishes it as a service so the
 * orchestrator can resolve a plugin-contributed provider at its own activation
 * regardless of load order.
 *
 * Registering a provider also registers its models into the model-registry
 * overlay (so admin/class/role resolution sees them); unregistering cleans both
 * up. Only the OpenAI-compatible wire format is supported today — that is what
 * lets a declarative descriptor (no plugin code) drive the existing OpenAI
 * adapter via a baseURL + quirk flags.
 */
import { registerExternalModels, type ModelInfo } from './modelRegistry.js';

/** Vendor deviations from plain OpenAI that the OpenAI adapter handles when set. */
export interface ProviderQuirks {
  /** Field carrying the output-token cap (MiniMax → `max_completion_tokens`). */
  readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Omit `tool_choice` / `parallel_tool_calls` (MiniMax doesn't accept them). */
  readonly dropToolChoice?: boolean;
  /** Throw on a non-zero in-body `base_resp.status_code` (MiniMax) even on 200. */
  readonly checkBaseResp?: boolean;
  /** Vendor-only request fields merged into every body (MiniMax `reasoning_split`). */
  readonly extraBody?: Record<string, unknown>;
}

/** A plugin-contributed provider. `wireFormat` is openai-compatible only for now. */
export interface LlmProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly wireFormat: 'openai-compatible';
  /** Default API base URL (e.g. `https://api.minimax.io/v1`). */
  readonly baseURL: string;
  /** Optional config key an operator can set to override `baseURL` per scope. */
  readonly baseUrlConfigKey?: string;
  readonly quirks?: ProviderQuirks;
  readonly models: ReadonlyArray<ModelInfo>;
}

export class LlmProviderCatalog {
  private readonly entries = new Map<
    string,
    { desc: LlmProviderDescriptor; disposeModels: () => void }
  >();

  /** Register (or idempotently replace) a provider and its models. Throws if the
   *  models violate a registry invariant (collision with core/other ids etc.). */
  register(desc: LlmProviderDescriptor): void {
    const existing = this.entries.get(desc.id);
    if (existing !== undefined) existing.disposeModels();
    const disposeModels = registerExternalModels(desc.models);
    this.entries.set(desc.id, { desc, disposeModels });
  }

  get(id: string): LlmProviderDescriptor | undefined {
    return this.entries.get(id)?.desc;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  list(): ReadonlyArray<LlmProviderDescriptor> {
    return [...this.entries.values()].map((e) => e.desc);
  }

  unregister(id: string): void {
    const e = this.entries.get(id);
    if (e === undefined) return;
    e.disposeModels();
    this.entries.delete(id);
  }

  clear(): void {
    for (const e of this.entries.values()) e.disposeModels();
    this.entries.clear();
  }
}
